import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listStyles, assetPath } from './styles.js';

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
  name: 'Jurassic Park',
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
  seedStyle(dir, 'jurassic-park', VALID, { 'wallpaper.png': 'x' });
  const styles = listStyles(dir, makeStylesDir());
  assert.equal(styles.length, 1);
  const s = styles[0];
  assert.equal(s.id, 'jurassic-park');
  assert.equal(s.name, 'Jurassic Park');
  assert.equal(s.base, 'light');
  assert.equal(s.icon, 'M3 11c2-4');
  assert.equal(s.wallpaperUrl, '/styles/jurassic-park/wallpaper.png');
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
  const byId = Object.fromEntries(listStyles(dir, makeStylesDir()).map((s) => [s.id, s]));
  assert.equal(byId.fonted.vars['--font'], "'Quicksand', sans-serif");
  assert.equal('--font' in byId.plain.vars, false);
});

test('listStyles passes a manifest background through; null when absent', () => {
  const dir = makeStylesDir();
  const bg = 'radial-gradient(circle at 12% 18%, #ffd6e8 0%, transparent 38%)';
  seedStyle(dir, 'bgd', { name: 'Bgd', schemaVersion: 1, base: 'light', icon: 'M0 0', background: bg, colors: { bg: '#fff' } });
  seedStyle(dir, 'nobg', { name: 'Nobg', schemaVersion: 1, base: 'dark', icon: 'M0 0', colors: { bg: '#000' } });
  const byId = Object.fromEntries(listStyles(dir, makeStylesDir()).map((s) => [s.id, s]));
  assert.equal(byId.bgd.background, bg);
  assert.equal(byId.nobg.background, null);
});

test('listStyles gives wallpaperUrl null when no wallpaper asset is declared', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'plain', { name: 'Plain', schemaVersion: 1, base: 'dark', icon: 'M0 0', colors: { bg: '#000' } });
  assert.equal(listStyles(dir, makeStylesDir())[0].wallpaperUrl, null);
});

test('listStyles skips bad manifests but still returns valid siblings', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'good', VALID, { 'wallpaper.png': 'x' });
  seedStyle(dir, 'no-base', { name: 'X', schemaVersion: 1, icon: 'M0 0' });
  seedStyle(dir, 'bad-base', { name: 'X', schemaVersion: 1, base: 'neon', icon: 'M0 0' });
  seedStyle(dir, 'unparseable', '{ not json');
  seedStyle(dir, 'no-manifest', undefined);
  const ids = listStyles(dir, makeStylesDir()).map((s) => s.id);
  assert.deepEqual(ids, ['good']);
});

test('listStyles attaches the raw manifest to each descriptor', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'jp', { ...VALID, name: 'JP', iconCredit: 'by Acme' });
  const s = listStyles(dir, makeStylesDir())[0];
  assert.equal(s.manifest.iconCredit, 'by Acme');
  assert.equal(s.manifest.name, 'JP');
});

test('listStyles scans bundled + custom dirs and tags editable by source', () => {
  const bundled = makeStylesDir();
  const custom = makeStylesDir();
  seedStyle(bundled, 'cyberpunk', { ...VALID, name: 'Cyberpunk' });
  seedStyle(custom, 'sunset', { ...VALID, name: 'Sunset' });
  const styles = listStyles(bundled, custom);
  const byId = Object.fromEntries(styles.map((s) => [s.id, s]));
  assert.equal(byId.cyberpunk.editable, false);
  assert.equal(byId.sunset.editable, true);
});

test('listStyles: a missing custom dir yields just the bundled set', () => {
  const bundled = makeStylesDir();
  seedStyle(bundled, 'cyberpunk', { ...VALID, name: 'Cyberpunk' });
  const styles = listStyles(bundled, path.join(bundled, 'does-not-exist'));
  assert.equal(styles.length, 1);
  assert.equal(styles[0].editable, false);
});

test('listStyles: on an id collision the bundled theme wins and stays read-only', () => {
  const bundled = makeStylesDir();
  const custom = makeStylesDir();
  seedStyle(bundled, 'dup', { ...VALID, name: 'Bundled Dup' });
  seedStyle(custom, 'dup', { ...VALID, name: 'Custom Dup' });
  const styles = listStyles(bundled, custom).filter((s) => s.id === 'dup');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].name, 'Bundled Dup');
  assert.equal(styles[0].editable, false);
});

test('assetPath authorizes only manifest-declared assets', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'jp', VALID, { 'wallpaper.png': 'x', 'secret.txt': 'y' });
  assert.equal(assetPath('jp', 'wallpaper.png', dir), path.join(dir, 'jp', 'wallpaper.png'));
  assert.equal(assetPath('jp', 'theme.json', dir), null);
  assert.equal(assetPath('jp', 'secret.txt', dir), null);
  assert.equal(assetPath('jp', '../jp/wallpaper.png', dir), null);
  assert.equal(assetPath('jp', '../../etc/passwd', dir), null);
  assert.equal(assetPath('missing', 'wallpaper.png', dir), null);
});

test('assetPath resolves a declared asset from the custom dir too', () => {
  const bundled = makeStylesDir();
  const custom = makeStylesDir();
  seedStyle(custom, 'sunset', { ...VALID, name: 'Sunset', assets: { wallpaper: 'w.png' } }, { 'w.png': 'x' });
  const p = assetPath('sunset', 'w.png', bundled, custom);
  assert.equal(p, path.join(custom, 'sunset', 'w.png'));
  assert.equal(assetPath('sunset', 'theme.json', bundled, custom), null);
  assert.equal(assetPath('sunset', '../theme.json', bundled, custom), null);
});

test('listStyles emits iconImageUrl from assets.iconImage (null when absent)', () => {
  const dir = makeStylesDir();
  seedStyle(dir, 'imgicon', { ...VALID, name: 'ImgIcon', assets: { iconImage: 'iconImage.png' } }, { 'iconImage.png': 'x' });
  seedStyle(dir, 'pathicon', { ...VALID, name: 'PathIcon' });
  const byId = Object.fromEntries(listStyles(dir, makeStylesDir()).map((s) => [s.id, s]));
  assert.equal(byId.imgicon.iconImageUrl, '/styles/imgicon/iconImage.png');
  assert.equal(byId.pathicon.iconImageUrl, null);
});
