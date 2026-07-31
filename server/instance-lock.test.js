import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireInstanceLock, InstanceLockError, STALE_CONNECT_CODES } from './instance-lock.js';

// A unique socket path per test so they never collide, kept short enough for the
// macOS sun_path limit (os.tmpdir() + a 12-hex name stays well under 104 bytes).
function tmpSock() {
  return path.join(os.tmpdir(), `aw-lock-test-${crypto.randomBytes(6).toString('hex')}.sock`);
}

test('acquire creates the socket and release removes it', async () => {
  const sock = tmpSock();
  const lock = await acquireInstanceLock({ port: 1234, sock });
  assert.ok(fs.existsSync(sock), 'socket file exists while held');
  lock.release();
  assert.ok(!fs.existsSync(sock), 'release unlinks the socket');
});

test('a second acquire on the same dir refuses and names the holder', async () => {
  const sock = tmpSock();
  const first = await acquireInstanceLock({ port: 4321, sock });
  try {
    await assert.rejects(
      () => acquireInstanceLock({ port: 9999, sock, maxWaitMs: 0 }),
      (err) => {
        assert.ok(err instanceof InstanceLockError, 'is an InstanceLockError');
        assert.equal(err.holder.pid, process.pid, 'reports the live holder pid');
        assert.equal(err.holder.port, 4321, 'reports the live holder port');
        return true;
      },
    );
  } finally {
    first.release();
  }
});

test('a stale socket file (no listener) is reclaimed', async () => {
  const sock = tmpSock();
  fs.writeFileSync(sock, ''); // a leftover from a crashed instance: file present, nobody listening
  const lock = await acquireInstanceLock({ port: 7, sock });
  try {
    assert.ok(fs.existsSync(sock), 'reclaimed and now held');
    // Proof the lock is genuinely live: a fresh acquire must now refuse.
    await assert.rejects(() => acquireInstanceLock({ sock, maxWaitMs: 0 }), InstanceLockError);
  } finally {
    lock.release();
  }
});

test('a live holder that releases mid-wait lets a waiter acquire (restart handoff)', async () => {
  const sock = tmpSock();
  const holder = await acquireInstanceLock({ port: 1, sock });
  // The waiter finds the dir held, then the holder steps down (as a predecessor
  // does during a -k restart) — the waiter should ride it out and acquire, not refuse.
  const waiter = acquireInstanceLock({ port: 2, sock, maxWaitMs: 3000, retryMs: 50 });
  setTimeout(() => holder.release(), 200);
  const lock = await waiter;
  try {
    assert.ok(fs.existsSync(sock), 'waiter acquired after the handoff');
  } finally {
    lock.release();
  }
});

test('STALE_CONNECT_CODES covers the no-listener cases', () => {
  for (const code of ['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']) {
    assert.ok(STALE_CONNECT_CODES.has(code), `${code} is treated as stale`);
  }
});
