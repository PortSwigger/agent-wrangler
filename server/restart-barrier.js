import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export class RestartPendingError extends Error {
  constructor() {
    super('The wrangler is preparing to restart. Retry this request shortly.');
    this.code = 'restarting';
    this.retryable = true;
  }
}

// "45s", "7m", "2h5m": short enough to list several in one status line.
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

export function createRestartBarrier({ timeoutMs = 30000, settleMs = 250, exit = () => process.exit(0), onStatus = () => {}, isIdle = () => true, isHeld = () => false, holdPollMs = 250, log = () => {}, now = Date.now } = {}) {
  const scope = new AsyncLocalStorage();
  // One entry per admitted run(), removed on every exit path, so a drain that
  // times out can say WHAT it was waiting for instead of a bare count.
  const ops = new Set();
  let closed = false;
  let status = null;
  let restarting = null;
  let afterRestart = exit;
  let forced = false;

  function publish(phase, reason, message, extra = {}) {
    status = { phase, reason, message, ...extra };
    onStatus(status);
  }

  function outstanding() {
    const at = now();
    return [...ops].map(({ label, startedAt }) => ({ label, startedAt, ageMs: at - startedAt }))
      .sort((a, b) => b.ageMs - a.ageMs);
  }

  const describe = (list) => (list.length
    ? list.map(({ label, ageMs }) => `${label} (${formatAge(ageMs)})`).join(', ')
    : 'background work reported busy');

  function run(fn, label = 'unlabelled') {
    if (closed && !scope.getStore()?.active) throw new RestartPendingError();
    const token = { active: true };
    const op = { label, startedAt: now() };
    ops.add(op);
    const release = () => { token.active = false; ops.delete(op); };
    return scope.run(token, () => {
      let out;
      try { out = fn(); } catch (err) { release(); throw err; }
      if (out && typeof out.then === 'function') return Promise.resolve(out).finally(release);
      release();
      return out;
    });
  }

  // `force` is for a restart a human explicitly asked for (the board's Restart
  // button, an extension update's "Restart now"): after the full drain timeout it
  // exits anyway, naming what it cut short. Without it a timed-out drain gives up
  // and reopens, which is what unattended callers (auto-update) want: nobody chose
  // to interrupt the work still running, so it must not be killed for them.
  // `afterDrain` (the SIGTERM path) replaces the exit and always runs.
  function request(reason, { afterDrain = null, force = false } = {}) {
    if (afterDrain) afterRestart = afterDrain;
    if (force) forced = true;
    if (restarting) return restarting;
    restarting = (async () => {
      // An unattended restart first waits, still accepting work, for the human
      // to close any dialog they have open on a board: a reload there would
      // throw away what they were typing. isHeld() drops a tab's dialogs when it
      // disconnects, so a closed tab cannot hold this forever. A forced restart,
      // or one asked for mid-hold, skips it; so does a signal (afterDrain).
      if (isHeld() && !forced && afterRestart === exit) {
        publish('held', reason, 'Restart waiting for an open dialog to close…');
        while (isHeld() && !forced && afterRestart === exit) await delay(holdPollMs);
      }
      closed = true;
      publish('draining', reason, 'Waiting for in-flight requests and writes before restarting…');
      // Always yield: the request that asked for this restart must return first.
      const deadline = now() + timeoutMs;
      do {
        await delay(10);
        if (ops.size === 0 && isIdle()) {
          publish('restarting', reason, 'Restarting…');
          await delay(settleMs);
          afterRestart(reason);
          return true;
        }
      } while (now() < deadline);
      const left = outstanding();
      for (const { label, ageMs } of left) log(`[restart] still running after ${formatAge(timeoutMs)} drain: ${label} (${formatAge(ageMs)})`);
      const running = left.map(({ label, ageMs }) => ({ label, ageMs }));
      if (forced || afterRestart !== exit) {
        publish('restarting', reason, `Forcing restart; still running: ${describe(left)}`, { running });
        afterRestart(reason);
        return true;
      }
      closed = false;
      restarting = null;
      publish('pending', reason, `Restart pending: ${describe(left)}`, { running });
      return false;
    })();
    return restarting;
  }

  // `label` defaults to the request path, so a stuck request names its route.
  // `track: false` admits the request (still 503 while draining) without
  // holding a restart: for a connection that can stay open idle for as long as
  // its client likes, whose real work, if any, is tracked by its own run().
  function http(handler, label = null, { track = true } = {}) {
    return async (req, res, ...args) => {
      try {
        const serve = async () => {
          const responded = new Promise((resolve) => {
            res.once('finish', resolve);
            res.once('close', resolve);
          });
          await handler(req, res, ...args);
          await responded;
        };
        if (track) await run(serve, label ?? `http:${String(req.url || '').split('?')[0]}`);
        else if (closed && !scope.getStore()?.active) throw new RestartPendingError();
        else await serve();
      } catch (err) {
        if (res.headersSent || res.destroyed) return;
        req.resume();
        const retryable = err instanceof RestartPendingError;
        res.writeHead(retryable ? 503 : 500, { 'Content-Type': 'application/json', ...(retryable ? { 'Retry-After': '1' } : {}) });
        res.end(JSON.stringify({ error: retryable ? err.code : 'internal-error', message: err.message, retryable }));
      }
    };
  }

  function wrapStore(store, prefix = 'store') {
    const methods = new Map();
    return new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (!methods.has(key) || methods.get(key).value !== value) {
          methods.set(key, { value, wrapped: (...args) => run(() => value.apply(target, args), `${prefix}.${String(key)}`) });
        }
        return methods.get(key).wrapped;
      },
    });
  }

  return { run, request, http, wrapStore, inFlight: () => ops.size, outstanding, accepting: () => !closed || Boolean(scope.getStore()?.active), draining: () => closed, status: () => status };
}

export function restartIsQuiet({ barrier, headless = 0, launching = false, due = [], sessions = [] }) {
  return barrier.inFlight() === 0 && !barrier.draining() && headless === 0 && !launching && due.length === 0
    && !sessions.some((s) => s.status === 'working');
}

// A board's `{type:'dialogs', open:n}` frame: how many dialogs it has open.
// Returns n (clamped to 0..50), or null when the frame is anything else.
export function dialogsFrame(raw) {
  const text = raw.toString();
  if (!text.includes('"dialogs"')) return null;
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  if (msg?.type !== 'dialogs') return null;
  const n = Math.floor(Number(msg.open));
  return Number.isFinite(n) ? Math.min(50, Math.max(0, n)) : 0;
}
