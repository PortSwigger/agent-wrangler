import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { attachPtyChannel } from './pty-channel.js';
import { resolveTmuxBin } from './tmux-resolve.js';

const exec = promisify(execFile);

// Real tmux servers on throwaway sockets (never a live board's), a real node-pty
// attach, and a stand-in for the /pty WebSocket. tmuxBin is a shim that logs each
// tmux invocation and then runs the real one, so a test sees exactly what an attach
// asked of which server; it can also hold `show` back, as a busy tmux would. The
// shim ignores the SIGTERM of the ask's timeout: on a loaded machine an ask can
// outlast it, and the retry that follows would read here as a second ask.

// An OSC 8 hyperlink as tmux forwards it to a client whose terminal advertises the
// `hyperlinks` feature. Without the feature tmux drops the escape, and the link
// arrives as inert text.
const OSC8_LINK = /\x1b\]8;[^;\x07\x1b]*;https:\/\/example\.com\/osc8/;

class FakeWs extends EventEmitter {
  readyState = 1;
  output = '';
  send(data) { this.output += data.toString(); }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() { this.close(); }
}

async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(t, { showDelay = 0 } = {}) {
  const tmux = await resolveTmuxBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'));
  const log = path.join(dir, 'calls.log');
  const failNext = path.join(dir, 'fail-next-show');
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    "trap '' TERM",
    `printf '%s\\n' "$*" >> '${log}'`,
    'case " $* " in *" show "*)',
    `  sleep ${showDelay}`,
    `  if [ -e '${failNext}' ]; then rm -f '${failNext}'; exit 1; fi;;`,
    'esac',
    `exec '${tmux}' "$@"`,
  ].join('\n'), { mode: 0o755 });
  // The pane prints an OSC 8 link for every line it reads.
  const printer = path.join(dir, 'print-link');
  fs.writeFileSync(printer, String.raw`#!/bin/sh
while read -r _; do printf '\033]8;;https://example.com/osc8\033\\example link\033]8;;\033\\\n'; done
`, { mode: 0o755 });

  const sockets = [];
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.close();
    for (const s of sockets) {
      await exec(tmux, ['-L', s, 'kill-server']).catch(() => {});
      // tmux leaves its socket file behind.
      fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, s), { force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = (socket, ...args) => exec(tmux, ['-L', socket, ...args]).then((r) => r.stdout);
  return {
    run,
    async startServer(socket = `aw-pty-test-${crypto.randomBytes(4).toString('hex')}`) {
      if (!sockets.includes(socket)) sockets.push(socket);
      // No config file, so a user's tmux.conf can't have advertised hyperlinks already.
      await run(socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24', printer);
      return socket;
    },
    attach(socket) {
      const ws = new FakeWs();
      clients.push(ws);
      const done = attachPtyChannel(ws, { url: '/pty?sessionId=card&cols=80&rows=24' }, {
        sessionManager: { tmuxBin: bin, entryFor: () => null },
        tmuxFor: () => 'main',
        socketFor: () => socket,
        sessionFromGraph: () => ({ cwd: dir }),
      });
      return { ws, done };
    },
    // The tmux commands the attaches ran against `socket`, e.g. calls(s, 'show').
    calls(socket, command) {
      const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
      return lines.filter((l) => l.startsWith(`-L ${socket} ${command} `));
    },
    failNextShow: () => fs.writeFileSync(failNext, ''),
    clientCount: async (socket) => (await run(socket, 'list-clients')).split('\n').filter(Boolean).length,
  };
}

test('attach never waits on tmux synchronously: the event loop runs on while tmux takes a second to answer', async (t) => {
  const tmux = await setup(t, { showDelay: 1 });
  const socket = await tmux.startServer();

  let longestStall = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    longestStall = Math.max(longestStall, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  const { ws, done } = tmux.attach(socket);
  const heldFor = performance.now() - started;
  await done;
  const attachedAfter = performance.now() - started;
  clearInterval(ticker);

  // A synchronous ask would hold the thread for the whole second.
  assert.ok(heldFor < 250, `attachPtyChannel held the event loop for ${Math.round(heldFor)}ms`);
  assert.ok(longestStall < 500, `the event loop stalled for ${Math.round(longestStall)}ms`);
  // The attach itself waited for the answer, so the feature is on before the client is.
  assert.ok(attachedAfter >= 900, `attached after ${Math.round(attachedAfter)}ms, before tmux answered`);
  assert.match(await tmux.run(socket, 'show', '-s', 'terminal-features'), /hyperlinks/);
  ws.emit('message', Buffer.from('\r'));
  await until(() => OSC8_LINK.test(ws.output), 'an OSC 8 link to reach the attached client');
});

test('each tmux server is asked about hyperlinks once, however many terminals attach to it', async (t) => {
  const tmux = await setup(t, { showDelay: 0.2 });
  const a = await tmux.startServer();
  const b = await tmux.startServer();

  // Three at once share the one ask in flight; later ones find it answered.
  await Promise.all([tmux.attach(a), tmux.attach(a), tmux.attach(a)].map((x) => x.done));
  await Promise.all([tmux.attach(a), tmux.attach(b), tmux.attach(a), tmux.attach(b)].map((x) => x.done));

  await until(async () => (await tmux.clientCount(a)) === 5 && (await tmux.clientCount(b)) === 2,
    'all seven terminals to attach');
  for (const socket of [a, b]) {
    assert.equal(tmux.calls(socket, 'show').length, 1, `${socket} asked once`);
    assert.equal(tmux.calls(socket, 'set').length, 1, `${socket} set once`);
    const features = await tmux.run(socket, 'show', '-s', 'terminal-features');
    assert.equal(features.match(/hyperlinks/g)?.length, 1, `one hyperlinks entry on ${socket}`);
  }
});

test('a tmux server restarted on the same socket is asked again, and its terminals keep their links', async (t) => {
  const tmux = await setup(t);
  const socket = await tmux.startServer();
  await tmux.attach(socket).done;
  assert.equal(tmux.calls(socket, 'show').length, 1);

  await tmux.run(socket, 'kill-server');
  await tmux.startServer(socket);
  assert.doesNotMatch(await tmux.run(socket, 'show', '-s', 'terminal-features'), /hyperlinks/);
  const { ws, done } = tmux.attach(socket);
  await done;
  await tmux.attach(socket).done;

  assert.equal(tmux.calls(socket, 'show').length, 2, 'the new server was asked once more');
  ws.emit('message', Buffer.from('\r'));
  await until(() => OSC8_LINK.test(ws.output), 'an OSC 8 link from the restarted server');
});

test('a failed ask still lets the terminal attach, and the next attach asks again', async (t) => {
  const tmux = await setup(t);
  const socket = await tmux.startServer();
  tmux.failNextShow();
  await tmux.attach(socket).done;
  await until(async () => (await tmux.clientCount(socket)) === 1, 'the first client to attach');

  await tmux.attach(socket).done;
  assert.equal(tmux.calls(socket, 'show').length, 2);
  assert.match(await tmux.run(socket, 'show', '-s', 'terminal-features'), /hyperlinks/);
});

test('a client that leaves while tmux is answering never gets a tmux attach', async (t) => {
  const tmux = await setup(t, { showDelay: 0.5 });
  const socket = await tmux.startServer();
  const { ws, done } = tmux.attach(socket);
  ws.close();
  await done;
  // Give a stray attach time to start and connect before declaring there is none.
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(tmux.calls(socket, 'show').length, 1);
  assert.equal(tmux.calls(socket, 'attach').length, 0);
  assert.equal(await tmux.clientCount(socket), 0);
});

test('what the client sends while tmux is answering reaches the pane once attached', async (t) => {
  const tmux = await setup(t, { showDelay: 0.5 });
  const socket = await tmux.startServer();
  const { ws, done } = tmux.attach(socket);
  // What the board sends on open: its real size, then (here) an Enter for the pane.
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })));
  ws.emit('message', Buffer.from('\r'));
  await done;

  await until(() => OSC8_LINK.test(ws.output), 'the link the early Enter prints to reach the client');
  await until(async () => (await tmux.run(socket, 'list-clients', '-F', '#{client_width}x#{client_height}')).trim() === '100x30',
    'the early resize to reach the client');
});
