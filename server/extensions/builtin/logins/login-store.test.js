import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginStore } from './login-store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-logins-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new LoginStore(root);
}

test('slug names, duplicate slugs, fresh providers and safe paths', (t) => {
  const s = fixture(t);
  assert.equal(s.slugFor('Personal '), 'personal');
  assert.equal(s.slugFor('Side  Project!'), 'side-project');
  assert.throws(() => s.slugFor(''), /A login needs a name/);
  assert.deepEqual(s.add('Personal'), { slug: 'personal', label: 'Personal' });
  assert.throws(() => s.add('personal'), { message: 'A login called "personal" already exists' });
  assert.deepEqual(s.list()[0].claude, { present: false, capturedAt: null });
  assert.deepEqual(s.list()[0].codex, { present: false, email: null });
  for (const slug of ['../escape', '/tmp/escape', '', '__proto__']) assert.throws(() => s.dir(slug));
});

test('tokens are private, nonempty and absent from snapshots', (t) => {
  const s = fixture(t); s.add('Personal');
  assert.throws(() => s.readClaudeToken('personal'), /no usable Claude token/);
  s.setClaudeToken('personal', 'fixture-token');
  assert.equal(fs.statSync(s.claudeTokenPath('personal')).mode & 0o777, 0o600);
  assert.equal(s.readClaudeToken('personal'), 'fixture-token');
  assert.ok(s.get('personal').claude.capturedAt);
  assert.ok(!JSON.stringify(s.snapshot()).includes('fixture-token'));
  fs.writeFileSync(s.claudeTokenPath('personal'), '  ');
  assert.throws(() => s.readClaudeToken('personal'), /no usable Claude token/);
  s.forget('personal', 'claude');
  assert.deepEqual(s.get('personal').claude, { present: false, capturedAt: null });
});

test('Codex status decodes email but never includes credentials', (t) => {
  const s = fixture(t); s.add('Personal');
  fs.mkdirSync(s.codexHome('personal'));
  const token = `header.${Buffer.from(JSON.stringify({ email: 'you@example.com' })).toString('base64url')}.signature`;
  fs.writeFileSync(path.join(s.codexHome('personal'), 'auth.json'), JSON.stringify({ tokens: { id_token: token } }));
  assert.deepEqual(s.get('personal').codex, { present: true, email: 'you@example.com' });
  assert.ok(!JSON.stringify(s.snapshot()).includes(token));
  fs.writeFileSync(path.join(s.codexHome('personal'), 'auth.json'), '{}');
  assert.equal(s.get('personal').codex.email, null);
  s.forget('personal', 'codex');
  assert.equal(fs.existsSync(s.codexHome('personal')), false);
});

test('bindings persist; removal retains a named tombstone until purge', (t) => {
  const s = fixture(t); s.add('Personal'); s.bind('card', 'personal');
  const reload = new LoginStore(s.root);
  assert.equal(reload.loginFor('card'), 'personal');
  s.remove('personal');
  assert.equal(fs.existsSync(s.dir('personal')), false);
  assert.equal(reload.loginFor('card'), 'personal');
  assert.equal(s.get('personal'), null);
  assert.equal(s.labelFor('personal'), 'Personal');
  assert.throws(() => s.add('Personal'), /already exists/);
  s.unbind('card');
  assert.equal(reload.loginFor('card'), null);
  assert.deepEqual(s.snapshot(), { logins: [], sessions: {} });
  assert.deepEqual(s.add('Personal'), { slug: 'personal', label: 'Personal' });
});

test('corrupt bindings throw rather than becoming Default', (t) => {
  const s = fixture(t);
  fs.writeFileSync(path.join(s.root, 'sessions.json'), '{broken');
  assert.throws(() => s.loginFor('card'));
});
