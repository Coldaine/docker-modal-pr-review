import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getPRMetadata, getCurrentHead, checkAlreadyReviewed, safePublishReview } from '../src/github.mjs';

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

test('getPRMetadata parses pull request response correctly', async () => {
  const mock = await createMockServer((req, res) => {
    assert.equal(req.url, '/repos/owner/repo/pulls/42');
    assert.equal(req.headers['authorization'], 'Bearer test-token');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      number: 42,
      title: 'Fix edge case in parser',
      state: 'open',
      draft: false,
      base: { sha: 'base123456', ref: 'main', repo: { clone_url: 'https://github.com/owner/repo.git' } },
      head: { sha: 'headabcdef', ref: 'fix/edge-case', repo: { clone_url: 'https://github.com/owner/repo.git' } },
      html_url: 'https://github.com/owner/repo/pull/42'
    }));
  });

  try {
    const meta = await getPRMetadata({
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      token: 'test-token',
      apiBase: mock.url
    });

    assert.equal(meta.prNumber, 42);
    assert.equal(meta.headSha, 'headabcdef');
    assert.equal(meta.baseSha, 'base123456');
    assert.equal(meta.isDraft, false);
  } finally {
    await mock.close();
  }
});

test('safePublishReview aborts when PR HEAD has changed (stale guard)', async () => {
  const mock = await createMockServer((req, res) => {
    if (req.method === 'GET') {
      // Returns updated SHA
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        number: 42,
        title: 'PR',
        base: { sha: 'base_sha' },
        head: { sha: 'new_head_777777' }
      }));
    } else {
      assert.fail('POST should not be called when head is stale');
    }
  });

  try {
    const result = await safePublishReview({
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      reviewedSha: 'old_reviewed_head_111111',
      reviewBody: 'Nice code',
      token: 'test-token',
      apiBase: mock.url
    });

    assert.equal(result.published, false);
    assert.equal(result.reason, 'stale_head');
  } finally {
    await mock.close();
  }
});

test('safePublishReview posts review when SHA matches', async () => {
  let postedBody = null;
  const mock = await createMockServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        number: 42,
        title: 'PR',
        base: { sha: 'base_sha' },
        head: { sha: 'match_sha_222222' }
      }));
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        postedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 987, html_url: 'https://github.com/owner/repo/pull/42#review-987' }));
      });
    }
  });

  try {
    const result = await safePublishReview({
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      reviewedSha: 'match_sha_222222',
      reviewBody: 'Everything looks good!',
      token: 'test-token',
      apiBase: mock.url
    });

    assert.equal(result.published, true);
    assert.equal(result.reviewId, 987);
    assert.equal(postedBody.event, 'COMMENT');
    assert.equal(postedBody.commit_id, 'match_sha_222222');
  } finally {
    await mock.close();
  }
});
