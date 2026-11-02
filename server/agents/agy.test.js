import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agy, agyModeArgs } from './agy.js';
import { parseAgyModels, resolveAgyModel } from './agy-catalog.js';
import { agyPane } from './agy-pane.js';

const idle = '────────────────────────────\n> \n────────────────────────────\n? for shortcuts     auto   Gemini 3.8 Flash · medium';
const modes = JSON.parse(fs.readFileSync(new URL('../fixtures/agy-1.4.11/mode-panes.json', import.meta.url), 'utf8'));
test('only the captured idle mode placeholder is empty; matching human drafts and extra text are protected', () => {
  assert.equal(agyPane.empty(modes.acceptEdits), true);
  assert.equal(agyPane.draft(modes.acceptEdits), '');
  for (const pane of [
    modes.acceptEdits.replace('? for shortcuts', ''),
    modes.acceptEdits.replace('(shift+tab to cycle)', '(shift+tab to cycle) my draft'),
    modes.acceptEdits.replace('> Accept-edits', '> human text\n  Accept-edits'),
    modes.acceptEdits.replace('accept-edits · Gemini', 'default · Gemini'),
  ]) assert.equal(agyPane.empty(pane), false);
  assert.equal(agyPane.empty(modes.acceptEdits + '\nAllow calling this tool?'), false);
});
test('agy launch, resume and fork preserve model, grants, policy and core identity with shell-safe prompts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-argv-'));
  try {
    fs.writeFileSync(path.join(home, 'agy'), '#!/bin/sh\nprintf "%s\\n" "$AW_SESSION_ID" "$AW_CWD" "${ANTIGRAVITY_FUTURE-unset}" "$@"\n', { mode: 0o755 });
    const opts = { sessionId: 'card', cwd: '/tmp/a b', intent: "- hello ' $HOME `false`\nworld\\", model: 'gemini-3.8-flash', effort: 'medium', addDirs: ['/tmp/private git', '/tmp/common'], launchContext: { env: { AW_SESSION_ID: 'spoof' }, addDirs: ['/tmp/memory'] } };
    for (const [method, extra] of [['buildLaunch', {}], ['buildResume', { resumeId: 'root' }], ['buildFork', { sourceId: 'parent' }]]) {
      const out = execFileSync('sh', ['-c', agy[method]({ ...opts, ...extra })], { env: { ...process.env, ANTIGRAVITY_FUTURE: 'leaked', PATH: `${home}:${process.env.PATH}` }, encoding: 'utf8' });
      assert.ok(out.startsWith('card\n/tmp/a b\nunset\n')); 
      assert.match(out, /--mode\nauto/);
      assert.match(out, /--effort\nmedium/);
      for (const dir of ['/tmp/private git', '/tmp/common', '/tmp/memory']) assert.ok(out.includes(dir));
      if (method === 'buildLaunch') assert.ok(!out.includes(opts.intent));
      else { assert.match(out, /--conversation\n(root|parent)/); assert.ok(!out.includes(opts.intent)); }
    }
    assert.throws(() => execFileSync('sh', ['-c', agy.buildLaunch({ ...opts, launchContext: { refuseIfSet: ['BLOCKED_AUTH'] } })], { env: { ...process.env, BLOCKED_AUTH: 'set', PATH: `${home}:${process.env.PATH}` }, stdio: 'pipe' }));
    assert.deepEqual(agyModeArgs('auto'), ['--mode', 'auto']);
    assert.deepEqual(agy.terminal.interruptKeys, ['Escape']);
    assert.equal(agy.matchProcess('/usr/local/bin/agy -i hi'), true);
    assert.equal(agy.matchProcess('sh -c echo agy'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('model TSV normalizes only observed effort aliases; Claude has no effort', () => {
  const models = parseAgyModels('gemini-3.8-flash-low\tFlash Low\ngemini-3.8-flash-medium\tFlash Medium\ngemini-3.8-flash-high\tFlash High\nclaude-sonnet-4-6\tSonnet\n');
  assert.equal(models[0].value, 'gemini-3.8-flash');
  assert.deepEqual(models[0].efforts, ['low', 'medium', 'high']);
  assert.deepEqual(resolveAgyModel('gemini-3.8-flash', undefined, models), { model: 'gemini-3.8-flash', effort: 'medium' });
  assert.throws(() => resolveAgyModel('gemini-3.8-flash-high', 'low', models), /conflict/);
  assert.throws(() => resolveAgyModel('claude-sonnet-4-6', 'medium', models), /effort/);
});
test('version 1.4.10 panes distinguish boot, drafts, busy mail and modal screens', () => {
  assert.equal(agyPane.ready(idle), true);
  assert.equal(agyPane.empty(idle), true);
  assert.equal(agyPane.empty(idle.replace('> ', '> human draft')), false);
  assert.equal(agyPane.draft(idle.replace('> ', '> human draft')), 'human draft');
  assert.equal(agyPane.classify(idle).status, 'idle');
  assert.equal(agyPane.classify(idle.replace('? for shortcuts', 'esc to cancel')).status, 'working');
  assert.equal(agyPane.ready('Welcome to Antigravity'), false);
  for (const screen of ['Do you trust the contents of this project?', 'Requesting permission for: echo', 'Allow calling this tool?', 'You are currently not signed in. Select login method', 'Choose your color scheme', 'Terms of Service & Data Use', 'Review artifact', 'Individual quota reached', 'Feedback survey']) {
    assert.equal(agyPane.classify(`${idle}\n${screen}`).status, 'needs-you', screen);
    assert.equal(agyPane.ready(`${idle}\n${screen}`), false, screen);
  }
});
