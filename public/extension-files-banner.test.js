import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const standingBanner = source.match(/function syncStandingBanner\(\) \{[\s\S]*?\n\}/)[0];

test('missing extension banner names extensions, persists and yields to urgent alerts', () => {
  const shown = [];
  const context = vm.createContext({
    deckStatus: 'ready', fdBannerActive: false, quarantinedBuiltins: [], toolSchemaFailures: [],
    missingExtensionFiles: [{ id: 'demo', label: 'Demo' }, { id: 'other', label: 'Other' }],
    staleGuiSession: null, restartPendingExts: ['Pending'], rolledBackUpdate: null,
    rolledBackText: () => null,
    showSystemBanner: (...args) => shown.push(args),
  });
  vm.runInContext(`${standingBanner}\nsyncStandingBanner(); syncStandingBanner();`, context);
  assert.equal(shown.length, 2);
  assert.match(shown[0][0], /Demo.*Other/);
  assert.match(shown[0][0], /missing/i);
  assert.equal(shown[0].length, 1, 'no dismissal option');
  context.fdBannerActive = true;
  vm.runInContext('syncStandingBanner()', context);
  assert.equal(shown.length, 2);
  context.fdBannerActive = false;
  context.missingExtensionFiles = [];
  vm.runInContext('syncStandingBanner()', context);
  assert.match(shown.at(-1)[0], /update installed/);
});

test('graph recovery clears the missing-files banner before restoring other standing notices', () => {
  const update = source.slice(source.indexOf('  const hadMissingFiles ='), source.indexOf('  const hadRestartPending ='));
  let hidden = 0;
  const context = vm.createContext({
    graph: { missingExtensionFiles: [] },
    missingExtensionFiles: [{ id: 'demo', label: 'Demo' }],
    fdBannerActive: false,
    hideSystemBanner: () => hidden++,
  });
  vm.runInContext(update, context);
  assert.equal(hidden, 1);
  assert.deepEqual(Array.from(context.missingExtensionFiles), []);
});
