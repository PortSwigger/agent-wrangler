import { createHash } from 'node:crypto';
import { tomlString } from './codex-notify-config.js';

// Codex launch hooks (the PR model footer's, and the status hooks on a runtime
// with `statusEvents`), as `-c` overrides. Codex
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
const TIMEOUT_SEC = 10;
// Codex reports its shell tool to hooks as `Bash`, as Claude does.
export const PR_FOOTER_MATCHER = 'Bash';

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// `PostToolUse` -> `post_tool_use`: the event label in a trust key and hash.
function eventLabel(event) {
  return event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

// async: Codex starts the hook and carries on, so it never delays the agent.
function handler(command) {
  return { type: 'command', command, timeout: TIMEOUT_SEC, async: true };
}

export function hookTrustKey(event = 'PostToolUse', group = 0) {
  return `${SESSION_FLAGS_SOURCE}:${eventLabel(event)}:${group}:0`;
}

// A hook with no matcher hashes with the key left out. With no options it is
// the PR footer's Bash PostToolUse hook.
export function hookTrustHash(command, { event = 'PostToolUse', matcher } = { matcher: PR_FOOTER_MATCHER }) {
  const identity = { event_name: eventLabel(event), ...(matcher == null ? {} : { matcher }), hooks: [handler(command)] };
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex')}`;
}

// The `-c` values for a list of hooks, each `{ event, matcher?, command }` and
// each its own group: one `hooks.<Event>=[...]` per event, in the order given,
// and ONE `hooks.state` trusting them all. `hooks.state` is set as an inline
// table because Codex splits a dotted `-c` key on every `.`, which would break
// the key's `config.toml`; and a second `hooks.state` would replace the first.
export function codexHookOverrides(hooks) {
  const byEvent = new Map();
  for (const h of hooks) {
    if (!byEvent.has(h.event)) byEvent.set(h.event, []);
    byEvent.get(h.event).push(h);
  }
  const out = [];
  const trust = [];
  for (const [event, list] of byEvent) {
    const groups = list.map((h, i) => {
      const x = handler(h.command);
      trust.push(`${tomlString(hookTrustKey(event, i))}={trusted_hash=${tomlString(hookTrustHash(h.command, { event, matcher: h.matcher }))}}`);
      const matcher = h.matcher == null ? '' : `matcher=${tomlString(h.matcher)},`;
      return `{${matcher}hooks=[{type=${tomlString(x.type)},command=${tomlString(h.command)},timeout=${x.timeout},async=${x.async}}]}`;
    });
    out.push(`hooks.${event}=[${groups.join(',')}]`);
  }
  if (trust.length) out.push(`hooks.state={${trust.join(',')}}`);
  return out;
}

// The PR model footer's hook alone: the two `-c` values, the hook and its trust.
export function postToolHookOverrides(command) {
  return codexHookOverrides([{ event: 'PostToolUse', matcher: PR_FOOTER_MATCHER, command }]);
}
