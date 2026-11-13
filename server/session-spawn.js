import { getExtensions } from './extensions/index.js';
import { logError } from './log.js';

export const SPAWN_HOOK_TIMEOUT_MS = 2_000;

async function callHook({ extId, fn }, name, payload, { hostApiFor, onError, timeoutMs }) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn({ ...payload, host: hostApiFor(extId) })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } catch (err) {
    onError(`[ext:${extId}] ${name} failed — skipped`, err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function options({ ext = getExtensions(), hostApiFor = () => undefined, onError = logError, timeoutMs = SPAWN_HOOK_TIMEOUT_MS } = {}) {
  return { ext, hostApiFor, onError, timeoutMs };
}

export async function collectBeforeSpawn(payload, deps) {
  const opts = options(deps);
  const data = new Map();
  for (const hook of opts.ext.hooks?.['session.beforeSpawn'] || []) {
    const out = await callHook(hook, 'session.beforeSpawn', payload, opts);
    if (out == null) continue;
    if (typeof out !== 'object' || Array.isArray(out)) {
      opts.onError(`[ext:${hook.extId}] session.beforeSpawn must return { refuse?, data? } — ignored`);
      continue;
    }
    if (typeof out.refuse === 'string' && out.refuse.trim()) throw new Error(out.refuse.trim());
    if (Object.hasOwn(out, 'data')) data.set(hook.extId, out.data);
  }
  return data;
}

export async function notifySpawned(payload, data, deps) {
  const opts = options(deps);
  for (const hook of opts.ext.hooks?.['session.spawned'] || []) {
    await callHook(hook, 'session.spawned', { ...payload, data: data?.get(hook.extId) }, opts);
  }
}
