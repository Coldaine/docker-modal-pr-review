# Docker + Modal PR Reviewer Spike: Operational Runbook

## Current inference backend

Shared DeepSeek V4.1 Flash is live and directly verified (HTTP 200, `PONG`, 3 output tokens). See [SHARED-INFERENCE.md](SHARED-INFERENCE.md) for the active URL, bounded smoke command, workspace usage-limit change and credit eligibility boundaries. Repository default changes are pending in [PR #1](https://github.com/Coldaine/docker-modal-pr-review/pull/1); the live Shared endpoint already works. Older Dedicated endpoint operations below are historical.


This runbook documents the operational commands, credential configuration, step-by-step verification ladder, failure triage, and promotion path for the Docker Cloud Sandboxes + Modal DeepSeek V4.1 Flash PR reviewer spike.

---

## 1. System & Architecture Overview

The system executes an automated, high-assurance review of GitHub pull requests inside ephemeral, isolated Docker Cloud Sandboxes powered by DeepSeek V4.1 Flash hosted on Modal Shared Endpoints.

```text
GitHub Actions / Local CLI (via Doppler)
  │
  ├── 1. Controller (src/controller.mjs)
  │      - Queries GitHub PR metadata & diff (src/github.mjs)
  │      - Records head commit SHA for stale-HEAD protection
  │      - Verifies Modal inference gateway readiness (src/modal.mjs)
  │
  ├── 2. Docker Cloud Sandbox Provisioning (src/docker-sandbox.mjs)
  │      - Authenticates via Docker PAT with sandbox:use scope
  │      - Spawns microVM (size: large [8 vCPU, 16 GiB], kit: opencode)
  │      - Sets 60-minute server-side deletion timeout
  │
  ├── 3. In-VM Repository Preparation
  │      - Clones target repo and checks out exact detached PR HEAD SHA
  │      - Calculates merge-base with target branch
  │      - Verifies tool chain: git, python3, opencode
  │
  ├── 4. OpenCode Agent Execution
  │      - Injects /workspace/.opencode/config.json with Modal endpoint URL & proxy token
  │      - Sets Modal-Session-Id header: review:<owner>/<repo>:pr-<n>:<sha>
  │      - Runs opencode non-interactively with structured review prompt
  │      - DeepSeek V4.1 Flash inspects code, runs local tools in sandbox, generates review
  │
  ├── 5. Validation & Safety Guards (src/report.mjs)
  │      - Ingests /workspace/review.json
  │      - Validates against JSON Schema (Draft 2020-12, ajv)
  │      - Verifies reviewed commit SHA matches live PR HEAD SHA
  │
  ├── 6. Publication & Teardown
  │      - Posts single GitHub COMMENT review (with idempotency marker)
  │      - Deletes Docker Cloud Sandbox microVM immediately
  │      - Emits run telemetry to output/run-summary.json
```

---

## 2. Prerequisites & Installed Tooling Status

| Tool | Status | Version / Path | Purpose |
| :--- | :--- | :--- | :--- |
| **Node.js** | Installed | `>= 20.x` | Controller runtime, Docker SDK, schema validation |
| **Modal CLI** | Installed | `v1.6.0` (`.\.venv\Scripts\modal.exe`) | Modal endpoint deployment, inspection, and volume auditing |
| **Docker CLI** | Installed | `29.5.3` (Docker Desktop + `docker-sandbox` v0.12.0) | Local CLI support; cloud runs via `@docker/sandboxes` SDK |
| **Doppler CLI** | Installed | Configured (`ai-automation` / `dev`) | Secure credential injection without local `.env` files |
| **GitHub CLI** | Installed | `gh` authenticated | PR inspection and GitHub Actions secret synchronization |

---

## 3. Credentials & Doppler Setup

All runtime credentials are centrally injected via Doppler (`project: ai-automation`, `config: dev`).

### Credentials Matrix

| Variable | Description | Where Required | How Created / Retrieved |
| :--- | :--- | :--- | :--- |
| `MODAL_TOKEN_ID` | Modal account token ID (`ak-...`) | Modal CLI management | Modal web dashboard |
| `MODAL_TOKEN_SECRET` | Modal account token secret (`as-...`) | Modal CLI management | Modal web dashboard |
| `MODAL_PROXY_TOKEN` | Modal Workspace Proxy Token (`wk-...` / `ws-...`) | OpenCode & direct inference | Generated via `modal token create --proxy` |
| `DOCKER_ID` | Docker Hub username | Docker Cloud Sandboxes | Docker Hub account |
| `DOCKER_PAT` | Docker PAT with `sandbox:use` scope | Docker Cloud Sandboxes | Docker Hub -> Account Settings -> Security -> New Access Token |
| `GITHUB_TOKEN` | GitHub PAT with repo / PR read & comment scope | PR read & review post | GitHub Settings -> Developer settings -> Personal access tokens |

### Setting Docker Credentials in Doppler
```bash
doppler secrets set DOCKER_ID="<your-docker-username>" DOCKER_PAT="<your-pat>" --project ai-automation --config dev
```

### Syncing Secrets to GitHub Actions Repository
```bash
doppler secrets get DOCKER_ID --plain | gh secret set DOCKER_ID --repo Coldaine/docker-modal-pr-review
doppler secrets get DOCKER_PAT --plain | gh secret set DOCKER_PAT --repo Coldaine/docker-modal-pr-review
doppler secrets get MODAL_PROXY_TOKEN --plain | gh secret set MODAL_PROXY_TOKEN --repo Coldaine/docker-modal-pr-review
```

---

## 4. Modal Shared Endpoint Operations

The active inference backend is `deepseek-v4-1-flash-shared` (`ep-wJ72EAwFPdMhsTLlqV6QNh`), serving `deepseek-ai/DeepSeek-V4.1-Flash` at:

`https://pmaclyman--ep-deepseek-v4-1-flash-shared-server.us-west.modal.direct/v1`

[SHARED-INFERENCE.md](SHARED-INFERENCE.md) records the live HTTP 200 completion, pricing, credentials, usage-limit change and credit eligibility boundaries. Shared usage is billed per token. It has no customer-owned GPU replica or idle scaledown tail.

The workspace was blocked at its $40 usage limit despite additional grant credit remaining. The limit is now $42. Additional grant eligibility for Shared tokens is unconfirmed; monthly included compute credits do not cover Shared usage.

The older Dedicated deployment `deepseek-v4-1-flash` was inactive with zero containers at inspection. It is historical infrastructure, not the active inference URL. Do not wake it for a Shared smoke test.

---

## 5. Verification Ladder (Phases 0 through 7)

Follow this rigorous verification sequence to validate the integration layer-by-layer before publishing live comments.

### Phase 0: Direct Shared Inference

```powershell
doppler run --project ai-automation --config dev -- node scripts/inference-smoke.mjs
```

Pass criteria: HTTP 200 from the intended model, content `PONG`, and completion-token usage in `output/shared-smoke.json`. The script makes one bounded request with no retries. This does not require Docker, OpenCode or a PR review.

---

### Phase 1: Docker Cloud Sandbox SDK Check
Confirm Docker PAT authentication and cloud connectivity using a quick mock/dry test.

```bash
npm test
```
**Pass Criteria**: All 18 unit tests pass (`tests/*.test.mjs`).

---

### Phase 2: In-Sandbox Repository Preparation (Prepare-Only)
Proves Docker Cloud Sandbox lifecycle: provisioning large microVM, cloning repo, checking out PR #201 exact HEAD commit, calculating merge-base, checking tool availability, and clean teardown. **No LLM inference calls are made.**

```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode prepare-only \
  --publish false
```
**Pass Criteria**:
- MicroVM created and verified (size `large`, kit `opencode`).
- Target commit checked out detached.
- Git, Python3, and OpenCode reported ready.
- MicroVM deleted cleanly upon exit.

---

### Phase 3: In-VM Headless OpenCode Handshake
Ensures OpenCode inside the Docker microVM can read its configuration and parse CLI arguments without interactive TTY prompt stalls.

```bash
# Verified during Tool-Smoke execution with non-interactive flags:
# opencode run --auto --format json "..."
```

---

### Phase 4: Deterministic Real Tool-Smoke Test
Validates the end-to-end handshake:
`OpenCode -> Modal (DeepSeek V4.1 Flash) -> Tool Call Payload -> MicroVM execution (file read & SHA-256) -> Tool result return -> Modal completion`.

```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode tool-smoke \
  --publish false
```
**Pass Criteria**:
- OpenCode invokes DeepSeek V4.1 Flash with `Modal-Session-Id` header.
- Model successfully executes in-sandbox inspection tool.
- Model produces structured tool-smoke completion.

---

### Phase 5: PR Review Prompt & Diff Validation
Validates that the review prompt template correctly injects:
- PR title & description
- Target branch & base commit SHA
- Exact PR HEAD commit SHA
- Filtered git diff

---

### Phase 6: Full Review Dry-Run (No Publish)
Executes complete PR review over PR #201, generates `output/review.json`, validates against Draft 2020-12 schema, formats `output/comment.md`, but **does not post to GitHub**.

```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode review \
  --publish false
```
**Pass Criteria**:
- `output/review.json` matches JSON schema (`valid: true`).
- `output/comment.md` contains markdown review summary with findings and recommendations.
- PR on GitHub remains untouched.

---

### Phase 7: Live PR Review Publication
Executes full review and posts a GitHub `COMMENT` review to PR #201 with stale-HEAD guard verification.

```bash
doppler run -- node src/controller.mjs \
  --pr 201 \
  --repo MooseGooseConsulting/coldaine-codeOps \
  --mode review \
  --publish true
```
**Pass Criteria**:
- Comment posted to PR #201 on `MooseGooseConsulting/coldaine-codeOps`.
- Re-running without `--force` reports comment already exists and safely exits.

---

## 6. Failure Modes & Troubleshooting

### 1. `401 Unauthorized` on Modal Gateway
- **Cause**: Using account token (`ak-...` / `as-...`) instead of Workspace Proxy Token (`wk-...` / `ws-...`).
- **Fix**: Verify `MODAL_PROXY_TOKEN` in Doppler is formatted as `wk-<id>.ws-<secret>`.

### 2. Endpoint `provisioning` Timeout
- **Cause**: Modal is spinning up the dedicated GPU instance and loading the 48 model shards. Initial warm-up can take 10-15 minutes.
- **Fix**: Check `modal endpoint list --env main --json`. Wait until status is `active`.

### 3. `Stale HEAD Guard Triggered`
- **Cause**: A new commit was pushed to PR #201 while the review was running.
- **Fix**: By design, the controller aborts publication to avoid posting obsolete comments. Re-run against the newest commit.

### 4. Docker Sandbox Quota or PAT Scope Error
- **Cause**: PAT missing `sandbox:use` scope or Docker Hub account limit reached.
- **Fix**: Regenerate PAT on Docker Hub with `sandbox:use` and update Doppler:
  `doppler secrets set DOCKER_PAT="<pat>" --project ai-automation --config dev`.

### 5. OpenCode Non-Zero Exit or Schema Mismatch
- **Cause**: Model produced unstructured prose instead of JSON conforming to `schema/review.schema.json`.
- **Fix**: Inspect `output/review.json` and check Ajv validation error logs.

---

## 7. Promotion Path into `coldaine-codeOps`

Once all 7 ladder phases succeed on PR #201:
1. Copy `src/`, `schema/`, `worker/`, and `package.json` into `MooseGooseConsulting/coldaine-codeOps` under `spikes/docker-modal-pr-review/`.
2. Add composite action wrapper under `.github/actions/review-kit/modal-docker/`.
3. Add review documentation under `docs/reviewers/modal-docker.md`.
4. Update `fleet/templates/pr-review.yml` to allow toggling Docker+Modal reviewer.
