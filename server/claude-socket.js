import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Client for Claude Code's per-session cross-session messaging socket (2.1.301+).
// Each live session publishes `~/.claude/sessions/<pid>.json` carrying its
// `messagingSocketPath`, plus a sibling `<pid>.<hash>.key` holding the token a
// peer must present first. The wire format is newline-delimited JSON: an `auth`
// line, then a `user` line. The key is a credential: it is read here and written
// to the socket, never returned, logged or put in an error message.
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const SEND_TIMEOUT_MS = 3000;
// A rejected auth/frame closes the connection; hold on briefly after the write
// so a refusal is an error instead of a silent success.
const SETTLE_MS = 250;

// The socket and key of the live Claude process for a conversation, or null
// when it has not published one (older Claude, messaging disabled, not running).
export function findClaudeSocket(liveSessionId, { sessionsDir = SESSIONS_DIR } = {}) {
  if (!liveSessionId) return null;
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch { return null; }
  for (const f of files) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (info?.sessionId !== liveSessionId || !info.messagingSocketPath) continue;
    const keyFile = files.find((k) => k.startsWith(`${m[1]}.`) && k.endsWith('.key'));
    return {
      socketPath: info.messagingSocketPath,
      keyPath: keyFile ? path.join(sessionsDir, keyFile) : null,
    };
  }
  return null;
}

// Hand `text` to the session as an inbound message. Resolves once it is written
// and the session has not refused it; rejects (never with the key) otherwise.
export function sendToClaudeSocket({ socketPath, keyPath }, text, { timeoutMs = SEND_TIMEOUT_MS, settleMs = SETTLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    let token;
    try { token = keyPath ? fs.readFileSync(keyPath, 'utf8').trim() : ''; } catch { return reject(new Error('socket key unreadable')); }
    const frames = [];
    if (token) frames.push({ type: 'auth', token });
    frames.push({ type: 'user', message: { role: 'user', content: text } });
    const sock = net.createConnection(socketPath);
    let done = false;
    let wrote = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('socket send timed out')), timeoutMs);
    sock.on('error', (err) => finish(new Error(`socket send failed: ${err.code || err.message}`)));
    sock.on('close', () => finish(wrote ? new Error('socket closed after send') : new Error('socket closed before send')));
    sock.on('connect', () => {
      sock.write(frames.map((f) => `${JSON.stringify(f)}\n`).join(''), (err) => {
        if (err) return finish(new Error('socket write failed'));
        wrote = true;
        setTimeout(() => finish(), settleMs);
      });
    });
  });
}
