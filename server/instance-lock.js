import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';

// Exactly one wrangler may write a given DATA_DIR. Two instances sharing
// ~/.agent-wrangler each hold an independent in-memory TaskStore/SessionManager
// loaded once at startup, and each persists its WHOLE snapshot on every save
// (control actions, the PR poll's updateLinkStatus, reconcileSuspend,
// reconcileExitedSessions). A forgotten second instance therefore stamps its
// stale snapshot over tasks.json/mappings.json — which is why, after a restart,
// sessions reload unassigned and deleted tasks reappear. A different PORT does
// NOT isolate; only the data dir does. So we guard the data dir, not the port.
//
// The lock is a Unix-domain socket inside DATA_DIR whose liveness the kernel
// manages: a crashed holder's socket is freed automatically (no stale-PID
// guesswork), and a leftover socket FILE with no listener is reclaimed by
// probing it. The holder answers a probe with its own {pid, port} so a refused
// newcomer can name exactly which process to stop.
const LOCK_SOCK = path.join(DATA_DIR, 'instance.sock');

// connect() error codes that mean "no live listener here" → the socket file is
// stale and may be reclaimed. Anything else means someone IS listening (held),
// just with an identity we couldn't read.
export const STALE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

export class InstanceLockError extends Error {
  constructor(holder, dataDir = DATA_DIR) {
    const who = holder && holder.pid
      ? ` (held by PID ${holder.pid}${holder.port ? ` on port ${holder.port}` : ''})`
      : '';
    super(
      `agent-wrangler is already running against ${dataDir}${who}. `
      + 'Stop that instance first, or set AW_DATA_DIR to run a fully isolated one '
      + '(a different PORT alone does NOT isolate — it shares the same state dir).',
    );
    this.name = 'InstanceLockError';
    this.holder = holder || null;
  }
}

// Connect to an existing lock socket to learn who holds it. Resolves the holder
// ({pid, port}) when a live instance answers, or null when nothing is listening
// (a stale socket file). Never rejects: a listening-but-unreadable peer still
// counts as held (unknown identity), only a STALE_CONNECT_CODES error is "stale".
function probeHolder(sock) {
  return new Promise((resolve) => {
    let settled = false;
    const c = net.connect(sock);
    let buf = '';
    const finish = (val) => {
      if (settled) return;
      settled = true;
      c.removeAllListeners();
      c.destroy();
      resolve(val);
    };
    c.setTimeout(1000, () => finish({ pid: null, port: null })); // listening but slow → held
    c.on('data', (d) => { buf += d; });
    c.on('end', () => {
      try { finish(JSON.parse(buf)); } catch { finish({ pid: null, port: null }); }
    });
    c.on('error', (err) => finish(STALE_CONNECT_CODES.has(err.code) ? null : { pid: null, port: null }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acquire the per-DATA_DIR lock. Returns { release, sock } on success. Throws
// InstanceLockError when a live instance already holds the dir (caller should
// log the message and exit). Any OTHER failure (e.g. an unusually long socket
// path) degrades to a loud warning and an unlocked start rather than taking the
// dashboard down — the guard is a safety net, not a core feature, and a process
// that can't even create the socket can't be a duplicate writer anyway.
//
// `maxWaitMs` rides out a restart handoff: `launchctl kickstart -k` can start
// the replacement before the predecessor has fully released, so a live holder is
// re-probed for up to maxWaitMs before we declare a genuine duplicate — otherwise
// every -k restart would risk a spurious refuse-and-exit. A second instance that
// is actually meant to coexist still refuses, just maxWaitMs later.
export async function acquireInstanceLock({ port, sock = LOCK_SOCK, maxWaitMs = 3000, retryMs = 250 } = {}) {
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const guard = net.createServer((conn) => {
    conn.end(JSON.stringify({ pid: process.pid, port: port ?? null }));
  });
  guard.unref(); // the lock must never keep the process alive on its own

  const listen = () => new Promise((resolve, reject) => {
    const onError = (err) => { guard.removeListener('listening', onListening); reject(err); };
    const onListening = () => { guard.removeListener('error', onError); resolve(); };
    guard.once('error', onError);
    guard.once('listening', onListening);
    guard.listen(sock);
  });

  const release = () => {
    try { guard.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(sock); } catch { /* gone already */ }
  };

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await listen();
      break; // bound the socket — lock held
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        console.warn(`[agent-wrangler] instance lock unavailable (${err.code || err.message}); starting without it.`);
        return { release: () => {}, sock };
      }
      const holder = await probeHolder(sock);
      if (holder === null) {
        // Stale socket file (no listener) — reclaim it and retry immediately.
        try { fs.unlinkSync(sock); } catch { /* gone already */ }
        continue;
      }
      // A live instance answered. Give a restart handoff a moment to complete
      // before declaring a duplicate; once past the deadline it's a real conflict.
      if (Date.now() >= deadline) throw new InstanceLockError(holder);
      await sleep(retryMs);
    }
  }

  process.once('exit', release);
  return { release, sock };
}
