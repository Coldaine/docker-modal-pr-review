import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createDockerClient,
  launchReviewSandbox,
  runProcess,
  readSandboxFile,
  writeSandboxFile,
  verifySandboxReadiness,
  cleanupSandbox,
} from './docker-sandbox.mjs';
import {
  getPRMetadata,
  checkAlreadyReviewed,
  safePublishReview,
} from './github.mjs';
import {
  buildSessionId,
  renderOpenCodeConfig,
  renderPrompt,
  validateModalEndpoint,
  SMOKE_PROMPT_PATH,
  REVIEW_PROMPT_PATH,
} from './modal.mjs';
import {
  validateReview,
  buildRunSummary,
  formatReviewComment,
} from './report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function parseCliArgs(argv) {
  const args = {
    pr: null,
    repo: process.env.GITHUB_REPOSITORY || 'MooseGooseConsulting/coldaine-codeOps',
    mode: 'review', // 'prepare-only' | 'tool-smoke' | 'review'
    publish: false,
    force: false,
    outputDir: path.resolve(process.cwd(), 'output'),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pr' && argv[i + 1]) {
      args.pr = argv[++i];
    } else if (arg === '--repo' && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (arg === '--mode' && argv[i + 1]) {
      args.mode = argv[++i];
    } else if (arg === '--publish') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.publish = next === 'true';
        i++;
      } else {
        args.publish = true;
      }
    } else if (arg === '--force') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.force = next === 'true';
        i++;
      } else {
        args.force = true;
      }
    } else if (arg === '--output-dir' && argv[i + 1]) {
      args.outputDir = path.resolve(argv[++i]);
    }
  }

  return args;
}

export async function executeController(options = {}) {
  const tStart = Date.now();
  const timings = {};
  const outputFiles = {};

  const {
    pr,
    repo: fullRepo = 'MooseGooseConsulting/coldaine-codeOps',
    mode = 'review',
    publish = false,
    force = false,
    outputDir = path.resolve(process.cwd(), 'output'),
    githubToken = process.env.GITHUB_TOKEN,
    dockerUsername = process.env.DOCKER_ID,
    dockerPat = process.env.DOCKER_PAT,
    modalProxyToken = process.env.MODAL_PROXY_TOKEN,
    modelBaseUrl = process.env.MODEL_BASE_URL || 'https://inference.us-west.modal.direct/v1',
    modelId = process.env.MODEL_ID || 'deepseek-v4-1-flash',
    modelContextTokens = Number(process.env.MODEL_CONTEXT_TOKENS || 131072),
    modelOutputTokens = Number(process.env.MODEL_OUTPUT_TOKENS || 16384),
  } = options;

  if (!pr) {
    throw new Error('Missing required argument: --pr <number>');
  }

  const [owner, repoName] = fullRepo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: '${fullRepo}'. Expected 'owner/repo'.`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n======================================================`);
  console.log(`🚀 Docker + Modal PR Reviewer Controller`);
  console.log(`   Repo:    ${fullRepo}`);
  console.log(`   PR:      #${pr}`);
  console.log(`   Mode:    ${mode}`);
  console.log(`   Publish: ${publish}`);
  console.log(`   Force:   ${force}`);
  console.log(`======================================================\n`);

  // 1. Resolve PR Metadata
  console.log(`🔍 [1/6] Resolving PR #${pr} metadata from GitHub...`);
  const prMeta = await getPRMetadata({
    owner,
    repo: repoName,
    prNumber: pr,
    token: githubToken,
  });
  console.log(`   Title:    "${prMeta.title}"`);
  console.log(`   Head SHA: ${prMeta.headSha} (${prMeta.headRef})`);
  console.log(`   Base SHA: ${prMeta.baseSha} (${prMeta.baseRef})`);

  // 2. Duplicate suppression check
  if (!force) {
    const alreadyDone = await checkAlreadyReviewed({
      owner,
      repo: repoName,
      prNumber: pr,
      headSha: prMeta.headSha,
      token: githubToken,
    });
    if (alreadyDone) {
      console.log(`⏭️  Review already completed and published for commit ${prMeta.headSha.slice(0, 8)}. Exiting (use --force to rerun).`);
      const summary = buildRunSummary({
        repo: fullRepo,
        pr,
        headSha: prMeta.headSha,
        result: 'skipped_duplicate',
      });
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
      return summary;
    }
  }

  let dockerClient = null;
  let sandbox = null;

  try {
    // 3. Launch Docker Cloud Sandbox
    console.log(`\n🐳 [2/6] Launching Docker Cloud Sandbox (large: 8 vCPU / 16 GiB)...`);
    const tSandboxStart = Date.now();
    dockerClient = createDockerClient({
      username: dockerUsername,
      personalAccessToken: dockerPat,
    });

    sandbox = await launchReviewSandbox(dockerClient, {
      kit: 'opencode',
      resources: 'large',
      displayName: `pr-review-${pr}-${prMeta.headSha.slice(0, 7)}`,
      timeoutMs: 60 * 60 * 1000,
    });
    timings.sandbox_start_seconds = (Date.now() - tSandboxStart) / 1000;
    console.log(`   Sandbox launched in ${timings.sandbox_start_seconds.toFixed(2)}s`);

    // Verify readiness
    const readiness = await verifySandboxReadiness(sandbox);
    console.log(`   Tool readiness:`, readiness.details);
    if (!readiness.allReady) {
      throw new Error(`Sandbox failed readiness check: ${JSON.stringify(readiness.details)}`);
    }

    // 4. Exact Checkout in Sandbox
    console.log(`\n📦 [3/6] Checking out exact PR commit inside sandbox...`);
    const tCheckout = Date.now();

    await runProcess(sandbox, ['mkdir', '-p', '/workspace/repo']);
    await runProcess(sandbox, ['git', 'init'], { workingDir: '/workspace/repo' });
    await runProcess(sandbox, ['git', 'remote', 'add', 'origin', prMeta.cloneUrl], { workingDir: '/workspace/repo' });
    
    // Fetch exact base and head commits without persisting credentials
    const fetchRes = await runProcess(
      sandbox,
      ['git', 'fetch', '--no-tags', 'origin', prMeta.baseSha, prMeta.headSha],
      { workingDir: '/workspace/repo', timeoutMs: 120_000 }
    );
    if (!fetchRes.success) {
      throw new Error(`Git fetch failed: ${fetchRes.stderr}`);
    }

    const checkoutRes = await runProcess(
      sandbox,
      ['git', 'checkout', '--detach', prMeta.headSha],
      { workingDir: '/workspace/repo' }
    );
    if (!checkoutRes.success) {
      throw new Error(`Git checkout failed: ${checkoutRes.stderr}`);
    }

    const mergeBaseRes = await runProcess(
      sandbox,
      ['git', 'merge-base', prMeta.baseSha, prMeta.headSha],
      { workingDir: '/workspace/repo' }
    );
    if (!mergeBaseRes.success) {
      throw new Error(`Git merge-base calculation failed: ${mergeBaseRes.stderr}`);
    }

    const mergeBase = mergeBaseRes.stdout.trim();
    timings.checkout_seconds = (Date.now() - tCheckout) / 1000;
    console.log(`   Checked out HEAD: ${prMeta.headSha.slice(0, 10)}`);
    console.log(`   Merge Base:       ${mergeBase.slice(0, 10)}`);
    console.log(`   Checkout took:    ${timings.checkout_seconds.toFixed(2)}s`);

    // Repository preparation command (optional)
    if (process.env.REVIEW_PREPARE_COMMAND) {
      console.log(`   Running prepare command: "${process.env.REVIEW_PREPARE_COMMAND}"`);
      const tPrep = Date.now();
      const prepRes = await runProcess(
        sandbox,
        ['bash', '-lc', process.env.REVIEW_PREPARE_COMMAND],
        { workingDir: '/workspace/repo', timeoutMs: 300_000 }
      );
      timings.prepare_seconds = (Date.now() - tPrep) / 1000;
      if (!prepRes.success) {
        console.warn(`   Prepare command failed (${prepRes.exitCode}):`, prepRes.stderr);
      }
    }

    // Stop if prepare-only mode
    if (mode === 'prepare-only') {
      timings.total_seconds = (Date.now() - tStart) / 1000;
      console.log(`\n✅ Prepare-only mode complete in ${timings.total_seconds.toFixed(2)}s`);
      const summary = buildRunSummary({
        repo: fullRepo,
        pr,
        headSha: prMeta.headSha,
        timings,
        result: 'prepare_only_success',
      });
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
      return summary;
    }

    // 5. Configure Modal & OpenCode
    console.log(`\n🧠 [4/6] Configuring Modal endpoint and OpenCode session affinity...`);
    const sessionId = buildSessionId(owner, repoName, pr, prMeta.headSha);
    console.log(`   Session ID: ${sessionId}`);

    const opencodeConfig = renderOpenCodeConfig({
      baseUrl: modelBaseUrl,
      modelId,
      contextTokens: modelContextTokens,
      outputTokens: modelOutputTokens,
      sessionId,
      proxyToken: modalProxyToken,
    });

    await writeSandboxFile(sandbox, '/workspace/repo/opencode.jsonc', opencodeConfig);

    // 6. Tool-Loop Smoke Test
    console.log(`\n🧪 Running deterministic tool-loop smoke test...`);
    const tSmoke = Date.now();
    const nonce = crypto.randomBytes(32).toString('hex');
    const expectedDigest = crypto.createHash('sha256').update(nonce).digest('hex');

    await writeSandboxFile(sandbox, '/workspace/nonce.txt', nonce);
    const smokePrompt = fs.readFileSync(SMOKE_PROMPT_PATH, 'utf8');

    const smokeRes = await runProcess(
      sandbox,
      [
        'opencode',
        'run',
        '--standalone',
        '--auto',
        '--format', 'json',
        '--model', `modal/${modelId.split('/').pop()}`,
        smokePrompt,
      ],
      { workingDir: '/workspace/repo', timeoutMs: 180_000 }
    );

    if (!smokeRes.success) {
      console.warn(`   Smoke test agent warning (${smokeRes.exitCode}):`, smokeRes.stderr);
    }

    let smokeJson = null;
    try {
      const rawSmoke = await readSandboxFile(sandbox, '/workspace/smoke-result.json');
      smokeJson = JSON.parse(rawSmoke);
    } catch (err) {
      throw new Error(`Smoke test failed: /workspace/smoke-result.json was not created or is invalid: ${err.message}`);
    }

    if (smokeJson.sha256 !== expectedDigest) {
      throw new Error(`Smoke test digest mismatch: expected ${expectedDigest}, received ${smokeJson.sha256}`);
    }

    timings.tool_smoke_seconds = (Date.now() - tSmoke) / 1000;
    console.log(`   ✅ Tool-loop smoke test PASSED in ${timings.tool_smoke_seconds.toFixed(2)}s`);

    if (mode === 'tool-smoke') {
      timings.total_seconds = (Date.now() - tStart) / 1000;
      console.log(`\n✅ Tool-smoke mode complete in ${timings.total_seconds.toFixed(2)}s`);
      const summary = buildRunSummary({
        repo: fullRepo,
        pr,
        headSha: prMeta.headSha,
        modalSessionId: sessionId,
        timings,
        result: 'tool_smoke_success',
      });
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
      return summary;
    }

    // 7. Full PR Review Execution
    console.log(`\n🤖 [5/6] Executing agent review with OpenCode...`);
    const tReview = Date.now();

    const reviewPrompt = renderPrompt(REVIEW_PROMPT_PATH, {
      PR_NUMBER: pr,
      HEAD_SHA: prMeta.headSha,
      BASE_SHA: prMeta.baseSha,
      MERGE_BASE: mergeBase,
    });

    const reviewRes = await runProcess(
      sandbox,
      [
        'opencode',
        'run',
        '--standalone',
        '--auto',
        '--format', 'json',
        '--model', `modal/${modelId.split('/').pop()}`,
        reviewPrompt,
      ],
      { workingDir: '/workspace/repo', timeoutMs: 30 * 60 * 1000 }
    );

    timings.review_seconds = (Date.now() - tReview) / 1000;
    console.log(`   Review agent execution completed in ${timings.review_seconds.toFixed(2)}s`);

    // Retrieve and validate review report
    let rawReview = null;
    try {
      rawReview = await readSandboxFile(sandbox, '/workspace/review.json');
    } catch (err) {
      throw new Error(`Review agent did not produce /workspace/review.json: ${err.message}\nAgent stderr: ${reviewRes.stderr}`);
    }

    const review = validateReview(rawReview, prMeta.headSha);
    console.log(`   Validated review contract: ${review.findings.length} findings, complete=${review.complete}`);

    fs.writeFileSync(path.join(outputDir, 'review.json'), JSON.stringify(review, null, 2));

    const commentBody = formatReviewComment(review, { model: modelId });
    fs.writeFileSync(path.join(outputDir, 'comment.md'), commentBody);

    // 8. Publish Review (if enabled)
    console.log(`\n📝 [6/6] Review Publication...`);
    let publishResult = { published: false, reason: 'disabled_by_config' };
    if (publish) {
      console.log(`   Publishing COMMENT review to PR #${pr}...`);
      publishResult = await safePublishReview({
        owner,
        repo: repoName,
        prNumber: pr,
        reviewedSha: prMeta.headSha,
        reviewBody: commentBody,
        token: githubToken,
      });
      console.log(`   Publish result:`, publishResult);
    } else {
      console.log(`   Publication disabled (publish=false). Review saved to output/comment.md`);
    }

    timings.total_seconds = (Date.now() - tStart) / 1000;
    const summary = buildRunSummary({
      repo: fullRepo,
      pr,
      headSha: prMeta.headSha,
      modalSessionId: sessionId,
      timings,
      findingsCount: review.findings.length,
      result: publishResult.published ? 'published' : 'completed_unfiltered',
    });

    fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));

    console.log(`\n======================================================`);
    console.log(`🎉 Review Pipeline Completed Successfully in ${timings.total_seconds.toFixed(2)}s`);
    console.log(`======================================================\n`);

    return summary;

  } finally {
    // 9. Cleanup
    console.log(`🧹 Cleaning up Docker sandbox...`);
    await cleanupSandbox(sandbox, dockerClient);
  }
}

// Run CLI directly if invoked from command line
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cliArgs = parseCliArgs(process.argv);
  executeController(cliArgs).catch((err) => {
    console.error(`\n❌ Controller failed:`, err);
    process.exit(1);
  });
}
