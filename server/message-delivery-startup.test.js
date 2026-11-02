import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deliverMessage } from './message-delivery.js';
import { shellQuote } from './agents/claude.js';

const exec = promisify(execFile);
const actor = `import json, os, re, sys, termios, time, tty
agent, received, start = sys.argv[1:]
tty.setraw(0)
os.write(1, b'Loading session...\\r\\n')
while not os.path.exists(start):
    time.sleep(0.01)
time.sleep(1)
termios.tcflush(0, termios.TCIFLUSH)
prompt = '\\x1b[1m›\\x1b[0m \\x1b[2mAsk Codex to do anything\\x1b[0m' if agent == 'codex' else '\\x1b[0m❯\\u00a0'
working = '• Working (1s • esc to interrupt)' if agent == 'codex' else '✶ Climbing the T-Rex skeleton… (1s · ↓ 3 tokens)'
if agent == 'claude':
    prompt = '─' * 60 + '\\r\\n' + prompt + '\\r\\n' + '─' * 60
os.write(1, ('\\x1b[2J\\x1b[H\\x1b[?2004h' + prompt).encode())
text = b''
while True:
    char = os.read(0, 1)
    if char == b'\\r':
        message = re.sub(rb'\\x1b\\[20[01]~', b'', text).decode()
        with open(received, 'a') as out:
            out.write(json.dumps(message) + '\\n')
        os.write(1, ('\\r\\n' + working + '\\r\\n' + prompt).encode())
        text = b''
    else:
        text += char
`;

for (const agent of ['codex', 'claude']) {
  test(`${agent}: a live terminal drops early input during restore; delivery waits for its composer`, { timeout: 15000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-startup-delivery-'));
    const socket = `aw-startup-${crypto.randomBytes(4).toString('hex')}`;
    const name = 'loading';
    const script = path.join(dir, 'actor.py');
    const receipt = path.join(dir, 'received.jsonl');
    const start = path.join(dir, 'start');
    const message = `startup-${agent}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(script, actor);
    const command = ['python3', '-u', script, agent, receipt, start].map(shellQuote).join(' ');
    try {
      await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', name, '-x', '120', '-y', '24', command]);
      const deadline = Date.now() + 3000;
      for (;;) {
        const { stdout } = await exec('tmux', ['-L', socket, 'capture-pane', '-p', '-t', name]);
        if (stdout.includes('Loading session')) break;
        assert.ok(Date.now() < deadline, 'terminal did not enter its loading state');
        await new Promise((r) => setTimeout(r, 25));
      }
      fs.writeFileSync(start, '');
      const result = await deliverMessage('CARD', message, {
        tmuxFor: () => name,
        socketFor: () => socket,
        sessionManager: { entryFor: () => ({ agent, relaunchedAt: Date.now() }) },
      });
      assert.deepEqual(result, { mode: 'live' });
      await new Promise((r) => setTimeout(r, 1100));
      const messages = fs.existsSync(receipt)
        ? fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      assert.deepEqual(messages, [message], 'the terminal must receive the prompt exactly once');
    } finally {
      await exec('tmux', ['-L', socket, 'kill-server']).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
