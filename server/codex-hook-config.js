import { createHash } from 'node:crypto';
import { tomlString } from './codex-notify-config.js';

// The PR model footer's PostToolUse hook for Codex, as `-c` overrides. Codex
// (0.165, `hooks` feature) runs a hook only once it is trusted, and asks the
// user to review an untrusted one. Trust is a `hooks.state."<key>".trusted_hash`
// entry, read from the user config AND from `-c` session flags, so the hook and
// its trust both ride the launch command and nothing is written to
// ~/.codex/config.toml.
//
// The key and hash follow codex-rs/hooks (engine/discovery.rs): the key is
// `<source path>:<event>:<group index>:<handler index>`, where a `-c` hook's
// source path is the synthetic `/<session-flags>/config.toml`; the hash is
// sha256 over the key-sorted JSON of the normalized hook (its event label, the
// matcher and the one handler with its timeout filled in). Get either wrong and
// Codex shows its review prompt instead of running the hook.

const SESSION_FLAGS_SOURCE = '/<session-flags>/config.toml';
const EVENT = 'post_tool_use';
// Codex reports its shell tool to hooks as `Bash`, as Claude does.
const MATCHER = 'Bash';
const TIMEOUT_SEC = 10;

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// async: Codex starts the hook and carries on, so it never delays a tool result.
function handler(command) {
  return { type: 'command', command, timeout: TIMEOUT_SEC, async: true };
}

export function hookTrustKey() {
  return `${SESSION_FLAGS_SOURCE}:${EVENT}:0:0`;
}

export function hookTrustHash(command) {
  const identity = { event_name: EVENT, matcher: MATCHER, hooks: [handler(command)] };
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex')}`;
}

// The two `-c` values: the hook itself, and its trust. `hooks.state` is set as
// an inline table because Codex splits a dotted `-c` key on every `.`, which
// would break the key's `config.toml`.
export function postToolHookOverrides(command) {
  const h = handler(command);
  const hook = `hooks.PostToolUse=[{matcher=${tomlString(MATCHER)},hooks=[{type=${tomlString(h.type)},command=${tomlString(command)},timeout=${h.timeout},async=${h.async}}]}]`;
  const trust = `hooks.state={${tomlString(hookTrustKey())}={trusted_hash=${tomlString(hookTrustHash(command))}}}`;
  return [hook, trust];
}
