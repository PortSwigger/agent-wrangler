import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { boundedPs } from './bounded-ps.js';
import { procInfo } from './state-reader.js';
import { processTree } from './tmux-scraper.js';

// A ps that never exits and ignores SIGKILL, like one stuck in the kernel.
function hungSpawn() {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() { child.destroyed = true; } });
  child.kill = () => { child.killed = true; };
  child.unref = () => { child.unrefed = true; };
  return { child, spawn: () => child };
}

function fakeSpawn(stdout, code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', code); });
    return child;
  };
}

test('boundedPs: resolves null on timeout without waiting for the child to exit', async () => {
  const { child, spawn } = hungSpawn();
  const t0 = Date.now();
  assert.equal(await boundedPs(['-ax'], { timeoutMs: 20, spawn }), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(child.killed && child.unrefed && child.destroyed);
});

test('boundedPs: resolves stdout on success, null on non-zero exit or spawn error', async () => {
  assert.equal(await boundedPs([], { spawn: fakeSpawn('hi') }), 'hi');
  assert.equal(await boundedPs([], { spawn: fakeSpawn('x', 1) }), null);
  assert.equal(await boundedPs([], { spawn: () => { throw new Error('ENOENT'); } }), null);
});

test('procInfo: parses ps output; hung ps yields an empty map and warns once', async () => {
  const map = await procInfo({ spawn: fakeSpawn('  12 ttys003  1.5\n  13 ??  0.0\n') });
  assert.deepEqual(map.get(12), { tty: 'ttys003', cpu: 1.5 });
  assert.equal(map.get(13).tty, '??');

  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (let i = 0; i < 2; i++) {
      const { spawn } = hungSpawn();
      assert.equal((await procInfo({ timeoutMs: 10, spawn })).size, 0);
    }
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.filter((w) => w.includes('session tty scan skipped')).length, 1);
});

test('processTree: hung ps yields an empty tree', async () => {
  const { spawn } = hungSpawn();
  const tree = await processTree({ timeoutMs: 10, spawn });
  assert.equal(tree.children.size, 0);
  assert.equal(tree.cmd.size, 0);
});

test('processTree: builds the forest from ps output', async () => {
  const tree = await processTree({ spawn: fakeSpawn('  1 0 init\n  2 1 claude --x\n') });
  assert.deepEqual(tree.children.get(1), [2]);
  assert.equal(tree.cmd.get(2), 'claude --x');
});
