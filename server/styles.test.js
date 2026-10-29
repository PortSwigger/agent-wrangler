import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listStyles, assetPath } from './styles.js';

const ext = (dir, off) => [{ id: 'ext', dir, ...(off ? { off } : {}) }];

function makeStylesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-styles-'));
}
function seedStyle(dir, id, manifest, assets = {}) {
  const sdir = path.join(dir, id);
  fs.mkdirSync(sdir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(sdir, 'theme.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  for (const [name, body] of Object.entries(assets)) fs.writeFileSync(path.join(sdir, name), body);
  return sdir;
}

const VALID = {
  name: 'Sample',
  schemaVersion: 1,
  base: 'light',
  icon: 'M3 11c2-4',
  colors: {
    bg: '#111',
    'surface-2': '#222',
    terminal: { bg: '#333', cursor: '#444', selection: '#555', ansi: { red: '#600', brightRed: '#700', 'bright-green': '#080' } },
  },
  assets: { wallpaper: 'wallpaper.png' },
};

test('listStyles flattens a manifest to CSS-var overrides and a wallpaper URL', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'sample', VALID, { 'wallpaper.png': 'x' });
  const styles = listStyles(ext(dir), makeStylesDir());
  assert.equal(styles.length, 1);
  const s = styles[0];
  assert.equal(s.id, 'sample');
  assert.equal(s.name, 'Sample');
  assert.equal(s.base, 'light');
  assert.equal(s.icon, 'M3 11c2-4');
  assert.equal(s.wallpaperUrl, '/styles/sample/wallpaper.png');
  assert.deepEqual(s.vars, {
    '--bg': '#111',
    '--surface-2': '#222',
    '--term-bg': '#333',
    '--term-cursor': '#444',
    '--term-selection': '#555',
    '--term-ansi-red': '#600',
    '--term-ansi-bright-red': '#700',
    '--term-ansi-bright-green': '#080',
  });
});

test('listStyles maps a manifest font to the --font var; omitting it leaves --font unset', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'fonted', { name: 'Fonted', schemaVersion: 1, base: 'light', icon: 'M0 0', font: "'Quicksand', sans-serif", colors: { bg: '#fff' } });
  seedStyle(dir, 'plain', { name: 'Plain', schemaVersion: 1, base: 'dark', icon: 'M0 0', colors: { bg: '#000' } });
  const byId = Object.fromEntries(listStyles(ext(dir), makeStylesDir()).map((s) => [s.id, s]));
  assert.equal(byId.fonted.vars['--font'], "'Quicksand', sans-serif");
  assert.equal('--font' in byId.plain.vars, false);
});

test('listStyles passes a manifest background through; null when absent', () => {
  const dir = makeStylesDir();
  const bg = 'radial-gradient(circle at 12% 18%, #ffd6e8 0%, transparent 38%)';
  seedStyle(dir, 'bgd', { name: 'Bgd', schemaVersion: 1, base: 'light', icon: 'M0 0', background: bg, colors: { bg: '#fff' } });
  seedStyle(dir, 'nobg', { name: 'Nobg', schemaVersion: 1, base: 'dark', icon: 'M0 0', colors: { bg: '#000' } });
  const byId = Object.fromEntries(listStyles(ext(dir), makeStylesDir()).map((s) => [s.id, s]));
  assert.equal(byId.bgd.background, bg);
  assert.equal(byId.nobg.background, null);
});

test('listStyles gives wallpaperUrl null when no wallpaper asset is declared', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'plain', { name: 'Plain', schemaVersion: 1, base: 'dark', icon: 'M0 0', colors: { bg: '#000' } });
  assert.equal(listStyles(ext(dir), makeStylesDir())[0].wallpaperUrl, null);
});

test('listStyles skips bad manifests but still returns valid siblings', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'good', VALID, { 'wallpaper.png': 'x' });
  seedStyle(dir, 'no-base', { name: 'X', schemaVersion: 1, icon: 'M0 0' });
  seedStyle(dir, 'bad-base', { name: 'X', schemaVersion: 1, base: 'neon', icon: 'M0 0' });
  seedStyle(dir, 'unparseable', '{ not json');
  seedStyle(dir, 'no-manifest', undefined);
  const ids = listStyles(ext(dir), makeStylesDir()).map((s) => s.id);
  assert.deepEqual(ids, ['good']);
});

test('listStyles attaches the raw manifest to each descriptor', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'jp', { ...VALID, name: 'JP', iconCredit: 'by Acme' });
  const s = listStyles(ext(dir), makeStylesDir())[0];
  assert.equal(s.manifest.iconCredit, 'by Acme');
  assert.equal(s.manifest.name, 'JP');
});

test('listStyles scans extension + custom dirs and tags editable by source', () => {
  const extDir = makeStylesDir();
  const custom = makeStylesDir();
  seedStyle(extDir, 'cyberpunk', { ...VALID, name: 'Cyberpunk' });
  seedStyle(custom, 'sunset', { ...VALID, name: 'Sunset' });
  const styles = listStyles(ext(extDir), custom);
  const byId = Object.fromEntries(styles.map((s) => [s.id, s]));
  assert.equal(byId.cyberpunk.editable, false);
  assert.equal(byId.cyberpunk.extension, 'ext');
  assert.equal(byId.sunset.editable, true);
});

test('listStyles: a missing custom dir yields just the extension set', () => {
  const extDir = makeStylesDir();
  seedStyle(extDir, 'cyberpunk', { ...VALID, name: 'Cyberpunk' });
  const styles = listStyles(ext(extDir), path.join(extDir, 'does-not-exist'));
  assert.equal(styles.length, 1);
  assert.equal(styles[0].editable, false);
});

test('listStyles: on an id collision the extension theme wins and stays read-only', () => {
  const extDir = makeStylesDir();
  const custom = makeStylesDir();
  seedStyle(extDir, 'dup', { ...VALID, name: 'Extension Dup' });
  seedStyle(custom, 'dup', { ...VALID, name: 'Custom Dup' });
  const styles = listStyles(ext(extDir), custom).filter((s) => s.id === 'dup');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].name, 'Extension Dup');
  assert.equal(styles[0].editable, false);
});

test('listStyles and assetPath skip a theme its extension switched off, letting the next source answer', () => {
  const extDir = makeStylesDir();
  const custom = makeStylesDir();
  seedStyle(extDir, 'pink', VALID, { 'wallpaper.png': 'x' });
  seedStyle(extDir, 'sky', VALID, { 'wallpaper.png': 'x' });
  seedStyle(custom, 'sky', { ...VALID, name: 'Custom sky' }, { 'wallpaper.png': 'y' });
  const styles = listStyles(ext(extDir, ['pink', 'sky']), custom);
  assert.deepEqual(styles.map((s) => [s.id, s.name]), [['sky', 'Custom sky']]);
  assert.equal(assetPath('pink', 'wallpaper.png', ext(extDir, ['pink']), custom), null);
  assert.equal(assetPath('sky', 'wallpaper.png', ext(extDir, ['sky']), custom), path.join(custom, 'sky', 'wallpaper.png'));
  assert.equal(assetPath('pink', 'wallpaper.png', ext(extDir), custom), path.join(extDir, 'pink', 'wallpaper.png'));
});

test('assetPath authorizes only manifest-declared assets', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'jp', VALID, { 'wallpaper.png': 'x', 'secret.txt': 'y' });
  assert.equal(assetPath('jp', 'wallpaper.png', ext(dir)), path.join(dir, 'jp', 'wallpaper.png'));
  assert.equal(assetPath('jp', 'theme.json', ext(dir)), null);
  assert.equal(assetPath('jp', 'secret.txt', ext(dir)), null);
  assert.equal(assetPath('jp', '../jp/wallpaper.png', ext(dir)), null);
  assert.equal(assetPath('jp', '../../etc/passwd', ext(dir)), null);
  assert.equal(assetPath('missing', 'wallpaper.png', ext(dir)), null);
});

test('assetPath resolves a declared asset from the custom dir too', () => {
  const custom = makeStylesDir();
  seedStyle(custom, 'sunset', { ...VALID, name: 'Sunset', assets: { wallpaper: 'w.png' } }, { 'w.png': 'x' });
  const p = assetPath('sunset', 'w.png', ext(makeStylesDir()), custom);
  assert.equal(p, path.join(custom, 'sunset', 'w.png'));
  assert.equal(assetPath('sunset', 'theme.json', [], custom), null);
  assert.equal(assetPath('sunset', '../theme.json', [], custom), null);
});

test('listStyles emits iconImageUrl from assets.iconImage (null when absent)', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'imgicon', { ...VALID, name: 'ImgIcon', assets: { iconImage: 'iconImage.png' } }, { 'iconImage.png': 'x' });
  seedStyle(dir, 'pathicon', { ...VALID, name: 'PathIcon' });
  const byId = Object.fromEntries(listStyles(ext(dir), makeStylesDir()).map((s) => [s.id, s]));
  assert.equal(byId.imgicon.iconImageUrl, '/styles/imgicon/iconImage.png');
  assert.equal(byId.pathicon.iconImageUrl, null);
});

test('listStyles merges extension themes in load order, tagged with their extension, before custom', () => {
  const custom = makeStylesDir();
  const extA = makeStylesDir();
  const extB = makeStylesDir();
  seedStyle(extA, 'sky', { ...VALID, name: 'Sky A' });
  seedStyle(extB, 'sky', { ...VALID, name: 'Sky B' });
  seedStyle(extB, 'sea', { ...VALID, name: 'Sea' });
  seedStyle(custom, 'sea', { ...VALID, name: 'Custom sea' });
  seedStyle(custom, 'mine', VALID);
  const styles = listStyles([{ id: 'a', dir: extA }, { id: 'b', dir: extB }], custom);
  assert.deepEqual(styles.map((s) => [s.id, s.name, s.extension ?? null, s.editable]), [
    ['sky', 'Sky A', 'a', false],
    ['sea', 'Sea', 'b', false],
    ['mine', 'Sample', null, true],
  ]);
  assert.equal(styles[0].wallpaperUrl, '/styles/sky/wallpaper.png');
});

test('assetPath serves an extension theme asset from the source listStyles picked', () => {
  const custom = makeStylesDir();
  const extDir = makeStylesDir();
  seedStyle(extDir, 'sky', VALID, { 'wallpaper.png': 'x' });
  seedStyle(custom, 'sky', { ...VALID, assets: { wallpaper: 'other.png' } }, { 'other.png': 'y' });
  const themes = [{ id: 'a', dir: extDir }];
  assert.equal(assetPath('sky', 'wallpaper.png', themes, custom), path.join(extDir, 'sky', 'wallpaper.png'));
  assert.equal(assetPath('sky', 'other.png', themes, custom), null);
  assert.equal(assetPath('sky', 'theme.json', themes, custom), null);
  assert.equal(assetPath('sky', 'wallpaper.png', [], custom), null);
});
