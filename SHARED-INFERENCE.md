# Shared Modal inference

## Live service and repository state

The Shared endpoint was created and directly verified on 2026-09-30. This branch updates the repository defaults; those code changes are pending in [PR #1](https://github.com/Coldaine/docker-modal-pr-review/pull/1). The live endpoint already serves inference independently of that merge.

| Setting | Verified value |
| --- | --- |
| Workspace / environment | pmaclyman / main |
| Endpoint name | deepseek-v4-1-flash-shared |
| Endpoint ID | ep-wJ72EAwFPdMhsTLlqV6QNh |
| API base URL | https://pmaclyman--ep-deepseek-v4-1-flash-shared-server.us-west.modal.direct/v1 |
| Model ID | deepseek-ai/DeepSeek-V4.1-Flash |
| Authentication | Existing MODAL_PROXY_TOKEN, injected through Doppler |
| Billing | Per token; no customer-owned GPU idle tail |
| Model concurrency limit | 16 requests, shared across this workspace's endpoints using this model |
| Workspace usage limit | $42, raised from $40 to permit the smoke test |

The first creation failed explicitly because the workspace had exceeded its usage limit. Current UI usage was $41.54. After setting the limit to $42 and stopping only the newly failed attempt, the replacement Shared endpoint became ready.

## Direct inference verification

Use a plain HTTP client; no Docker sandbox, OpenCode agent, GitHub PR or reviewer is needed:

```powershell
doppler run --project ai-automation --config dev -- node scripts/inference-smoke.mjs
```

The script sends one request with a maximum of 32 completion tokens, thinking disabled using the dashboard's `reasoning_effort: "none"` example, a 60-second deadline and no automatic retries. It validates the returned model and `PONG`, reports usage, and saves credential-free evidence to `output/shared-smoke.json`. It prints no proxy token.

Observed at 2026-09-30T09:10:01.747Z: HTTP 200, model `deepseek-ai/DeepSeek-V4.1-Flash`, content `PONG`, finish reason `stop`, 10 prompt tokens, 3 completion tokens, 13 total tokens, 0 reasoning tokens, 667 ms. This proves a real authenticated completion; it does not establish agent tool compatibility or completed PR reviews.

## Cost and credit boundaries

The dashboard's Shared rates were $0.30 per million uncached prompt tokens, $0.03 cached prompt tokens, and $1.20 completion tokens. The first smoke request's rate-based estimate is $0.0000066; invoice allocation and credit coverage are separate from this estimate.

Monthly included compute credits cannot pay for Shared usage. The $238.46 remaining balance is a separate Hugging Face MCP Hackathon grant, initially $250 and expiring November 30, 2026. Eligibility of that particular grant for Shared token charges remains unconfirmed. Successful inference is not proof that a grant paid for it.

The prior Dedicated deployment `deepseek-v4-1-flash` remains inactive with zero containers at inspection. Its generated recipe used 4 x B200, 384 GiB RAM, a 1200-second idle window and a 90-minute startup ceiling. These are not settings of this Shared service. Do not wake the Dedicated service to test Shared inference.

Sources: [endpoint dashboard](https://modal.com/endpoints/pmaclyman/main/ep-wJ72EAwFPdMhsTLlqV6QNh), [Shared Endpoint docs](https://modal.com/docs/guide/shared-endpoints), [endpoint APIs](https://modal.com/docs/guide/endpoints), [workspace billing](https://modal.com/settings/pmaclyman/usage).
