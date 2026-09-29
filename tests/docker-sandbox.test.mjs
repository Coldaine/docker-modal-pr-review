import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, readSandboxFile, writeSandboxFile, verifySandboxReadiness, cleanupSandbox } from '../src/docker-sandbox.mjs';

function createMockSandbox() {
  const fileStore = new Map();
  let deleted = false;

  return {
    processes: {
      run: async ({ args }) => {
        if (args[0] === 'git' || args[0] === 'python3' || args[0] === 'opencode') {
          return { exitCode: 0, stdout: `${args[0]} version 1.0.0\n`, stderr: '' };
        }
        if (args[0] === 'fail') {
          return { exitCode: 1, stdout: '', stderr: 'command failed' };
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
    },
    files: {
      read: async (path) => {
        if (!fileStore.has(path)) throw new Error(`File not found: ${path}`);
        return fileStore.get(path);
      },
      write: async (path, content) => {
        fileStore.set(path, content);
      }
    },
    delete: async () => {
      deleted = true;
      return {
        waitUntilDeleted: async () => {}
      };
    },
    isDeleted: () => deleted
  };
}

test('runProcess returns formatted exit result', async () => {
  const sbx = createMockSandbox();
  const res = await runProcess(sbx, ['git', '--version']);
  assert.equal(res.success, true);
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.includes('git version'));
});

test('file read and write operations work correctly', async () => {
  const sbx = createMockSandbox();
  await writeSandboxFile(sbx, '/workspace/review.json', '{"complete": true}');
  const content = await readSandboxFile(sbx, '/workspace/review.json');
  assert.equal(content, '{"complete": true}');
});

test('verifySandboxReadiness detects installed tools', async () => {
  const sbx = createMockSandbox();
  const readiness = await verifySandboxReadiness(sbx);
  assert.equal(readiness.allReady, true);
  assert.equal(readiness.details.git.ok, true);
  assert.equal(readiness.details.python3.ok, true);
  assert.equal(readiness.details.opencode.ok, true);
});

test('cleanupSandbox cleanly deletes sandbox without throwing', async () => {
  const sbx = createMockSandbox();
  let clientClosed = false;
  const mockClient = { close: async () => { clientClosed = true; } };

  await cleanupSandbox(sbx, mockClient);
  assert.equal(sbx.isDeleted(), true);
  assert.equal(clientClosed, true);
});
