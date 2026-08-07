import os from 'node:os';
import { Worker } from 'node:worker_threads';

// A tiny fixed-size worker pool, shared by the indexer and the query scanner.
//
// Workers are created lazily on first use and `unref`'d, so an idle board pays
// nothing for search and the pool can never hold the process open at shutdown.
// Jobs queue when every worker is busy; each worker handles one job at a time and
// replies with the job id it was given.

export const DEFAULT_POOL_SIZE = Math.max(1, Math.min(6, (os.cpus().length || 2) - 2));
// Searching is bursty — a flurry of keystrokes, then nothing for an hour. Holding
// threads (and their fds) open for the process lifetime for that is exactly the
// kind of idle cost this server works to give back, so an idle pool disbands and
// respawns on the next job. The delay is long enough that a whole typing session
// reuses one set of workers.
const IDLE_TEARDOWN_MS = 60_000;

export function createPool(moduleUrl, size = DEFAULT_POOL_SIZE) {
  const workers = [];
  const idle = [];
  const queue = [];
  const pending = new Map(); // job id -> { resolve, reject }
  let nextId = 1;
  let destroyed = false;

  function spawn() {
    const w = new Worker(new URL(moduleUrl, import.meta.url));
    w.unref();
    w.on('message', (msg) => {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      release(w);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.message || 'search worker failed'));
      else p.resolve(msg);
    });
    // A dead worker fails only its own in-flight job; the pool drops it and spawns
    // a replacement on the next job rather than wedging the queue.
    w.on('error', (err) => {
      for (const [id, p] of pending) {
        if (p.worker === w) { pending.delete(id); p.reject(err); }
      }
      const i = workers.indexOf(w);
      if (i >= 0) workers.splice(i, 1);
      const j = idle.indexOf(w);
      if (j >= 0) idle.splice(j, 1);
      pump();
    });
    workers.push(w);
    return w;
  }

  function release(w) {
    idle.push(w);
    pump();
    armIdleTeardown();
  }

  let idleTimer = null;
  function armIdleTeardown() {
    clearTimeout(idleTimer);
    if (queue.length || pending.size) return;
    idleTimer = setTimeout(() => {
      if (queue.length || pending.size) return;
      for (const w of workers.splice(0)) w.terminate().catch(() => {});
      idle.length = 0;
    }, IDLE_TEARDOWN_MS);
    idleTimer.unref?.();
  }

  function pump() {
    clearTimeout(idleTimer);
    while (queue.length) {
      let w = idle.pop();
      if (!w) {
        if (workers.length >= size) return;
        w = spawn();
      }
      const job = queue.shift();
      pending.set(job.id, job);
      job.worker = w;
      w.postMessage(job.payload, job.transfer || []);
    }
  }

  return {
    size,
    run(payload, transfer) {
      if (destroyed) return Promise.reject(new Error('pool destroyed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        queue.push({ id, payload: { ...payload, id }, transfer, resolve, reject });
        pump();
      });
    },
    async destroy() {
      destroyed = true;
      await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
      workers.length = 0;
      idle.length = 0;
    },
  };
}
