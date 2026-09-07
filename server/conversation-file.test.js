import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findConversationFile } from './conversation-file.js';

// The two agents keep their conversations in different trees, and resolving one
// with the other's finder degrades SILENTLY to an empty view rather than to an
// error — which is how the chat view came to be disabled for Codex (PR #94). So
// what these pin is the ROUTING, driving the real finders over temp trees rather
// than stubbing them: a wrong branch must not be able to pass by returning a
// path some stub happened to hand back.

const UUID = '11111111-2222-3333-4444-555555555555';

function trees() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-convfile-'));
  // Codex: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl
  const day = path.join(root, 'codex', '2026', '09', '06');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-09-06T09-00-00-${UUID}.jsonl`);
  fs.writeFileSync(rollout, '');
  // Claude: ~/.claude/projects/<slugged-cwd>/<uuid>.jsonl
  const bucket = path.join(root, 'claude', '-Users-someone-repo');
  fs.mkdirSync(bucket, { recursive: true });
  const transcript = path.join(bucket, `${UUID}.jsonl`);
  fs.writeFileSync(transcript, '');
  return {
    rollout,
    transcript,
    sessionsDir: path.join(root, 'codex'),
    projectsDir: path.join(root, 'claude'),
  };
}

test('a Codex session resolves to its rollout, not to a same-named transcript', async () => {
  const t = trees();
  assert.equal(await findConversationFile(UUID, 'codex', t), t.rollout);
});

test('a Claude session resolves to its transcript, not to a same-named rollout', async () => {
  const t = trees();
  assert.equal(await findConversationFile(UUID, 'claude', t), t.transcript);
});

test('an absent agent falls to the Claude branch, never the Codex one', async () => {
  // Both handlers normalise before calling in, so this is belt and braces — but
  // the default must not be Codex, or a legacy entry with no agent field would
  // start searching the wrong tree.
  const t = trees();
  assert.equal(await findConversationFile(UUID, undefined, t), t.transcript);
});

test('a Codex id with no rollout is null rather than being answered from the Claude tree', async () => {
  const t = trees();
  const other = '99999999-9999-9999-9999-999999999999';
  fs.writeFileSync(path.join(t.projectsDir, '-Users-someone-repo', `${other}.jsonl`), '');
  assert.equal(await findConversationFile(other, 'codex', t), null);
});
