import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { codexPolicyArgs } from '../extensions/codex-policy.js';

for (const [adapter, label, field, ids] of [
  [codex, 'Sandbox', 'sandboxMode', ['locked', 'auto', 'full']],
  [claude, 'Permissions', 'permissionMode', ['auto', 'acceptEdits', 'bypassPermissions']],
]) {
  test(`${adapter.id} declares dialog modes, a default and argv shared by launch/resume/fork`, () => {
    const section = adapter.launchModes;
    assert.equal(section?.label, label);
    assert.equal(section.field, field);
    assert.deepEqual(section.modes.map((m) => m.id), ids);
    assert.equal(section.modes.filter((m) => m.default).length, 1);
    for (const mode of section.modes) {
      assert.ok(mode.name && mode.hint && mode.icon);
      assert.equal(typeof mode.folders, 'boolean');
      for (const method of ['buildLaunch', 'buildResume', 'buildFork']) {
        const cmd = adapter[method]({ sessionId: 'card', resumeId: 'live', sourceId: 'live', [field]: mode.id });
        for (const flag of mode.flags) assert.ok(cmd.includes(`'${flag}'`), `${method}: missing ${flag}`);
      }
    }
  });
}

test('Codex declarations reuse policy flags, including network grants', () => {
  const modes = codex.launchModes.modes;
  for (const [id, policy] of [['locked', undefined], ['auto', { approveForMe: true }], ['full', { bypass: true }]]) {
    assert.deepEqual(modes.find((m) => m.id === id).flags, codexPolicyArgs(policy));
  }
  assert.equal(modes.find((m) => m.id === 'full').folders, false);
});

test('extension policy overrides core selection in every Codex command', () => {
  for (const method of ['buildLaunch', 'buildResume', 'buildFork']) {
    const cmd = codex[method]({ sessionId: 'card', resumeId: 'live', sourceId: 'live', sandboxMode: 'full', codexPolicy: { sandbox: 'read-only' }, addDirs: ["/tmp/a folder's data"] });
    assert.match(cmd, /'--sandbox' 'read-only'/);
    assert.doesNotMatch(cmd, /dangerously-bypass/);
    assert.ok(cmd.includes("'/tmp/a folder'\\''s data'"));
  }
});

test('unknown Codex modes are refused before argv is built', () => {
  assert.throws(() => codex.buildLaunch({ sessionId: 'card', sandboxMode: 'missing' }), /Invalid sandbox mode/);
});
