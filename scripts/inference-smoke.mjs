import fs from 'node:fs';

const baseUrl = 'https://pmaclyman--ep-deepseek-v4-1-flash-shared-server.us-west.modal.direct/v1';
const model = 'deepseek-ai/DeepSeek-V4.1-Flash';
const token = process.env.MODAL_PROXY_TOKEN;
if (!token) throw new Error('MODAL_PROXY_TOKEN is required; inject it with Doppler');

const started = Date.now();
try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly PONG.' }],
      max_tokens: 32,
      temperature: 0,
      reasoning_effort: 'none',
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 1000) }; }
  const result = {
    timestamp: new Date().toISOString(),
    endpoint: baseUrl,
    mode: 'shared',
    status: response.status,
    elapsed_ms: Date.now() - started,
    model: data.model,
    content: data.choices?.[0]?.message?.content,
    finish_reason: data.choices?.[0]?.finish_reason,
    usage: data.usage,
    error: response.ok ? undefined : data.error,
  };
  const safe = JSON.stringify(result, null, 2).replaceAll(token, '[REDACTED]');
  fs.mkdirSync('output', { recursive: true });
  fs.writeFileSync('output/shared-smoke.json', `${safe}\n`);
  console.log(safe);
  if (!response.ok || result.content?.trim() !== 'PONG' || data.model !== model) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error.message).replaceAll(token, '[REDACTED]'));
  process.exitCode = 1;
}
