# Docker + Modal PR Reviewer — Stand-Up Plan

**Repository:** `MooseGooseConsulting/coldaine-codeOps`  
**Spike path:** `spikes/docker-modal-pr-review/`  
**Status:** implementation plan; not yet proven end-to-end

## Goal

Stand up:

```text
GitHub PR/manual trigger
  → controller
  → Docker Cloud Sandbox (8 vCPU / 16 GiB)
  → clone exact PR head + prepare repo
  → OpenCode
  → Modal inference
  → agent reads/searches/tests repo
  → structured review artifact
  → controller validates SHA/output
  → optional GitHub COMMENT review
  → delete Docker sandbox
```

The spike succeeds when one real `coldaine-codeOps` PR can be reviewed end-to-end, first without publication and then with a COMMENT review, with measured Docker/Modal cost and stale-review protection.

## Why this repo

`coldaine-codeOps` already owns the fleet PR reviewer, review kit, reviewer docs, fleet enrollment, publication/output contracts, and runner-control code. This is another reviewer execution backend, so the spike belongs here.

Do **not** start this inside `homelab-next` or `services/runner-controller/`. `homelab-next` should only become involved later if persistent cluster-side infrastructure is required. `services/runner-controller/` owns runner placement/capacity; this spike is not initially a GARM backend or general GitHub Actions runner.

## Spike layout

```text
spikes/docker-modal-pr-review/
├── README.md
├── PLAN.md
├── package.json
├── package-lock.json
├── src/
│   ├── controller.mjs
│   ├── docker-sandbox.mjs
│   ├── github.mjs
│   ├── modal.mjs
│   └── report.mjs
├── worker/
│   ├── review.py
│   ├── opencode.json.template
│   └── prompts/
│       ├── tool-smoke.md
│       └── pr-review.md
├── schema/
│   └── review.schema.json
└── tests/
    ├── controller.test.mjs
    ├── report.test.mjs
    └── test_worker.py
```

Temporary workflow:

```text
.github/workflows/docker-modal-review-spike.yml
```

Do not modify `fleet-pr-review.yml` until this produces useful reviews.

## Phase 0 — verify Modal billing path

First determine whether the specific $280 promotional balance pays Shared Endpoint usage.

1. Create/use a DeepSeek V4.1 Flash Shared Endpoint.
2. Send one tiny request.
3. Run:

```bash
modal billing report --for today
```

4. Determine which balance was debited.

Decision:

```text
if promotional credit pays Shared:
    use Shared for the spike
else:
    use Shared as the architectural baseline
    add Dedicated only to consume compute credit
```

Do not infer the answer from generic plan-credit language.

## Phase 1 — controller skeleton

The controller initially runs in GitHub Actions.

It owns:

```text
resolve PR metadata
validate config
create Docker sandbox
invoke worker phases
retrieve report/logs
verify PR head is still current
optionally publish review
delete Docker sandbox
```

It does **not** own LLM reasoning or the agent loop. OpenCode does.

## Phase 2 — Docker prepare-only test

GitHub secrets:

```text
DOCKER_ID
DOCKER_PAT
```

The PAT needs `sandbox:use`.

Launch the Docker `opencode` kit at:

```text
large = 8 vCPU / 16 GiB
```

Configure a 60-minute server-side deletion timeout as leak protection.

After launch, explicitly check for:

```text
git
python3
opencode
workspace directory
outbound HTTPS
```

### Checkout exact PR state

Resolve base/head SHA before sandbox work, then inside Docker:

```bash
git init /workspace/repo
cd /workspace/repo
git remote add origin <repo>
git fetch --no-tags origin <base-sha> <head-sha>
git checkout --detach <head-sha>
git merge-base <base-sha> <head-sha>
```

Do not persist the clone credential in `.git/config`.

### Repository prep

Support explicit optional commands:

```text
REVIEW_PREPARE_COMMAND
REVIEW_SMOKE_COMMAND
```

Do not invent a universal test command.

### Prepare-only acceptance criteria

- exact head SHA checked out;
- merge-base correct;
- repo prep works;
- evidence artifact retrieved;
- sandbox deleted;
- no model credential supplied;
- no inference request made.

## Phase 3 — Shared Modal inference

Preferred first path:

```text
OpenCode → Modal Shared Endpoint → DeepSeek V4.1 Flash
```

Use Modal/OpenCode's native integration if it supports the needed headers. Otherwise configure an OpenAI-compatible provider explicitly.

Expected base:

```text
https://inference.us-west.modal.direct/v1
```

Use the exact endpoint/model ID returned by Modal.

Never silently fall back to OpenRouter, Kilo, OpenAI, Anthropic, or another paid provider.

## Session affinity

Use one stable session ID for every model turn in a review:

```text
review:<owner>/<repo>:pr-<number>:<head-sha>
```

Send as:

```http
Modal-Session-Id: review:...
```

Verify that OpenCode actually preserves this header. If its native Modal provider cannot, use a custom provider config that can.

## Phase 4 — real tool-loop smoke test

A `/v1/models` success is not enough.

Before real review:

1. create a file with a random nonce;
2. do not include the nonce in the prompt;
3. ask OpenCode to read it;
4. ask it to execute Python/shell to calculate SHA-256;
5. ask it to write JSON with the result;
6. independently calculate SHA-256;
7. compare exact values.

Required proof:

```text
model
  → tool request
  → OpenCode executes inside Docker
  → tool result
  → model continues
  → verifiable file artifact
```

If this fails, stop.

## Phase 5 — PR review

Keep the initial prompt small because the repository is available to the agent.

Example:

```text
Review PR #<number> at HEAD <head-sha> against base <base-sha>.

Use git diff <merge-base>..HEAD.
Read relevant surrounding code, callers and tests.
Run targeted tests/reproductions when useful.

Report only actionable defects introduced by this PR.
Do not publish anything to GitHub.
Write the final result to /workspace/review.json.
```

Do not dump the whole repository into the prompt.

## Output contract

Start with:

```json
{
  "head_sha": "abcdef...",
  "complete": true,
  "summary": "What was reviewed",
  "findings": [
    {
      "severity": "P1",
      "title": "Short actionable title",
      "path": "src/example.py",
      "line": 42,
      "description": "Concrete failure mode",
      "evidence": "Code evidence or reproduction"
    }
  ],
  "tests": [
    {
      "command": "...",
      "result": "..."
    }
  ],
  "limitations": []
}
```

Reject:

```text
malformed JSON
wrong head SHA
complete=false
invalid finding structure
```

A failed/incomplete review must not become “no issues found.”

## Phase 6 — nonpublishing review

Run the entire path with:

```text
publish=false
```

Store:

```text
review.json
OpenCode trace
worker stdout/stderr
preparation log
run-summary.json
```

Evaluate review usefulness, false positives, tool usage, wall-clock time, token usage, cache behavior and cost.

Run several representative `coldaine-codeOps` PRs before fleet integration.

## Phase 7 — publication

Once review quality is acceptable:

```text
publish=true
```

Immediately before publication, fetch current PR metadata and compare current HEAD to the reviewed SHA.

```text
same SHA → publish
different SHA → discard stale review
```

Publish one GitHub `COMMENT` review initially.

Do not approve, request changes, merge, push code, or create recursive review triggers.

## Duplicate suppression

Reviewer identity should include:

```text
docker-modal
model ID
prompt/reviewer version
```

Deduplicate completed publications by:

```text
repo + PR + head SHA + reviewer identity
```

Allow explicit `force=true` for intentional reruns.

## Concurrency

For the spike:

```text
Docker review concurrency = 1
Modal Shared concurrency = Modal-managed
```

Do not solve fleet-scale scheduling first.

If Dedicated is later used:

```text
min_containers = 0
max_containers = 1
```

Remember that one Modal replica may itself consume multiple GPUs.

## Dedicated path

Only add this if the Shared-credit test gives a reason.

Keep the Docker/OpenCode/review contract unchanged and swap only:

```text
MODEL_BASE_URL
MODEL_ID
provider configuration
```

Deploy the Dedicated endpoint once. Do not create/delete the deployment per PR.

Persist:

```text
endpoint definition
managed model cache
serving image/cache
weight cache
```

Scale GPU replicas to zero between reviews.

Do not use `modal endpoint stop` as routine cleanup.

## Dedicated caching

If Modal's generated recipe is sufficient, use its managed cache.

For custom serving:

```text
download pinned model revision once
  → persistent Modal Volume/cache
  → serving app mounts cached weights
  → load weights into RAM/HBM on cold start
```

Do not add GPU-memory snapshots until ordinary cached cold-start behavior is measured.

## Model choice

Use **DeepSeek V4.1 Flash** for the spike.

Do not introduce a Qwen→DeepSeek escalation layer or generic model router during initial implementation. The goal is to test the reviewer we actually want.

Alternative models can be evaluated later against measured quality/cost data.

## Secrets and variables

Secrets:

```text
DOCKER_ID
DOCKER_PAT
MODAL_PROXY_TOKEN
```

Variables:

```text
MODAL_MODE=shared
MODEL_BASE_URL
MODEL_ID
MODEL_CONTEXT_TOKENS
MODEL_OUTPUT_TOKENS
REVIEW_PREPARE_COMMAND
REVIEW_SMOKE_COMMAND
```

The model process must not receive:

```text
Docker PAT
GitHub publication credential
Modal deployment/admin credential
```

## Observability

Every review should emit a machine-readable summary:

```json
{
  "repo": "MooseGooseConsulting/coldaine-codeOps",
  "pr": 123,
  "head_sha": "...",
  "reviewer_version": "...",
  "model": "...",
  "modal_mode": "shared",
  "modal_session_id": "...",
  "docker_sandbox_id": "...",
  "timings": {
    "sandbox_start_seconds": 0,
    "checkout_seconds": 0,
    "prepare_seconds": 0,
    "tool_smoke_seconds": 0,
    "review_seconds": 0,
    "total_seconds": 0
  },
  "usage": {
    "input_tokens": null,
    "cached_input_tokens": null,
    "output_tokens": null
  },
  "result": "success"
}
```

## Temporary workflow

`docker-modal-review-spike.yml` should initially be manual only:

```yaml
workflow_dispatch:
  inputs:
    pr:
      required: true
    mode:
      type: choice
      options:
        - prepare-only
        - tool-smoke
        - review
    publish:
      type: boolean
      default: false
    force:
      type: boolean
      default: false
```

Do not enable org-wide automatic triggers during the spike.

## First-run ladder

### A. Prepare only

```text
mode=prepare-only
publish=false
```

Proves Docker auth, launch, checkout, merge-base, prep, artifact retrieval and cleanup.

### B. Tool smoke

```text
mode=tool-smoke
publish=false
```

Proves OpenCode, Modal auth, model/tool schema, shell execution and multi-turn tool loop.

### C. Full review, no publication

```text
mode=review
publish=false
```

Proves agent review quality and output contract.

### D. Publish

```text
mode=review
publish=true
```

Proves stale-head protection and GitHub publication.

## Promotion after the spike

Once proven, remove the permanent implementation from `spikes/` and promote it into the existing reviewer platform.

Generic implementation:

```text
.github/actions/review-kit/modal-docker/
```

Permanent docs:

```text
docs/reviewers/modal-docker.md
```

Orchestration:

```text
.github/workflows/fleet-pr-review.yml
```

Fleet enrollment remains under:

```text
fleet/
```

Caller repositories stay thin; do not copy the implementation repo-by-repo.

## Do not do during the spike

- create a new repository for this experiment;
- put the implementation in `homelab-next`;
- turn Docker Cloud Sandboxes into a GARM backend yet;
- build a new webhook service;
- build a new agent framework;
- build a model router;
- implement multiple model tiers;
- add GPU snapshots before measuring;
- silently fall back to a different paid inference provider;
- enroll the whole fleet before `coldaine-codeOps` works;
- treat `/models` as proof of tool calling;
- give the model GitHub publication credentials.

## Exit criteria

- [ ] $280 Shared-credit behavior is known.
- [ ] Docker large sandbox launches unattended.
- [ ] Exact PR checkout works.
- [ ] Repository preparation works.
- [ ] Modal/OpenCode tool smoke test passes.
- [ ] `Modal-Session-Id` propagation is verified.
- [ ] At least three representative PRs complete nonpublishing reviews.
- [ ] Review usefulness has been inspected.
- [ ] Per-review token/cost and wall-clock data are recorded.
- [ ] Stale-head guard is tested.
- [ ] One real COMMENT review publishes successfully.
- [ ] Docker cleanup is verified on success and failure.
- [ ] Promotion path into `review-kit` is clear.

## Immediate next actions

1. Create `spikes/docker-modal-pr-review/`.
2. Put the research note and this plan there.
3. Add `docker-modal-review-spike.yml` with `workflow_dispatch` only.
4. Implement Docker `prepare-only`.
5. Run against a real `coldaine-codeOps` PR.
6. Send one tiny Shared DeepSeek request and inspect Modal billing.
7. Implement the Modal/OpenCode tool smoke test.
8. Run a nonpublishing real review.
9. Measure cost/latency/quality.
10. Publish only after the result is useful.

## Key references

Docker:
- https://docs.docker.com/ai/sandboxes-api/
- https://docs.docker.com/ai/sandboxes-api/get-started/
- https://docs.docker.com/ai/sandboxes-api/authentication/
- https://docs.docker.com/ai/sandboxes-api/limits/
- https://docs.docker.com/ai/sandboxes-api/concepts/
- https://docs.docker.com/ai/sandboxes-api/cookbook/add-tools-with-kits/
- https://docs.docker.com/ai/sandboxes-api/cookbook/keep-a-cloud-sandbox-running/

Modal:
- https://modal.com/docs/guide/shared-endpoints
- https://modal.com/docs/guide/dedicated-endpoints
- https://modal.com/docs/guide/endpoint-integrations
- https://modal.com/docs/guide/model-weights
- https://modal.com/docs/guide/high-performance-llm-inference
- https://modal.com/docs/guide/servers
- https://modal.com/docs/cli/latest/billing
- https://modal.com/library/deepseek/deepseek-v4-1-flash

OpenCode:
- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/config/

GitHub:
- https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
