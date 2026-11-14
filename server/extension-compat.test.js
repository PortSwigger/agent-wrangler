import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { REPO_ROOT, findChrome, waitFor, startInstance, openTab, sleep } from './browser-harness.js';

// A local collector: every event core sends, in order.
async function stubCollector() {
  const events = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { events.push(...JSON.parse(body).events); } catch {}
      res.writeHead(200).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { events, url: `http://127.0.0.1:${server.address().port}/v1/events`, close: () => server.close() };
}

// Pins the surfaces an extension written before the deck API reaches: the
// fixture in fixtures/compat-probe reads dropped session fields off the graph,
// fetches GET /file and GET /ext-file and opens a /ws without ?api= on the
// board's origin (forwarded to the deck), and runs an inline onclick handler,
// in a real headless Chrome against an isolated instance. It declares `^1`, so
// it boots on the 2.x server's v1 shim. Each surface must answer in its old
// shape, and each must have gone through its adapter, which the one
// deprecation warning per surface and the one `core.deprecated` event per
// surface per extension show. Skips without Chrome, like board-acceptance.test.js.
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
  const collector = await stubCollector();
  const prevUrl = process.env.AW_TELEMETRY_URL;
  process.env.AW_TELEMETRY_URL = collector.url;
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

    await tab.evaluate("document.getElementById('compat-inline').click()");
    const inline = await waitFor(async () => {
      const r = JSON.parse((await probe()) || 'null');
      return r?.inline && r.csp ? r : null;
    });
    assert.ok(inline, `the inline handler never ran: ${await probe()}`);
    assert.equal(inline.inline, 'ran', 'an inline handler still runs under the Report-Only CSP');
    assert.deepEqual(inline.csp, { directive: 'script-src-attr', disposition: 'report' }, 'and is reported, not enforced');

    for (const field of ['pid', 'suspendedAt', 'jobId']) {
      assert.equal(warnings.filter((w) => w.includes(`session.${field} is deprecated`)).length, 1, `one warning for session.${field}`);
    }
    for (const [surface, replacement] of [['GET /file', 'session.file'], ['GET /ext-file', 'deck.ext-file'], ['A /ws connection without ?api=', '/ws?api=1']]) {
      const lines = serverOut().split('\n').filter((l) => l.includes(`${surface} is deprecated`));
      assert.equal(lines.length, 1, `one server warning for ${surface}:\n${serverOut()}`);
      assert.ok(lines[0].includes(replacement), `${surface}'s warning names ${replacement}`);
    }
    // One core.deprecated per surface per extension, the probe's id as a ref.
    const secret = JSON.parse(readFileSync(join(dataDir, 'telemetry.json'), 'utf8')).secret;
    const ref = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update('extension:compat-probe').digest('hex').slice(0, 16);
    const deprecated = () => collector.events.filter((e) => e.type === 'core.deprecated').map((e) => `${e.surface} ${e.extension} ${e.extensionRef ?? '-'}`).sort();
    // startInstance's readiness check is the GET /deck on the board's port.
    const expected = [
      'board-port.deck unknown -',
      `board.graph-key installed ${ref}`,
      `board.session-field installed ${ref}`,
      `manifest.unsplit installed ${ref}`,
      'route.ext-file installed ' + ref,
      'route.file unknown -',
      'ws.legacy installed ' + ref,
      'ws.legacy unknown -',
    ].sort();
    assert.ok(await waitFor(() => deprecated().length >= expected.length), `core.deprecated never arrived: ${JSON.stringify(collector.events.map((e) => e.type))}`);
    assert.deepEqual(deprecated(), expected);
    assert.ok(!JSON.stringify(collector.events).includes('compat-probe'), 'the installed extension\'s id never leaves the machine');

    // The same uses again the same day, from a fresh page load: no new event.
    await tab.send('Page.reload');
    assert.ok(await waitFor(async () => JSON.parse((await probe()) || 'null')?.legacyWs?.pong != null), 'the probe ran again after the reload');
    await sleep(3000);
    assert.deepEqual(deprecated(), expected, 'a second use the same day sends nothing');
    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    if (prevUrl == null) delete process.env.AW_TELEMETRY_URL;
    else process.env.AW_TELEMETRY_URL = prevUrl;
    collector.close();
    await tab?.close();
    try { instance?.server.kill(); } catch {}
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
