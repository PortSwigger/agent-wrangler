import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { REPO_ROOT, findChrome, waitFor, startInstance, openTab, sleep } from './browser-harness.js';

// Every member of the extension api a board half gets, as a real board hands it
// out. The fixture in fixtures/ext-api-probe is an unsplit manifest that calls
// each one; a member missing from this list (or a new one) fails here, so the
// surface extensions rely on cannot shrink unnoticed. Skips without Chrome,
// like board-acceptance.test.js.
const FIXTURE = join(REPO_ROOT, 'server', 'fixtures', 'ext-api-probe');

const MEMBERS = [
  'act', 'agents', 'cards', 'claimDrag', 'decks', 'dispatch', 'dispatchFields', 'earlyAdopter', 'earlyAdopterFor',
  'files', 'front', 'images', 'keys', 'markdownPreview', 'minimiseTask', 'modelFront', 'mountSession',
  'notify', 'onConnect', 'onMessage', 'onState', 'onThemeChange', 'openDiff', 'openDispatch',
  'openDispatchAcked', 'openFile', 'openSession', 'openTask', 'rail', 'refreshInputGates',
  'renderSampleCard', 'requestBoardRender', 'requestPanelRender', 'runtimes', 'selectedSessionId', 'send',
  'sessionPanel', 'setEarlyAdopter', 'setExtSetting', 'setMinimisedTasks', 'settings', 'settingsFor',
  'stageImage', 'state', 'storage', 'styles', 'submitDispatchFromExt', 'targets', 'themeButtonHtml', 'toast',
  'ui', 'updateStatus', 'updateStatusFor', 'version', 'withdrawNotification',
];

test('an unsplit extension calling every api member works on top of the deck API', { timeout: 120_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-ext-api-'));
  const extDir = join(dataDir, 'extensions', 'ext-api-probe');
  mkdirSync(dirname(extDir), { recursive: true });
  cpSync(FIXTURE, extDir, { recursive: true });
  writeFileSync(join(dataDir, 'extensions.json'), JSON.stringify({ 'ext-api-probe': { id: 'ext-api-probe', requires: ['files:view', 'cards:hideChips', 'board:press', 'session:type'] } }));
  let instance, tab;
  try {
    instance = await startInstance(dataDir);
    assert.ok(instance.up, 'dev instance never started serving');
    const deck = await (await fetch(`http://127.0.0.1:${instance.port}/deck`)).json();
    assert.deepEqual(deck.extensions.find((e) => e.id === 'ext-api-probe'), { id: 'ext-api-probe', version: '0.1.0', boardApi: '^1.74.0' }, 'the deck lists it, its boardApi read from the unsplit manifest');
    assert.deepEqual(deck.extensions.find((e) => e.id === 'todos'), { id: 'todos', version: null, boardApi: '^1.74.0' }, 'a split builtin is listed with its own boardApi');

    tab = await openTab(chromePath, `http://127.0.0.1:${instance.port}/#view=ext:ext-api-probe:main`);
    const probe = () => tab.evaluate('JSON.stringify(window.__extApiProbe || null)');
    const done = await waitFor(async () => {
      const r = JSON.parse((await probe()) || 'null');
      return r?.done ? r : null;
    });
    assert.ok(done, `the fixture never finished: ${await probe()}`);

    assert.deepEqual(done.members, MEMBERS, 'the api carries exactly the members extensions have');
    assert.deepEqual(done.registrar, ['api', 'onMessage', 'onConnect', 'register'].sort());
    const failed = Object.entries(done.results).filter(([, r]) => !r.ok);
    assert.deepEqual(failed, [], 'every member answered as it always has');
    assert.deepEqual(Object.keys(done.results).sort(), MEMBERS);
    assert.deepEqual(done.graphKey, { note: 'string' }, 'its own state is still on the graph it is handed');

    const warned = (s) => tab.warnings.filter((w) => w.includes(s));
    assert.equal(warned('graph.extApiProbe is deprecated').length, 1, `one warning for the graph key:\n${tab.warnings.join('\n')}`);
    assert.ok(warned('graph.extApiProbe is deprecated')[0].includes('api.state()'));
    const unsplit = instance.out().split('\n').filter((l) => l.includes('An unsplit manifest (ext-api-probe'));
    assert.equal(unsplit.length, 1, `one server warning for the unsplit manifest:\n${instance.out()}`);
    assert.ok(unsplit[0].includes('board: { client, styles, themes }'));
    assert.equal(instance.out().split('\n').filter((l) => /An unsplit manifest \((todos|checklist|themes|sounds|jira|task-memory)/.test(l)).length, 0, 'no builtin is unsplit');

    const unexpected = tab.errors.filter((e) => !/\[ext:ext-api-probe\] (openSession|openDiff|mountSession) refused/.test(e));
    assert.deepEqual(unexpected, [], 'no console errors beyond the refusals the probe asks for');
  } finally {
    await tab?.close();
    try { instance?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
