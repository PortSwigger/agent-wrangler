import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export class RestartPendingError extends Error {
  constructor() {
    super('The wrangler is preparing to restart. Retry this request shortly.');
    this.code = 'restarting';
    this.retryable = true;
  }
}

export function createRestartBarrier({ timeoutMs = 30000, settleMs = 250, exit = () => process.exit(0), onStatus = () => {}, isIdle = () => true } = {}) {
  const scope = new AsyncLocalStorage();
  let inFlight = 0;
  let closed = false;
  let status = null;
  let restarting = null;
  let afterRestart = exit;

  function publish(phase, reason, message) {
    status = { phase, reason, message };
    onStatus(status);
  }

  function run(fn) {
    if (closed && !scope.getStore()?.active) throw new RestartPendingError();
    const token = { active: true };
    inFlight += 1;
    const release = () => { token.active = false; inFlight -= 1; };
    return scope.run(token, () => {
      let out;
      try { out = fn(); } catch (err) { release(); throw err; }
      if (out && typeof out.then === 'function') return Promise.resolve(out).finally(release);
      release();
      return out;
    });
  }

  function request(reason, afterDrain = null) {
    if (afterDrain) afterRestart = afterDrain;
    if (restarting) return restarting;
    closed = true;
    publish('draining', reason, 'Waiting for in-flight requests and writes before restarting…');
    restarting = (async () => {
      // Always yield: the request that asked for this restart must return first.
      const deadline = Date.now() + timeoutMs;
      do {
        await delay(10);
        if (inFlight === 0 && isIdle()) {
          publish('restarting', reason, 'Restarting…');
          await delay(settleMs);
          afterRestart(reason);
          return true;
        }
      } while (Date.now() < deadline);
      if (afterRestart !== exit) {
        afterRestart(reason);
        return true;
      }
      closed = false;
      restarting = null;
      publish('pending', reason, 'Restart pending: requests or writes are still running. Retry when they finish.');
      return false;
    })();
    return restarting;
  }

  function http(handler) {
    return async (req, res, ...args) => {
      try {
        await run(async () => {
          const responded = new Promise((resolve) => {
            res.once('finish', resolve);
            res.once('close', resolve);
          });
          await handler(req, res, ...args);
          await responded;
        });
      } catch (err) {
        if (res.headersSent || res.destroyed) return;
        req.resume();
        const retryable = err instanceof RestartPendingError;
        res.writeHead(retryable ? 503 : 500, { 'Content-Type': 'application/json', ...(retryable ? { 'Retry-After': '1' } : {}) });
        res.end(JSON.stringify({ error: retryable ? err.code : 'internal-error', message: err.message, retryable }));
      }
    };
  }

  function wrapStore(store) {
    const methods = new Map();
    return new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (!methods.has(key) || methods.get(key).value !== value) {
          methods.set(key, { value, wrapped: (...args) => run(() => value.apply(target, args)) });
        }
        return methods.get(key).wrapped;
      },
    });
  }

  return { run, request, http, wrapStore, inFlight: () => inFlight, accepting: () => !closed || Boolean(scope.getStore()?.active), draining: () => closed, status: () => status };
}

export function restartIsQuiet({ barrier, headless = 0, launching = false, due = [], sessions = [] }) {
  return barrier.inFlight() === 0 && !barrier.draining() && headless === 0 && !launching && due.length === 0
    && !sessions.some((s) => s.status === 'working');
}
