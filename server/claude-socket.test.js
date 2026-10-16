import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findClaudeSocket, sendToClaudeSocket } from './claude-socket.js';

function tmpDir() {
  // Unix socket paths top out near 104 bytes, so keep this short.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
}

function listen(sockPath, onLines) {
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) onLines(JSON.parse(l), c);
    });
  });
  return new Promise((r) => server.listen(sockPath, () => r(server)));
}

test('findClaudeSocket maps a live session id to its socket and key file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '10.json'), JSON.stringify({ sessionId: 'OTHER', messagingSocketPath: '/x/10.sock' }));
  fs.writeFileSync(path.join(dir, '11.json'), JSON.stringify({ sessionId: 'LIVE', messagingSocketPath: '/x/11.sock' }));
  fs.writeFileSync(path.join(dir, '11.abc123.key'), 'k');
  assert.deepEqual(findClaudeSocket('LIVE', { sessionsDir: dir }), { socketPath: '/x/11.sock', keyPath: path.join(dir, '11.abc123.key') });
  assert.equal(findClaudeSocket('MISSING', { sessionsDir: dir }), null);
  assert.equal(findClaudeSocket('', { sessionsDir: dir }), null);
});

test('findClaudeSocket is null for a session with no published socket or no directory', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '12.json'), JSON.stringify({ sessionId: 'LIVE' }));
  assert.equal(findClaudeSocket('LIVE', { sessionsDir: dir }), null);
  assert.equal(findClaudeSocket('LIVE', { sessionsDir: path.join(dir, 'nope') }), null);
});

test('sendToClaudeSocket writes the auth line then the user message', async () => {
  const dir = tmpDir();
  const sockPath = path.join(dir, 's.sock');
  const keyPath = path.join(dir, 'k.key');
  fs.writeFileSync(keyPath, 'SECRET-TOKEN\n');
  const seen = [];
  const server = await listen(sockPath, (f) => seen.push(f));
  try {
    await sendToClaudeSocket({ socketPath: sockPath, keyPath }, 'hello', { settleMs: 20 });
  } finally { server.close(); }
  assert.deepEqual(seen, [
    { type: 'auth', token: 'SECRET-TOKEN' },
    { type: 'user', message: { role: 'user', content: 'hello' } },
  ]);
});

test('sendToClaudeSocket rejects when the session closes on us, without leaking the key', async () => {
  const dir = tmpDir();
  const sockPath = path.join(dir, 's.sock');
  const keyPath = path.join(dir, 'k.key');
  fs.writeFileSync(keyPath, 'SECRET-TOKEN');
  const server = await listen(sockPath, (_f, c) => c.destroy());
  try {
    await assert.rejects(
      sendToClaudeSocket({ socketPath: sockPath, keyPath }, 'hello', { settleMs: 200 }),
      (err) => !String(err.message).includes('SECRET-TOKEN'),
    );
  } finally { server.close(); }
});

test('sendToClaudeSocket rejects when nothing is listening or the key is unreadable', async () => {
  const dir = tmpDir();
  await assert.rejects(sendToClaudeSocket({ socketPath: path.join(dir, 'gone.sock'), keyPath: null }, 'hi'), /socket send failed/);
  await assert.rejects(sendToClaudeSocket({ socketPath: path.join(dir, 'gone.sock'), keyPath: path.join(dir, 'no.key') }, 'hi'), /key unreadable/);
});
