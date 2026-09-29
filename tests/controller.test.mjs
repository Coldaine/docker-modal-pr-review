import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/controller.mjs';

test('parseCliArgs parses all flags correctly', () => {
  const argv = [
    'node',
    'src/controller.mjs',
    '--pr', '201',
    '--repo', 'MooseGooseConsulting/coldaine-codeOps',
    '--mode', 'prepare-only',
    '--publish', 'true',
    '--force', 'true',
    '--output-dir', './custom-output'
  ];

  const parsed = parseCliArgs(argv);
  assert.equal(parsed.pr, '201');
  assert.equal(parsed.repo, 'MooseGooseConsulting/coldaine-codeOps');
  assert.equal(parsed.mode, 'prepare-only');
  assert.equal(parsed.publish, true);
  assert.equal(parsed.force, true);
  assert.ok(parsed.outputDir.includes('custom-output'));
});

test('parseCliArgs defaults publish and force to false', () => {
  const argv = ['node', 'src/controller.mjs', '--pr', '100'];
  const parsed = parseCliArgs(argv);
  assert.equal(parsed.pr, '100');
  assert.equal(parsed.publish, false);
  assert.equal(parsed.force, false);
  assert.equal(parsed.mode, 'review');
});
