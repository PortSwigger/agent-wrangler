import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const standingBanner = source.match(/function syncStandingBanner\(\) \{[\s\S]*?\n\}/)[0];

function environment() {
  const shown = [];
  const context = vm.createContext({
    deckStatus: 'ready', fdBannerActive: false, quarantinedBuiltins: [],
    toolSchemaFailures: [{ extId: 'demo', tools: [{ name: 'first', error: 'bad schema' }, { name: 'second', error: '<unsafe>' }] }, { extId: 'other', tools: [{ name: 'third', error: 'other error' }] }],
    missingExtensionFiles: [], staleGuiSession: null, restartPendingExts: [], rolledBackUpdate: null,
    rolledBackText: () => null, showSystemBanner: (...args) => shown.push(args),
  });
  return { shown, context };
}

test('schema failures persist with extension, tool names and errors and no dismiss control', () => {
  const { shown, context } = environment();
  vm.runInContext(`${standingBanner}\nsyncStandingBanner(); syncStandingBanner();`, context);
  assert.equal(shown.length, 2);
  assert.match(shown[0][0], /demo.*first.*bad schema.*second.*<unsafe>.*other.*third.*other error/);
  assert.match(shown[0][0], /unavailable/i);
  assert.equal(shown[0].length, 1, 'no dismiss options');
});

test('graph recovery clears the schema banner and restores another standing notice', () => {
  const { shown, context } = environment();
  const start = source.indexOf('  const hadToolSchemaFailures =');
  assert.notEqual(start, -1);
  const update = source.slice(start, source.indexOf('  const hadMissingFiles =', start));
  let hidden = 0;
  Object.assign(context, { graph: { toolSchemaFailures: [] }, hideSystemBanner: () => hidden++, restartPendingExts: ['Pending'] });
  vm.runInContext(`${update}\n${standingBanner}\nsyncStandingBanner();`, context);
  assert.equal(hidden, 1);
  assert.match(shown.at(-1)[0], /update installed/);
});
