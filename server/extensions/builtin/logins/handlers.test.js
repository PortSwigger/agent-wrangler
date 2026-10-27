import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginStore } from './login-store.js';
import { HANDLERS, stopCaptures } from './handlers.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-login-handlers-'));
  const calls = []; const store = new LoginStore(root);
  const host = { stores: { logins: store }, terminals: { create: async (opts) => calls.push(opts) }, rebuild: async () => { host.rebuilds++; }, rebuilds: 0 };
  t.after(() => { stopCaptures(store); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (type, msg = {}) => HANDLERS.find((h) => h.type === type).handler(msg, host);
  return { store, host, calls, send };
}

test('management handlers add, forget and remove without erasing bindings', async (t) => {
  const { store, host, send } = fixture(t);
  await send('logins-add', { label: 'Personal' });
  assert.equal(host.rebuilds, 1);
  const token = 'sk-ant-oat01-fixture_abcdefghijklmnopqr';
  await assert.rejects(send('logins-set-claude-token', { slug: 'personal', token: 'bad' }), { message: 'That does not look like a Claude setup-token' });
  assert.equal(store.get('personal').claude.present, false);
  await send('logins-set-claude-token', { slug: 'personal', token });
  assert.equal(store.readClaudeToken('personal'), token);
  await send('logins-forget', { slug: 'personal', provider: 'claude' });
  assert.equal(store.get('personal').claude.present, false);
  store.bind('card', 'personal');
  await send('logins-remove', { slug: 'personal' });
  assert.equal(store.get('personal'), null);
  assert.equal(store.loginFor('card'), 'personal');
});

test('login opens isolated Codex and Claude commands; capture files are private', async (t) => {
  const { store, calls, send } = fixture(t);
  await send('logins-add', { label: 'Personal' });
  await send('logins-login', { slug: 'personal', provider: 'codex' });
  assert.match(calls[0].command, /^CODEX_HOME=/);
  assert.ok(calls[0].command.includes(store.codexHome('personal')));
  assert.equal(fs.existsSync(store.codexHome('personal')), true);
  await send('logins-login', { slug: 'personal', provider: 'claude' });
  assert.match(calls[1].command, /setup-token.*tee/);
  assert.equal(fs.statSync(path.join(store.dir('personal'), 'claude-capture.txt')).mode & 0o777, 0o600);
  await assert.rejects(send('logins-login', { slug: 'absent', provider: 'claude' }), /no longer exists/);
  await assert.rejects(send('logins-login', { slug: 'personal', provider: 'other' }), /Invalid login provider/);
});
