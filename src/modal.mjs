import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, '../worker/opencode.json.template');
export const SMOKE_PROMPT_PATH = path.resolve(__dirname, '../worker/prompts/tool-smoke.md');
export const REVIEW_PROMPT_PATH = path.resolve(__dirname, '../worker/prompts/pr-review.md');

/**
 * Builds the canonical Modal session affinity identifier for a review run.
 * Format: review:<owner>/<repo>:pr-<number>:<headSha>
 */
export function buildSessionId(owner, repo, prNumber, headSha) {
  if (!owner || !repo || !prNumber || !headSha) {
    throw new Error('All of owner, repo, prNumber, and headSha are required for session ID');
  }
  return `review:${owner}/${repo}:pr-${prNumber}:${headSha}`;
}

/**
 * Renders an OpenCode configuration string from a template.
 */
export function renderOpenCodeConfig({
  templateContent,
  templatePath = DEFAULT_TEMPLATE_PATH,
  baseUrl = 'https://inference.us-west.modal.direct/v1',
  modelId = 'deepseek-v4-1-flash',
  contextTokens = 131072,
  outputTokens = 16384,
  sessionId,
  proxyToken,
}) {
  const raw = templateContent ?? fs.readFileSync(templatePath, 'utf8');

  return raw
    .replaceAll('{{MODEL_BASE_URL}}', baseUrl)
    .replaceAll('{{MODEL_ID}}', modelId)
    .replaceAll('{{MODEL_CONTEXT_TOKENS}}', String(contextTokens))
    .replaceAll('{{MODEL_OUTPUT_TOKENS}}', String(outputTokens))
    .replaceAll('{{MODAL_SESSION_ID}}', sessionId || '')
    .replaceAll('{{MODAL_PROXY_TOKEN}}', proxyToken || '');
}

/**
 * Renders a prompt template replacing {{VAR}} placeholders.
 */
export function renderPrompt(templatePath, vars = {}) {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [key, val] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, String(val));
  }
  return content;
}

/**
 * Validates connectivity to the Modal endpoint.
 */
export async function validateModalEndpoint({ baseUrl, proxyToken, timeoutMs = 15000 }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${proxyToken}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        status: res.status,
        error: `Modal endpoint returned ${res.status}: ${errText}`,
      };
    }

    const data = await res.json();
    return {
      ok: true,
      status: res.status,
      models: data.data || data.models || [],
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      error: `Failed to connect to Modal endpoint: ${err.message}`,
    };
  }
}
