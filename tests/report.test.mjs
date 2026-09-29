import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, buildRunSummary, formatReviewComment } from '../src/report.mjs';

test('valid review passes validation', () => {
  const payload = {
    head_sha: 'abc1234567890abcdef',
    complete: true,
    summary: 'Everything inspected cleanly.',
    findings: [
      {
        severity: 'P1',
        title: 'Possible null dereference in parser',
        path: 'src/parser.mjs',
        line: 42,
        description: 'Variable may be undefined if header is absent',
        evidence: 'parser.mjs:42: data.header.value'
      }
    ],
    tests: [{ command: 'npm test', result: 'exited 0' }],
    limitations: []
  };

  const validated = validateReview(payload, 'abc1234567890abcdef');
  assert.equal(validated.head_sha, 'abc1234567890abcdef');
  assert.equal(validated.findings.length, 1);
});

test('rejects mismatched head SHA', () => {
  const payload = {
    head_sha: 'old_sha_123456',
    complete: true,
    summary: 'Reviewed',
    findings: []
  };

  assert.throws(
    () => validateReview(payload, 'new_sha_789012'),
    /Reviewed head_sha mismatch/
  );
});

test('rejects incomplete review', () => {
  const payload = {
    head_sha: 'abc1234567890abcdef',
    complete: false,
    summary: 'Timed out during execution',
    findings: []
  };

  assert.throws(
    () => validateReview(payload, 'abc1234567890abcdef'),
    /Review schema validation failed|complete flag is not true/
  );
});

test('rejects malformed finding missing required fields', () => {
  const payload = {
    head_sha: 'abc1234567890abcdef',
    complete: true,
    summary: 'Summary',
    findings: [
      {
        severity: 'P1'
        // missing title and description
      }
    ]
  };

  assert.throws(
    () => validateReview(payload, 'abc1234567890abcdef'),
    /Review schema validation failed/
  );
});

test('formats markdown comment correctly', () => {
  const review = {
    head_sha: '1234567890abcdef',
    complete: true,
    summary: 'LGTM with minor note.',
    findings: [
      {
        severity: 'P2',
        title: 'Missing timeout parameter',
        path: 'src/fetch.mjs',
        line: 12,
        description: 'Fetch call can hang indefinitely',
        evidence: 'fetch(url)'
      }
    ]
  };

  const md = formatReviewComment(review, { model: 'deepseek/deepseek-v4.1-flash' });
  assert.ok(md.includes('Docker + Modal PR Reviewer'));
  assert.ok(md.includes('[P2] Missing timeout parameter'));
  assert.ok(md.includes('`src/fetch.mjs:12`'));
});

test('buildRunSummary produces expected metrics structure', () => {
  const summary = buildRunSummary({
    repo: 'MooseGooseConsulting/coldaine-codeOps',
    pr: 201,
    headSha: 'abc1234567890',
    timings: {
      sandbox_start_seconds: 4.2,
      checkout_seconds: 1.5,
      review_seconds: 12.3,
      total_seconds: 18.0
    },
    findingsCount: 1,
    result: 'success'
  });

  assert.equal(summary.pr, 201);
  assert.equal(summary.result, 'success');
  assert.equal(summary.timings.sandbox_start_seconds, 4.2);
});
