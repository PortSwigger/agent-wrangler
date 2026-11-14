import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestHalves, boardApiOf } from './manifest-halves.js';
import { loadExtensions, BUILTIN } from './index.js';
import { resetLegacyWarnings } from '../deck/legacy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = (o = {}) => ({ id: 'fake', label: 'Fake', defaultEnabled: true, dir: path.join(HERE, 'fake'), handlers: [{ type: 'fake-do', handler() {} }], ...o });

function captureWarnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (m) => seen.push(String(m));
  try { fn(); } finally { console.warn = orig; }
  return seen;
}

test('an unsplit manifest is read as both halves', () => {
  const m = base({ client: 'public/index.js', styles: 'public/s.css', engines: { wranglerApi: '^1.20.0' } });
  const { deck, board, split, unsplitBoard } = manifestHalves(m);
  assert.equal(split, false);
  assert.equal(unsplitBoard, true);
  assert.deepEqual(board, { id: 'fake', boardApi: '^1.20.0', client: 'public/index.js', styles: 'public/s.css' });
  assert.equal(deck.client, undefined);
  assert.equal(deck.handlers, m.handlers);
});

test('a split manifest carries its board half under `board`, paired by id and boardApi', () => {
  const m = base({ boardApi: '^1.74.0', board: { client: 'public/index.js', themes: 'themes' } });
  const { deck, board, split, unsplitBoard } = manifestHalves(m);
  assert.equal(split, true);
  assert.equal(unsplitBoard, false);
  assert.deepEqual(board, { id: 'fake', boardApi: '^1.74.0', client: 'public/index.js', themes: 'themes' });
  assert.equal(deck.board, undefined);
  assert.equal(boardApiOf(base()), null);
});

test('a split manifest loads its board half exactly as the unsplit one did, plus its boardApi', () => {
  const split = loadExtensions({ cfg: {}, builtin: [base({ boardApi: '^1.74.0', board: { client: 'public/index.js' } })] });
  const plain = loadExtensions({ cfg: {}, builtin: [base({ client: 'public/index.js' })] });
  assert.deepEqual(plain.clientManifest, [{ id: 'fake', client: '/ext/fake/index.js', handlerTypes: ['fake-do'] }]);
  assert.deepEqual(split.clientManifest, [{ ...plain.clientManifest[0], boardApi: '^1.74.0' }]);
  assert.equal(split.list[0].boardApi, '^1.74.0');
  assert.equal(plain.list[0].boardApi, null);
});

test('the board half is validated where it lives', () => {
  const reason = (m) => loadExtensions({ cfg: {}, builtin: [m] }).list.at(-1).quarantine;
  assert.match(reason(base({ board: 'public/index.js' })), /board must be an object/);
  assert.match(reason(base({ board: { tools: [] } })), /board\.tools is not a board field/);
  assert.match(reason(base({ client: 'public/index.js', board: { styles: 'public/s.css' } })), /client belongs under board/);
  assert.match(reason(base({ board: { client: '../x.js' } })), /board\.client "\.\.\/x\.js" must resolve inside/);
  assert.match(reason(base({ boardApi: 'not a range', board: {} })), /boardApi must be a valid semver range/);
  assert.match(reason(base({ settings: [{ key: 't', type: 'toggle', label: 'T', theme: 'x' }] })), /requires the manifest's themes/);
  assert.equal(reason(base({ settings: [{ key: 't', type: 'toggle', label: 'T', theme: 'x' }], board: { themes: 'themes' } })), null);
});

test('an unsplit manifest with a board field warns once, naming the split form; a split one never does', () => {
  resetLegacyWarnings();
  const warned = captureWarnings(() => {
    loadExtensions({ cfg: {}, builtin: [base({ client: 'public/index.js' })] });
    loadExtensions({ cfg: {}, builtin: [base({ client: 'public/index.js' })] });
    loadExtensions({ cfg: {}, builtin: [base({ id: 'other', boardApi: '^1.74.0', board: { client: 'public/index.js' } })] });
    loadExtensions({ cfg: {}, builtin: [base({ id: 'deckonly' })] });
  });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /unsplit manifest \(fake: top-level client, styles or themes\) is deprecated.*use a board: \{ client, styles, themes \} half beside boardApi/);
});

test('every builtin with a board half declares it split', () => {
  for (const m of BUILTIN) {
    const { split, unsplitBoard } = manifestHalves(m);
    assert.equal(unsplitBoard, false, `${m.id} still has top-level board fields`);
    if (split) assert.ok(m.boardApi, `${m.id} declares a board half without boardApi`);
  }
});
