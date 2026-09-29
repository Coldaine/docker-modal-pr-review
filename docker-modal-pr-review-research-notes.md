# Docker + Modal Agentic PR Reviewer — Research Notes

**Status:** living research/design note  
**Last updated:** 2026-09-24  
**Scope:** findings researched so far about using Docker Cloud Sandboxes as disposable agent hosts and Modal as the inference backend for an agentic GitHub PR reviewer.

---

## 1. Current conclusion

The cleanest architecture researched so far is:

```text
GitHub PR event / workflow_dispatch
        │
        ▼
small launcher/controller
(GitHub Actions is sufficient)
        │
        ▼
Docker Cloud Sandbox
large = 8 vCPU / 16 GiB
        │
        ├── clone repository
        ├── checkout exact PR HEAD SHA
        ├── fetch base / determine merge-base
        ├── install repo dependencies if configured
        ├── optional cheap smoke tests
        └── report READY
                │
                ▼
             OpenCode
                │
                │ OpenAI-compatible inference API
                ▼
Modal inference
(prefer Shared Endpoint if credit/billing permits)
                │
                ▼
OpenCode tool loop in Docker
(read/search/git/test/reproduce)
                │
                ▼
structured review report
                │
                ▼
controller validates SHA/report
                │
                ▼
GitHub COMMENT review
                │
                ▼
delete Docker sandbox
```

The main correction from the earliest design is that **Modal Shared Endpoints should be considered first**, not treated as a secondary convenience.

If the desired model is available as a Shared Endpoint, Modal behaves like a normal hosted inference provider: Modal owns the GPU fleet, model loading, batching, autoscaling, routing, and prompt-cache locality. The Docker sandbox simply calls the endpoint.

A Dedicated Endpoint is principally useful here when:

1. the specific Modal promotional/compute credit cannot be spent on Shared Endpoint token usage;
2. custom model weights or a custom serving stack are required;
3. isolated capacity is desirable;
4. sustained utilization eventually makes dedicated compute economically preferable.

The model-selection problem should **not** be framed as “cheap model by default, heavyweight model only on escalation” unless there is an actual operational rule that will trigger the escalation. If DeepSeek V4.1 Flash is the desired reviewer, the straightforward design is to use it for reviews directly.

---

## 2. Docker's role

Docker is the **agent execution host**, not the inference provider.

Docker Cloud Sandboxes provide isolated microVM environments with:

- their own filesystem;
- their own network;
- their own Docker daemon;
- package installation;
- Git;
- shell execution;
- coding-agent kits such as OpenCode, Claude Code, Codex, Gemini, and Docker Agent.

Current documented Cloud Sandbox sizes include:

| Size | vCPU | RAM |
|---|---:|---:|
| micro | 1 | 2 GiB |
| small | 2 | 4 GiB |
| medium | 4 | 8 GiB |
| **large** | **8** | **16 GiB** |
| xl | 16 | 32 GiB |

For the proposed PR-review worker, **large (8 vCPU / 16 GiB)** is the working assumption.

The sandbox should be disposable and tied to one review attempt.

### Relevant Docker documentation

- Sandboxes API and SDK: https://docs.docker.com/ai/sandboxes-api/
- SDK quickstart: https://docs.docker.com/ai/sandboxes-api/get-started/
- Authentication/PAT usage: https://docs.docker.com/ai/sandboxes-api/authentication/
- Compute sizes and quotas: https://docs.docker.com/ai/sandboxes-api/limits/
- API concepts and bundled kits: https://docs.docker.com/ai/sandboxes-api/concepts/
- Run agents with kits: https://docs.docker.com/ai/sandboxes-api/cookbook/add-tools-with-kits/
- Server-side sandbox lifetime: https://docs.docker.com/ai/sandboxes-api/cookbook/keep-a-cloud-sandbox-running/
- Process environment handling: https://docs.docker.com/ai/sandboxes-api/cookbook/what-your-workload-starts-with/

### Docker authentication

For unattended automation, Docker documents PAT authentication with the `sandbox:use` permission.

The launcher should hold the Docker credential. The model-running agent does **not** need Docker administrative credentials.

### Sandbox lifecycle

Recommended behavior:

```text
create sandbox
    ↓
wait until running
    ↓
wait for agent/tool readiness if kit setup continues asynchronously
    ↓
clone / prepare / review
    ↓
retrieve report and logs
    ↓
explicitly delete sandbox
```

Also configure a **server-side timeout whose expiry action is deletion**. This protects against a dead launcher or failed cleanup.

Important Docker API detail: `launchAndWait()` / `waitUntilRunning()` only prove that the sandbox reached a running state. Kit setup can still be occurring. The workflow therefore needs a readiness check for the actual tools it expects to use.

---

## 3. Triggering: GitHub Actions vs. webhook

There is no strong reason to build a new webhook service for version one.

GitHub Actions is sufficient as the **launcher/controller**, without turning the Docker sandbox into a GitHub Actions runner.

```text
GitHub Actions
    = trigger + orchestration + final publication

Docker Sandbox
    = actual agent execution environment
```

The Action can:

1. receive `pull_request` or `workflow_dispatch`;
2. resolve the PR base SHA and head SHA;
3. create the Docker Cloud Sandbox;
4. invoke the worker;
5. retrieve its structured report;
6. ensure the PR head has not changed;
7. publish a GitHub PR review;
8. delete the sandbox.

This is **not CI recursion** and does not require runner registration.

A GitHub App identity can later replace the default workflow identity if desired without changing the Docker or Modal portions of the architecture.

### GitHub publication

The intended first implementation is a **COMMENT review**, not approval, request-changes gate, merge, code push, or required status check.

The review should be explicitly bound to the reviewed head commit.

GitHub review API:  
https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request

---

## 4. Modal has two materially different inference products

### 4.1 Shared Endpoints

Shared Endpoints are Modal acting as a hosted inference provider.

The caller does **not** provision or manage the model's GPU deployment.

Modal owns:

- model replicas;
- GPU allocation;
- autoscaling;
- model loading;
- batching;
- serving engine;
- load balancing;
- prompt-cache-aware routing.

The caller sends OpenAI-compatible requests and is billed by tokens.

Documentation:

- https://modal.com/docs/guide/shared-endpoints
- https://modal.com/docs/guide/endpoint-integrations

For OpenCode, Modal documents direct Shared Endpoint integration using a Modal proxy token.

The common Shared Endpoint API is documented under:

```text
https://inference.us-west.modal.direct/v1
```

The endpoint/model identifier is routed through the `model` field.

#### Why Shared is attractive for agentic review

For a sporadic PR-review workload:

- there is no per-review model deployment;
- there is no explicit GPU startup controller;
- there is no weight-loading logic to maintain;
- there is no idle GPU owned by the user;
- Modal can route around its own serving fleet;
- prompt caching is handled inside Modal's shared infrastructure.

This is very close to the ideal abstraction boundary for the proposed system.

### 4.2 Dedicated Endpoints

Dedicated Endpoints give the user a distinct serving deployment.

Modal provides generated serving source for supported models/recipes, but the deployment is conceptually the user's capacity.

Billing follows underlying compute rather than Shared Endpoint token pricing.

Documentation:  
https://modal.com/docs/guide/dedicated-endpoints

Important lifecycle distinction:

**Do not deploy and destroy the endpoint for every PR.**

Instead:

```text
deploy endpoint definition once
        │
        ├── persistent model/cache artifacts
        │
        └── ephemeral GPU replica(s)
                  │
                  ├── scale from zero when requests arrive
                  └── return to zero after idle timeout
```

The deployment definition and its model cache should persist between reviews.

`modal endpoint stop` is a retirement/destructive operation, not normal per-review cleanup.

Dedicated is most interesting here if the $280 credit applies to compute but not Shared Endpoint token billing.

---

## 5. Modal caching — several different layers

Earlier descriptions that implied “scale to zero means redownload the model” were too simplistic.

There are multiple cache layers.

### 5.1 Dedicated Endpoint managed model cache

Modal Dedicated Endpoints maintain model cache state separately from the lifetime of individual GPU replicas.

The endpoint can scale to zero without requiring the logical deployment and cached model state to disappear.

```text
persistent:
    endpoint definition
    managed model cache
    image/build artifacts

ephemeral:
    GPU container
    loaded HBM state
    live KV/prefix cache
```

This is a major reason to deploy the endpoint once and scale its compute rather than recreating the deployment for each review.

### 5.2 Modal distributed filesystem caching

Modal has described a distributed filesystem/cache layer that can make frequently accessed files hot across infrastructure.

This is relevant to popular model weights and common runtime artifacts, although it should not be treated as a contractual guarantee that a particular model shard will always be memory-resident on the next worker.

Related Modal material:  
https://modal.com/blog/gpu-mem-snapshots

### 5.3 Persistent Volumes for custom deployments

For custom serving applications, Modal recommends persistent model storage rather than repeatedly downloading weights from upstream.

Model-weight guidance:  
https://modal.com/docs/guide/model-weights

The normal custom-serving pattern is:

```text
CPU-only preparation job
    ↓
download pinned model revision
    ↓
Modal Volume / persistent storage
    ↓
GPU-serving app mounts cached weights
```

That removes repeated external model downloads, though weights still need to move into CPU/GPU memory on a cold GPU start.

### 5.4 Image/build/JIT caches

For a custom inference server, relevant cached artifacts can include:

- container/image layers;
- Python packages;
- CUDA libraries;
- serving engine;
- compiled kernels;
- JIT-generated artifacts.

These should be reused rather than rebuilt on every PR.

### 5.5 GPU memory snapshots

Modal supports GPU memory snapshots.

The feature is intended to preserve enough initialized GPU state to reduce cold starts for compatible workloads.

Modal has published examples showing large cold-start reductions, although vLLM/SGLang-style serving can require workload-specific adaptation.

Relevant material:

- https://modal.com/blog/gpu-mem-snapshots
- https://modal.com/docs/guide/high-performance-llm-inference

**Recommendation so far:** do not make GPU snapshots a requirement for version one. First measure ordinary Dedicated Endpoint cold starts with persistent weights/model cache. Add snapshots only if startup latency materially hurts the workflow.

---

## 6. Prompt / prefix / KV caching

This is particularly important for an agentic coding workflow.

A coding agent repeatedly sends a conversation whose prefix largely overlaps with the previous request:

```text
turn 1:
system + tools + task + first exploration

turn 2:
same prefix + tool call/result

turn 3:
same prefix + more tool output
```

Modal documents `Modal-Session-Id` for affinity.

A review should use one stable session identifier for all model calls from the same agent run, for example:

```text
review:<owner>/<repo>:pr-<number>:<head-sha>
```

Example:

```text
Modal-Session-Id:
review:MooseGooseConsulting/repo:pr-716:abc123...
```

The intention is to keep a conversation routed toward capacity likely to retain its prompt prefix / cache state.

This matters for both latency and cost where cached-input pricing is available.

For Shared Endpoints in particular, Modal documents cache-aware routing and session affinity as part of the platform behavior.

---

## 7. Model choice — researched candidates

The model choice should be made based on the reviewer we actually want, not on a fictional escalation scheme.

### DeepSeek V4.1 Flash

**Current preferred research candidate for the actual reviewer.**

Why it is interesting for this workflow:

- oriented toward agentic/coding use;
- tool calling;
- structured / JSON output;
- large context;
- inexpensive Shared Endpoint pricing;
- very low cached-input price;
- available through Modal's managed serving products.

Sources:

- https://modal.com/library/deepseek/deepseek-v4-1-flash
- https://api-docs.deepseek.com/updates/
- https://www.deepseek.com/en/news/deepseek-v4-1-flash/
- https://github.com/vllm-project/recipes/blob/main/models/deepseek-ai/DeepSeek-V4.1-Flash.yaml

#### Shared Endpoint economics researched so far

Current researched Modal pricing for DeepSeek V4.1 Flash Shared Endpoint:

| Token class | Approx. price per 1M tokens |
|---|---:|
| input | $0.30 |
| cached input | $0.03 |
| output | $1.20 |

These values should be rechecked before implementation because pricing can change.

Illustrative agent review:

```text
100k uncached input
400k cached input
20k output
```

Approximate model charge:

```text
100k × $0.30 / 1M = $0.030
400k × $0.03 / 1M = $0.012
 20k × $1.20 / 1M = $0.024
--------------------------------
total ≈ $0.066
```

This illustrates why using a materially weaker reviewer merely to save inference cost may be a false economy.

---

## 8. Dedicated DeepSeek is a very different cost shape

DeepSeek V4.1 Flash is not a trivial one-GPU deployment.

The current public vLLM recipe demonstrates multi-GPU serving configurations. Exact Modal Auto/Dedicated Endpoint topology must be read from Modal's generated serving configuration rather than inferred.

Relevant recipe:  
https://github.com/vllm-project/recipes/blob/main/models/deepseek-ai/DeepSeek-V4.1-Flash.yaml

Thus:

```text
Shared:
    Modal owns the expensive multi-GPU fleet
    user pays token price

Dedicated:
    user-specific deployment allocates the required GPUs
    user pays compute seconds
```

For a low-duty-cycle PR reviewer, Shared is naturally the simpler product.

Dedicated is attractive if its compute cost is effectively prepaid by the promotional credit.

---

## 9. The $280 Modal credit question remains unresolved

The public documentation researched so far states that credits included with a Modal plan cannot be used for Shared Endpoint usage.

That statement clearly covers **plan-included compute credits**.

It does **not**, by itself, prove whether a specific promotional/grant balance is or is not eligible for Shared Endpoint token charges.

Therefore the correct status is:

```text
Known:
    normal plan-included compute credit ≠ Shared Endpoint token credit

Unknown:
    eligibility rules for this specific $280 promotional/grant balance
```

Do not assume either direction without checking the account's actual billing behavior or grant terms.

Relevant pages:

- https://modal.com/docs/guide/shared-endpoints
- https://modal.com/pricing
- https://modal.com/docs/guide/budgets
- https://modal.com/docs/cli/latest/billing

### Recommended empirical check

Use a very small Shared Endpoint request, then inspect Modal billing/credit accounting.

The question is not “did the request work?” but:

```text
Which balance was actually debited?
```

If the promotional balance pays Shared Endpoint token usage, Shared becomes the obvious first implementation.

If it does not, Dedicated can be used to consume compute credit while preserving almost the same Docker/OpenCode workflow.

---

## 10. Shared vs Dedicated for the same model

This is the correct fallback structure.

```text
                         DeepSeek V4.1 Flash
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
          Shared Endpoint                 Dedicated Endpoint
                  │                               │
         Modal's serving fleet              user-specific
         token billing                      compute billing
                  │                               │
         simplest architecture             useful for compute credit
```

The rest of the review system should be as invariant as possible.

Ideally, changing between the two only changes provider configuration:

```text
MODEL_BASE_URL
MODEL_ID
MODAL_PROXY_TOKEN
```

OpenCode, Docker setup, review prompt, report validation, and GitHub publication should remain the same.

---

## 11. OpenCode's role

OpenCode should own the **agent loop**.

Do not write a custom LLM-agent framework for this project.

OpenCode can:

- inspect files;
- search the repository;
- run shell commands;
- use Git;
- execute targeted tests;
- reason over tool results;
- continue multi-turn inference;
- produce the final review report.

Sources:

- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/config/

The intended headless form is approximately:

```bash
opencode run \
  --auto \
  --format json \
  --agent docker-modal-review \
  --model <provider>/<model> \
  "<review task>"
```

Exact flags/version behavior should be verified against the installed OpenCode version before production use.

---

## 12. Do not dump the whole repository into the prompt

The worker already has the repository checkout.

The initial review prompt can therefore stay compact.

Conceptually:

```text
Review PR #716.

HEAD: <head sha>
BASE: <base sha>
MERGE BASE: <merge-base>

Use git diff <merge-base>..HEAD to inspect the change.
Read relevant surrounding code and callers.
Run targeted tests or reproductions where useful.
Report only actionable defects introduced by this PR.

Write the final structured findings to /workspace/review.json.
```

This is preferable to blindly serializing a huge patch/repository into the first model call because it reduces initial prefill, lets the model choose relevant context, preserves repository search, and makes repeated turns better candidates for prefix/session caching.

---

## 13. Repository preparation

The Docker worker should perform repository-specific preparation **before waking Dedicated GPU inference**.

For Shared Endpoints, there is no user-owned GPU wake-up step, but preparing first is still sensible.

General phase structure:

```text
PHASE 1: checkout
    clone
    checkout exact head SHA
    fetch base
    calculate merge-base

PHASE 2: prepare
    optional dependency install
    optional generated-code setup
    optional repo-local bootstrap

PHASE 3: cheap checks
    optional focused test/lint/build command

PHASE 4: inference readiness
    configure provider
    validate model endpoint
    run tool-loop smoke test

PHASE 5: review
    OpenCode explores/reproduces
    writes structured report

PHASE 6: publication
    verify PR head has not changed
    validate report
    publish COMMENT review

PHASE 7: cleanup
    retrieve logs/artifacts
    delete Docker worker
```

Preparation commands should be repository configuration, not guesses embedded into the generic controller.

Examples only:

```text
uv sync --frozen
npm ci
pnpm install --frozen-lockfile
go mod download
```

The system should not invent a fake “default test command.”

---

## 14. Real inference/tool-loop smoke test

A health endpoint is insufficient.

The important integration test is:

```text
model request
    ↓
tool call emitted
    ↓
OpenCode executes tool in Docker
    ↓
tool result returned
    ↓
model consumes result
    ↓
agent writes a verifiable artifact
```

One proposed deterministic smoke test:

1. create a file containing random data;
2. do **not** put its contents in the prompt;
3. ask OpenCode to read it;
4. ask OpenCode to run Python and compute its SHA-256;
5. ask it to write a JSON result;
6. controller verifies the digest itself.

This proves more than `/v1/models` and checks the actual tool protocol used by the selected model, serving stack, OpenCode version, and provider integration.

---

## 15. Review output contract

The agent should return a structured artifact rather than free-form prose only.

Example schema:

```json
{
  "head_sha": "abc123...",
  "complete": true,
  "summary": "What was inspected and the overall result",
  "findings": [
    {
      "severity": "P1",
      "title": "Specific defect",
      "path": "src/module.py",
      "line": 42,
      "description": "What fails and under what condition",
      "evidence": "Precise code evidence or reproduction"
    }
  ],
  "tests": [
    "command and observed result"
  ],
  "limitations": [
    "anything important that could not be checked"
  ]
}
```

Controller validation should reject malformed reports, mismatched head SHAs, `complete=false`, and invalid paths/lines where detectable.

A failed or incomplete review must **not** be translated into “no issues found.”

---

## 16. PR supersession and duplicate control

A PR can change while the agent is reviewing it.

Required behavior:

```text
review starts at SHA A
        │
new commit SHA B arrives
        │
old job may be canceled
        │
before publishing:
    query current PR HEAD
        │
        ├── still SHA A → publish
        └── now SHA B   → discard stale review
```

Also key completed reviews by something like:

```text
repo + PR + head SHA + reviewer/model version
```

This avoids posting identical reviews repeatedly on workflow reruns.

---

## 17. Concurrency

There are two separate concurrency domains.

### Docker concurrency

Docker currently documents a default account quota of 10 concurrent Cloud Sandboxes, though account-specific quota can differ.

### Modal Shared

Modal manages model-fleet concurrency. The user mostly thinks in terms of API capacity, token billing, and session affinity.

### Modal Dedicated

`max_containers` controls replica count, **not GPU count**.

A single model replica can itself use several GPUs.

For an expensive large model, start with:

```text
min_containers = 0
max_containers = 1
```

until the per-replica resource footprint and concurrency behavior are measured.

---

## 18. Dedicated endpoint cold start

Dedicated inference can have several cold-start components:

```text
allocate GPU worker
    ↓
start runtime/container
    ↓
mount/read cached model artifacts
    ↓
load weights into CPU/GPU memory
    ↓
initialize engine/kernels
    ↓
ready
```

Weight caching removes external downloads but does not eliminate weight loading and serving-engine initialization.

Modal Servers may return transient errors such as `503` while capacity is coming up; the client should retry boundedly rather than treating the first response as a permanent failure.

Documentation:  
https://modal.com/docs/guide/servers

For version one:

- retry transient startup responses;
- use a bounded readiness deadline;
- fail immediately on authentication/model mismatch;
- do not silently switch to a paid fallback provider without recording it.

---

## 19. Shutdown behavior

### Docker

Explicitly delete the sandbox after report/log retrieval and configure a server-side expiry that deletes it if the launcher dies.

### Modal Shared

There is **no teardown step owned by this workflow**. The request ends; Modal owns the serving fleet.

### Modal Dedicated

Do **not** destroy the deployment per PR. Stop sending traffic and let autoscaling return replicas to zero. The endpoint definition/cache remains.

Deleting the Docker worker does not synchronously kill a Modal GPU replica. There may be active request time, tool-wait warm time, scale-down idle tail, and container shutdown tail.

---

## 20. Cost accounting

Cost should be measured rather than inferred indefinitely.

Per review, record at least:

```text
repo
PR number
head SHA
model ID
shared vs dedicated
review session ID
Docker sandbox ID
Docker start/end timestamps
model phase start/end timestamps
input tokens
cached input tokens if exposed
output tokens
review status
```

For Dedicated, also track:

```text
Modal app/endpoint
GPU type
GPU count per replica
replica count
cold-start duration
active inference duration
idle/downscale configuration
```

Relevant billing CLI:  
https://modal.com/docs/cli/latest/billing

---

## 21. Models investigated so far

### DeepSeek V4.1 Flash

**Current preferred research candidate for the actual reviewer.**

Reasons researched:

- 1M-class context on Modal offering;
- tool calling;
- structured/JSON output;
- agentic coding positioning;
- cheap Shared input;
- very cheap cached input;
- supports Shared and Dedicated Modal paths.

Sources:

- https://modal.com/library/deepseek/deepseek-v4-1-flash
- https://api-docs.deepseek.com/updates/
- https://www.deepseek.com/en/news/deepseek-v4-1-flash/
- https://github.com/vllm-project/recipes/blob/main/models/deepseek-ai/DeepSeek-V4.1-Flash.yaml

### Qwen3.8-27B

Investigated as a potentially inexpensive Dedicated reviewer.

The public vLLM recipe includes modern coding-agent-serving features such as tool parsing and long context, and practitioner reports were favorable.

However, the previous recommendation to make Qwen the default solely to avoid using DeepSeek was not convincing once Shared DeepSeek economics were examined.

Relevant recipe:  
https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-27B.yaml

Qwen may still be attractive if Dedicated compute credit is the main objective, a single-GPU deployment gives much better credit efficiency, latency/startup is substantially better, and direct review evaluation shows quality is adequate.

### GPT-OSS 120B / GLM / Kimi / Qwen Max

These were considered as comparison points.

The current conclusion is not that they are unusable, but that there is no current reason to complicate version one with a broad model router.

The architecture should first prove one model/provider path end-to-end.

---

## 22. What has NOT been verified yet

### Docker

- actual installed `@docker/sandboxes` SDK version/API;
- authenticated Cloud Sandbox launch;
- exact OpenCode kit contents;
- Python/runtime availability inside that kit;
- Docker cloud outbound network behavior to Modal;
- file transfer/log retrieval in the target account.

### Modal

- whether the specific $280 promotional credit pays Shared Endpoint token usage;
- exact DeepSeek Shared Endpoint availability/limits in the workspace;
- exact current Shared pricing at deployment time;
- exact Dedicated DeepSeek GPU topology generated by Modal;
- cold-start duration for the actual recipe;
- cache-hit behavior on repeated reviews;
- spend/usage accounting for the credit.

### OpenCode

- exact current CLI flags;
- provider config behavior with the selected Modal path;
- tool-call compatibility with DeepSeek V4.1 Flash;
- correct propagation of `Modal-Session-Id`;
- long-running headless behavior;
- trace/log behavior.

### GitHub

- exact workflow identity desired;
- whether the review should eventually post inline findings;
- GitHub App vs default Actions token;
- behavior for fork PRs;
- handling of private submodules/private package registries.

### Repository policy

- bootstrap command;
- smoke-test command;
- directories to ignore;
- generated/vendor files;
- max review duration;
- which PRs should trigger automatically;
- desired review severity taxonomy.

---

## 23. Proposed implementation order

### Step 1 — Shared-credit billing test

Create/use the DeepSeek V4.1 Flash Shared Endpoint and send a tiny request. Inspect billing and determine whether the $280 promotional balance is debited.

If **yes**, use Shared first.

If **no**, decide whether the objective is cheapest ongoing review or intentionally consuming the free compute credit. If consuming credit is desirable, use Dedicated while keeping the rest of the workflow the same.

### Step 2 — Docker prepare-only smoke test

No model access yet.

Prove:

```text
Action
  → Docker Cloud Sandbox
  → clone exact PR
  → calculate merge-base
  → optional repo prep
  → retrieve evidence
  → delete sandbox
```

### Step 3 — Provider/tool smoke test

Prove:

```text
Docker/OpenCode
  → Modal
  → tool call
  → shell execution
  → verifiable file
```

Use the deterministic SHA-256 test.

### Step 4 — Nonpublishing real review

Run the complete agent review but store the structured report as an artifact. Do not post it to the PR yet.

Evaluate review quality, context usage, token usage, tool behavior, wall-clock time, cache behavior, and cost.

### Step 5 — Publish COMMENT review

Enable GitHub review publication only after the first reports look sane.

### Step 6 — Measure before optimizing

Only after several real reviews decide whether to optimize GPU snapshots, Dedicated server topology, additional models, parallel replicas, inline-comment formatting, a GitHub App, or a standalone webhook/controller.

---

## 24. Architecture principles that appear settled

1. **Docker hosts the agent; Modal hosts inference.**
2. **GitHub Actions is sufficient as the launcher initially.**
3. **OpenCode owns the agent/tool loop.**
4. **The repository is cloned before inference begins.**
5. **The agent reads the repository itself rather than receiving the entire repo in the prompt.**
6. **One stable Modal session ID should be used for the review conversation.**
7. **The final report is structured and commit-bound.**
8. **Stale reviews must not publish after a new commit.**
9. **The model should not receive GitHub publication credentials.**
10. **Docker workers are deleted per review.**
11. **Shared Modal needs no per-review teardown.**
12. **Dedicated Modal deployments persist while their GPU replicas scale to zero.**
13. **Persistent model/cache state should survive between Dedicated reviews.**
14. **Use the model we actually want, rather than inventing an escalation tier nobody will invoke.**
15. **Measure cost and cold-start behavior from real runs before introducing elaborate optimization.**

---

## 25. Source index

### Docker

- https://docs.docker.com/ai/sandboxes/
- https://docs.docker.com/ai/sandboxes-api/
- https://docs.docker.com/ai/sandboxes-api/get-started/
- https://docs.docker.com/ai/sandboxes-api/authentication/
- https://docs.docker.com/ai/sandboxes-api/limits/
- https://docs.docker.com/ai/sandboxes-api/concepts/
- https://docs.docker.com/ai/sandboxes-api/cookbook/add-tools-with-kits/
- https://docs.docker.com/ai/sandboxes-api/cookbook/keep-a-cloud-sandbox-running/
- https://docs.docker.com/ai/sandboxes-api/cookbook/what-your-workload-starts-with/

### Modal

- https://modal.com/docs/guide/shared-endpoints
- https://modal.com/docs/guide/dedicated-endpoints
- https://modal.com/docs/guide/endpoint-integrations
- https://modal.com/docs/guide/model-weights
- https://modal.com/docs/guide/high-performance-llm-inference
- https://modal.com/docs/guide/servers
- https://modal.com/docs/guide/budgets
- https://modal.com/docs/cli/latest/billing
- https://modal.com/pricing
- https://modal.com/blog/gpu-mem-snapshots
- https://modal.com/library/deepseek/deepseek-v4-1-flash

### OpenCode

- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/config/

### Serving/model recipes

- https://github.com/vllm-project/recipes/blob/main/models/deepseek-ai/DeepSeek-V4.1-Flash.yaml
- https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-27B.yaml
- https://github.com/modal-labs/modal-examples/tree/main/06_gpu_and_ml/llm-serving

### GitHub

- https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow

---

## 26. Immediate unanswered questions

1. **Does the specific $280 Modal promotional balance pay Shared Endpoint charges?**
2. **What exact Shared Endpoint hostname/model ID does Modal expose for DeepSeek V4.1 Flash in the account?**
3. **Does OpenCode + that Shared Endpoint pass a real multi-turn tool-call smoke test?**
4. **Can OpenCode's Modal provider preserve a custom `Modal-Session-Id`, or do we need a custom provider/header configuration?**
5. **What token/cache metrics does Modal expose per request/session for Shared DeepSeek?**
6. **If Shared credit is unavailable, what exact GPU topology does Modal's generated Dedicated DeepSeek recipe currently use?**
7. **What is the measured Dedicated cold-start time after the model cache is already populated?**
8. **What repo-local bootstrap/test convention should the generic worker consume?**
9. **Should review findings remain one Markdown COMMENT review initially, or move to inline annotations after quality is established?**
10. **How should the workflow identify reviewer version/model version so reruns are deduplicated cleanly?**

---

## Bottom line

The simplest serious version now appears to be:

```text
GitHub Action
    ↓
Docker Cloud Sandbox (large)
    ↓
clone + prepare repo
    ↓
OpenCode
    ↓
DeepSeek V4.1 Flash on Modal Shared Endpoint
    ↓
structured review
    ↓
GitHub COMMENT review
    ↓
delete Docker sandbox
```

**If the $280 promotional credit applies to Shared Endpoint token usage, this is the preferred architecture.**

If it does not, keep exactly the same Docker/OpenCode/GitHub design and substitute a **scale-to-zero Dedicated DeepSeek endpoint** so the compute credit can be consumed without redesigning the reviewer.
