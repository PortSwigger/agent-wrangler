import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { REPO_ROOT, findChrome, waitFor, startInstance, openTab, sleep } from './browser-harness.js';

// Pins the surfaces an extension written before the deck API reaches: the
// fixture in fixtures/compat-probe reads dropped session fields off the graph,
// fetches GET /file and GET /ext-file, and opens a /ws without ?api= from its
// board code, in a real headless Chrome against an isolated instance. Each must
// answer in its old shape, and each must have gone through its adapter, which
// the one deprecation warning per surface shows. Skips without Chrome, like
// board-acceptance.test.js.
const FIXTURE = join(REPO_ROOT, 'server', 'fixtures', 'compat-probe');

test('an extension using the pre-deck surfaces still works, each through its adapter', { timeout: 120_000 }, async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    assert.ok(!process.env.AW_REQUIRE_BROWSER, 'AW_REQUIRE_BROWSER is set but no Chrome/Chromium was found');
    return t.skip('no Chrome/Chromium found (set CHROME_BIN to enable)');
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'aw-compat-'));
  const extDir = join(dataDir, 'extensions', 'compat-probe');
  mkdirSync(dirname(extDir), { recursive: true });
  cpSync(FIXTURE, extDir, { recursive: true });
  writeFileSync(join(dataDir, 'extensions.json'), JSON.stringify({ 'compat-probe': { id: 'compat-probe', requires: ['files:view'] } }));
  const sid = '0000000c-0000-0000-0000-00000000000c';
  const suspendedAt = 1_700_000_000_000;
  writeFileSync(join(dataDir, 'mappings.json'), JSON.stringify({ [sid]: { agent: 'claude', cwd: dataDir, name: 'Compat card', createdAt: Date.now(), suspendedAt } }));
  let instance, tab;
  try {
    instance = await startInstance(dataDir);
    assert.ok(instance.up, 'dev instance never started serving');
    tab = await openTab(chromePath, `http://127.0.0.1:${instance.port}/#view=ext:compat-probe:main`);
    const { warnings, errors } = tab;
    const serverOut = () => instance.out();
    const probe = () => tab.evaluate('JSON.stringify(window.__compatProbe || null)');

    const done = await waitFor(async () => {
      const r = JSON.parse((await probe()) || 'null');
      return r?.fields && r.extFile && r.legacyWs?.pong != null ? r : null;
    });
    assert.ok(done, `the fixture never finished: ${await probe()}`);

    assert.deepEqual(done.fields, { sessionId: sid, hasPid: true, pid: null, suspendedAt, jobId: null }, 'the graph extensions see carries the dropped fields');
    assert.equal(done.file.status, 200);
    assert.equal(done.file.body.content, readFileSync(join(extDir, 'note.md'), 'utf8'));
    assert.deepEqual(done.extFile, { status: 200, ok: true });
    assert.ok(done.legacyWs.types.includes('config') && done.legacyWs.types.includes('graph'), 'a legacy socket gets config and graph frames');
    assert.ok(!done.legacyWs.types.includes('state') && !done.legacyWs.types.includes('event'));
    assert.deepEqual(done.legacyWs.graphSessions, [{ sessionId: sid, hasPid: true, suspendedAt }], 'its graph frame carries the full record');
    assert.equal(done.legacyWs.pong, 7, 'a legacy message reaches its handler and the reply comes back unwrapped');

    for (const field of ['pid', 'suspendedAt', 'jobId']) {
      assert.equal(warnings.filter((w) => w.includes(`session.${field} is deprecated`)).length, 1, `one warning for session.${field}`);
    }
    for (const [surface, replacement] of [['GET /file', 'session.file'], ['GET /ext-file', 'deck.ext-file'], ['A /ws connection without ?api=', '/ws?api=1']]) {
      const lines = serverOut().split('\n').filter((l) => l.includes(`${surface} is deprecated`));
      assert.equal(lines.length, 1, `one server warning for ${surface}:\n${serverOut()}`);
      assert.ok(lines[0].includes(replacement), `${surface}'s warning names ${replacement}`);
    }
    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    await tab?.close();
    try { instance?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
