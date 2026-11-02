import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookTrustKey, hookTrustHash, postToolHookOverrides } from './codex-hook-config.js';

const CMD = "'/usr/local/bin/node' '/opt/aw/scripts/codex-pr-footer-hook.mjs'";

// Pinned against codex-cli 0.165.0: launched with postToolHookOverrides(CMD),
// Codex went straight to its composer; with the trust override left out it
// stopped on "Hooks need review". A Codex change to the key or hash shows up
// as that prompt in every wrangler-launched Codex session, so re-verify there.
test('the trust hash is the one Codex computes for the hook', () => {
  assert.equal(hookTrustHash(CMD), 'sha256:116620b8443d014e8f52af175c2354e32b3e0f7caabddff67d15b901a0946fc7');
});

test('the trust key is the first session-flags PostToolUse handler', () => {
  assert.equal(hookTrustKey(), '/<session-flags>/config.toml:post_tool_use:0:0');
});

test('the hash follows the command', () => {
  assert.notEqual(hookTrustHash(CMD), hookTrustHash(`${CMD} x`));
});

test('the overrides declare an async Bash PostToolUse hook and trust it by an inline-table state key', () => {
  const [hook, trust] = postToolHookOverrides(CMD);
  assert.equal(hook, `hooks.PostToolUse=[{matcher="Bash",hooks=[{type="command",command="${CMD}",timeout=10,async=true}]}]`);
  assert.equal(trust, `hooks.state={"/<session-flags>/config.toml:post_tool_use:0:0"={trusted_hash="${hookTrustHash(CMD)}"}}`);
});

test('a command with quotes or backslashes is TOML-escaped', () => {
  const [hook] = postToolHookOverrides('a "b" \\c');
  assert.match(hook, /command="a \\"b\\" \\\\c"/);
});
