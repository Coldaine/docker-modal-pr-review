# Docker + Modal Agentic PR Reviewer Spike

## Current inference backend

Shared DeepSeek V4.1 Flash is live and directly verified (HTTP 200, `PONG`, 3 output tokens). See [SHARED-INFERENCE.md](SHARED-INFERENCE.md) for the active URL, bounded smoke command, workspace usage-limit change and credit eligibility boundaries. Repository default changes are pending merge; the live Shared endpoint already works. Older Dedicated endpoint operations below are historical.


An agentic GitHub Pull Request reviewer combining **Docker Cloud Sandboxes** (isolated microVM execution environments) and **Modal** (DeepSeek V4.1 Flash inference via Shared Endpoints) using **OpenCode**.

Repository: [Coldaine/docker-modal-pr-review](https://github.com/Coldaine/docker-modal-pr-review)

---

## Architecture

```text
GitHub Actions / Local CLI
  → Controller (src/controller.mjs)
  → Docker Cloud Sandbox (large: 8 vCPU / 16 GiB, opencode kit)
  → Git checkout exact PR HEAD commit (detached, credential-safe)
  → Optional repository preparation (REVIEW_PREPARE_COMMAND)
  → OpenCode agent loop in microVM
  → Modal Shared Endpoint (DeepSeek V4.1 Flash with Modal-Session-Id affinity)
  → Structured review report (/workspace/review.json)
  → Controller validates report against JSON Schema & commit SHA
  → Safe publication (COMMENT review with stale-HEAD guard)
  → Sandbox deletion & telemetry recording
```

---

## Directory Structure

```text
.
├── .github/
│   └── workflows/
│       └── docker-modal-review-spike.yml   # Manual workflow_dispatch action
├── schema/
│   └── review.schema.json                  # Output JSON Schema (Draft 2020-12)
├── src/
│   ├── controller.mjs                      # Main orchestrator & CLI entrypoint
│   ├── docker-sandbox.mjs                  # Docker Sandboxes SDK lifecycle manager
│   ├── github.mjs                          # PR metadata, stale-guard, COMMENT publisher
│   ├── modal.mjs                           # Session affinity & OpenCode config generator
│   └── report.mjs                          # JSON validation, summary builder, markdown formatter
├── tests/
│   ├── controller.test.mjs                 # Controller argument & mode tests
│   ├── docker-sandbox.test.mjs             # Docker SDK mock tests
│   ├── github.test.mjs                     # GitHub API & stale-guard tests
│   └── report.test.mjs                     # Schema & report validation tests
├── worker/
│   ├── opencode.json.template              # OpenCode Modal provider configuration
│   └── prompts/
│       ├── pr-review.md                    # Structured review prompt template
│       └── tool-smoke.md                   # Deterministic SHA-256 tool-loop smoke test
├── docker-modal-pr-review-research-notes.md# Comprehensive architectural notes
├── docker-modal-pr-review-standup-plan.md  # Original stand-up plan & exit criteria
├── package.json
└── README.md
```

---

## Required Secrets & Environment

The controller requires credentials for Docker Cloud Sandboxes and Modal inference. These are managed securely with **Doppler** (project: `ai-automation`, config: `dev`).

| Secret | Description | Where configured |
| :--- | :--- | :--- |
| `DOCKER_ID` | Docker Hub username | Doppler / GitHub Actions |
| `DOCKER_PAT` | Docker Personal Access Token with `sandbox:use` scope | Doppler / GitHub Actions |
| `MODAL_PROXY_TOKEN` | Modal API token for Shared Endpoint inference | Doppler / GitHub Actions |
| `GITHUB_TOKEN` | Token for reading PRs and posting COMMENT reviews | Automatically provided in Actions / Personal PAT locally |

### Setting Docker Credentials in Doppler:
```bash
doppler secrets set DOCKER_ID="<your-docker-username>" DOCKER_PAT="<your-docker-pat>" --project ai-automation --config dev
```

---

## Running Locally

### 1. Run Unit Tests (Mocked, No Credentials Required)
```bash
npm test
```

### 2. Run with Doppler (Phase 2: Prepare-Only Test on PR #201)
```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode prepare-only
```

### 3. Run Tool-Smoke Test (Phase 4)
```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode tool-smoke
```

### 4. Run Full Review Without Publishing (Phase 6)
```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode review \
  --publish false
```

### 5. Run Full Review With Publication (Phase 7)
```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode review \
  --publish true
```

---

## First-Run Verification Ladder

Follow this sequence to validate the spike step-by-step:

1. **Step A: Prepare Only (`--mode prepare-only --publish false`)**
   - Proves Docker PAT auth, sandbox provision (`large: 8 vCPU / 16 GiB`), checkout of exact PR HEAD SHA, merge-base calculation, and clean sandbox teardown.
   - Requires zero model credentials or inference calls.

2. **Step B: Tool Smoke (`--mode tool-smoke --publish false`)**
   - Proves OpenCode inside Docker, Modal Shared Endpoint connectivity, tool-loop execution (file read -> python SHA-256 calculation -> JSON write), and session ID propagation (`Modal-Session-Id`).

3. **Step C: Non-Publishing Review (`--mode review --publish false`)**
   - Runs the agent review over the PR diff.
   - Inspects `output/review.json` and `output/run-summary.json`.

4. **Step D: Publish Review (`--mode review --publish true`)**
   - Verifies stale-HEAD protection and posts a single GitHub `COMMENT` review.

---

## Promotion Path

After the spike is proven on `coldaine-codeOps`:
1. Move worker/controller into `coldaine-codeOps` under `.github/actions/review-kit/modal-docker/`.
2. Add docs to `docs/reviewers/modal-docker.md`.
3. Add input toggle to `.github/workflows/fleet-pr-review.yml`.
