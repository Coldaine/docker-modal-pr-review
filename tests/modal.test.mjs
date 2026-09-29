import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildSessionId, renderOpenCodeConfig, renderPrompt, validateModalEndpoint } from '../src/modal.mjs';

test('buildSessionId generates correct session affinity string', () => {
  const sid = buildSessionId('MooseGooseConsulting', 'coldaine-codeOps', 201, 'abcdef123456');
  assert.equal(sid, 'review:MooseGooseConsulting/coldaine-codeOps:pr-201:abcdef123456');
});

test('renderOpenCodeConfig interpolates all template variables', () => {
  const template = `{"url": "{{MODEL_BASE_URL}}", "model": "{{MODEL_ID}}", "session": "{{MODAL_SESSION_ID}}", "token": "{{MODAL_PROXY_TOKEN}}", "ctx": {{MODEL_CONTEXT_TOKENS}}, "out": {{MODEL_OUTPUT_TOKENS}}}`;

  const rendered = renderOpenCodeConfig({
    templateContent: template,
    baseUrl: 'https://inference.us-west.modal.direct/v1',
    modelId: 'deepseek/deepseek-v4.1-flash',
    sessionId: 'review:test:pr-1:abc',
    proxyToken: 'dummy-proxy-token',
    contextTokens: 65536,
    outputTokens: 8192
  });

  const parsed = JSON.parse(rendered);
  assert.equal(parsed.url, 'https://inference.us-west.modal.direct/v1');
  assert.equal(parsed.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(parsed.session, 'review:test:pr-1:abc');
  assert.equal(parsed.token, 'dummy-proxy-token');
  assert.equal(parsed.ctx, 65536);
  assert.equal(parsed.out, 8192);
});

test('validateModalEndpoint returns ok on 200 response', async () => {
  let authHeader = null;
  const server = http.createServer((req, res) => {
    authHeader = req.headers['authorization'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }] }));
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const result = await validateModalEndpoint({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      proxyToken: 'modal-token-xyz'
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(authHeader, 'Bearer modal-token-xyz');
    assert.equal(result.models.length, 1);
  } finally {
    server.close();
  }
});
