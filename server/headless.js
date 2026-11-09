import os from 'node:os';
import { execFile as defaultExecFile } from 'node:child_process';
import { adapterFor, registeredAgents, effortError } from './agents/index.js';
import { backgroundModelConfig } from './config-store.js';

// A tool-less, one-shot model call for the wrangler's own small jobs (archive
// memory review) and for extensions (`host.agents.headless`, capability
// `agents:headless`). Any adapter with a `headless` capability can run one:
//
//   headless.defaultModel()  — the model a call naming only this agent runs.
//   headless.command({ prompt, model, effort, env, cwd })
//                            → { file, args, env, liveSessionId? }: the binary and
//                              argv for one run with every tool off. A
//                              liveSessionId fixed at launch is returned here.
//   headless.parse(stdout)   → { text, liveSessionId?, error? }: the answer, and
//                              the conversation id when the CLI only reports it
//                              in its output. May throw on unparseable output.
//
// The payload always goes on stdin (no argv limit, no quoting) through
// execFile, never a shell. The run's conversation is kept on disk so a caller
// can bill it to a card (session-manager recordPriorLiveSessionId) and the
// usage scan prices it with the agent's own scanner.

export const HEADLESS_TIMEOUT_MS = 120000;
// Upper bound on a caller's timeoutMs: a one-shot that runs longer is not one.
export const HEADLESS_MAX_TIMEOUT_MS = 600000;

let headlessInFlight = 0;

// Counted so the self-updater never restarts the server under a running call.
export function headlessRunsInFlight() {
  return headlessInFlight;
}

// The Background model when Settings names none: the first registered agent
// with a headless capability, at that capability's default (Claude Haiku).
export function defaultBackgroundModel(adapters = registeredAgents()) {
  const adapter = adapters.find((a) => a.headless);
  return adapter ? { agent: adapter.id, model: adapter.headless.defaultModel() } : null;
}

// Settings › Automation › Background model: what a headless run uses when the
// caller names no model. A stored agent that is gone or cannot run headless,
// or a model it no longer lists, falls back to the default rather than failing
// every background job.
export function backgroundModel({ cfg, adapters = registeredAgents() } = {}) {
  const stored = backgroundModelConfig(cfg);
  const adapter = stored && adapters.find((a) => a.id === stored.agent && a.headless);
  if (adapter && adapter.models.some((m) => m.value === stored.model)) return { agent: adapter.id, model: stored.model };
  return defaultBackgroundModel(adapters);
}

// Which agent and model a call runs on. With neither named it is the
// Background model; an agent alone runs the Background model when it is that
// agent, else the agent's own headless default; a model alone belongs to the
// Background agent. Throws a TypeError for anything that cannot run, so a
// caller's mistake surfaces instead of a silent fallback to another model.
export function resolveHeadlessTarget({ agent, model, effort } = {}, { background = backgroundModel(), resolve = adapterFor } = {}) {
  const id = agent ?? background?.agent;
  let adapter;
  try { adapter = resolve(id); } catch (err) { throw new TypeError(err.message); }
  if (!adapter.headless) throw new TypeError(`Agent "${adapter.id}" has no headless mode.`);
  const value = model || (background?.agent === adapter.id ? background.model : adapter.headless.defaultModel());
  if (!adapter.models.some((m) => m.value === value)) {
    throw new TypeError(`Unknown model "${value}" for agent "${adapter.id}". Valid models: ${adapter.models.map((m) => m.value).join(', ')}.`);
  }
  const badEffort = effortError(adapter.id, effort, value, () => adapter);
  if (badEffort) throw new TypeError(badEffort);
  return { adapter, agent: adapter.id, model: value, effort: effort || null };
}

function timeoutFor(timeoutMs) {
  if (timeoutMs == null) return HEADLESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number of milliseconds');
  return Math.min(timeoutMs, HEADLESS_MAX_TIMEOUT_MS);
}

// Resolves { text, liveSessionId, agent, model, error }. A failed run (the CLI
// exits non-zero, times out, or prints output that does not parse) RESOLVES
// with `error` set and `text` null: callers are best-effort background work,
// and a rejection would become an unhandled one in their fire-and-forget
// paths. `liveSessionId` is still set whenever the run got far enough to
// start a conversation, because that conversation already spent tokens.
// Rejects only for a bad call (no prompt, an unknown agent or model).
export async function runHeadless({
  prompt,
  stdin = '',
  agent,
  model,
  effort,
  timeoutMs,
  env = {},
  execFile = defaultExecFile,
  background,
  resolve,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt must be a non-empty string');
  if (typeof stdin !== 'string') throw new TypeError('stdin must be a string');
  const timeout = timeoutFor(timeoutMs);
  const target = resolveHeadlessTarget({ agent, model, effort }, {
    ...(background === undefined ? {} : { background }),
    ...(resolve ? { resolve } : {}),
  });
  const cwd = os.tmpdir();
  const cmd = target.adapter.headless.command({ prompt, model: target.model, effort: target.effort, env, cwd });
  headlessInFlight += 1;
  try {
    return await new Promise((done) => {
      const child = execFile(cmd.file, cmd.args, { cwd, env: cmd.env, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        let parsed = {};
        let error = err || null;
        try {
          parsed = target.adapter.headless.parse(String(stdout ?? '')) || {};
        } catch (parseErr) {
          error ||= parseErr;
        }
        if (!error && parsed.error) error = new Error(parsed.error);
        done({
          text: error ? null : (parsed.text ?? null),
          liveSessionId: cmd.liveSessionId ?? parsed.liveSessionId ?? null,
          agent: target.agent,
          model: target.model,
          error,
        });
      });
      child.stdin.end(stdin);
    });
  } finally {
    headlessInFlight -= 1;
  }
}
