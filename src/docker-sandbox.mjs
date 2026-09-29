import { pat, Sandboxes } from '@docker/sandboxes';

/**
 * Creates an authenticated Docker Sandboxes client using Personal Access Token (PAT).
 */
export function createDockerClient({ username, personalAccessToken } = {}) {
  const user = username || process.env.DOCKER_ID;
  const token = personalAccessToken || process.env.DOCKER_PAT;

  if (!user || !token) {
    throw new Error(
      'Docker credentials missing: DOCKER_ID and DOCKER_PAT environment variables are required'
    );
  }

  return new Sandboxes({
    auth: pat({
      username: user,
      personalAccessToken: token,
    }),
  });
}

/**
 * Launches a cloud sandbox with the specified kit and hardware profile.
 * Defaults to 'opencode' kit on 'large' (8 vCPU / 16 GiB) with 60-min server-side deletion timeout.
 */
export async function launchReviewSandbox(
  client,
  {
    kit = 'opencode',
    resources = 'large',
    timeoutMs = 60 * 60 * 1000,
    displayName = 'pr-reviewer',
  } = {}
) {
  const launchPromise = await client.kits.launch(kit, {
    displayName,
    resources,
    lifecycle: {
      timeoutMs,
      onTimeout: 'delete',
    },
  });

  const sandbox = await launchPromise.waitUntilRunning({ timeoutMs: 300_000 });
  return sandbox;
}

/**
 * Runs a command inside the sandbox.
 */
export async function runProcess(
  sandbox,
  args,
  { env = {}, workingDir, timeoutMs = 60_000, user } = {}
) {
  const result = await sandbox.processes.run(
    {
      args,
      env,
      workingDir,
      user,
    },
    { timeoutMs }
  );

  return {
    exitCode: result.exitCode,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    success: result.exitCode === 0,
    incomplete: Boolean(result.incomplete),
  };
}

/**
 * Reads a text file from the sandbox filesystem.
 */
export async function readSandboxFile(sandbox, filePath, { encoding = 'utf8' } = {}) {
  return await sandbox.files.read(filePath, { encoding });
}

/**
 * Writes content to a file in the sandbox filesystem.
 */
export async function writeSandboxFile(sandbox, filePath, content) {
  await sandbox.files.write(filePath, content);
}

/**
 * Verifies that expected tools (git, python3, opencode) are available in the sandbox.
 */
export async function verifySandboxReadiness(sandbox) {
  const checks = [
    { name: 'git', args: ['git', '--version'] },
    { name: 'python3', args: ['python3', '--version'] },
    { name: 'opencode', args: ['opencode', '--version'] },
  ];

  const report = {};
  for (const check of checks) {
    try {
      const res = await runProcess(sandbox, check.args, { timeoutMs: 30_000 });
      report[check.name] = {
        ok: res.success,
        output: (res.stdout || res.stderr).trim(),
      };
    } catch (err) {
      report[check.name] = {
        ok: false,
        error: err.message,
      };
    }
  }

  const allReady = Object.values(report).every(r => r.ok);
  return { allReady, details: report };
}

/**
 * Safely deletes the sandbox and shuts down client background timers.
 */
export async function cleanupSandbox(sandbox, client = null) {
  const errors = [];

  if (sandbox) {
    try {
      const deleting = await sandbox.delete({ force: true });
      if (deleting) {
        await deleting.waitUntilDeleted({ timeoutMs: 60_000 });
      }
    } catch (err) {
      errors.push(`Failed to delete sandbox: ${err.message}`);
    }
  }

  if (client) {
    try {
      await client.close();
    } catch (err) {
      errors.push(`Failed to close Docker client: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    console.warn('Sandbox cleanup warnings:', errors.join('; '));
  }
}
