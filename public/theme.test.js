import { test } from 'node:test';
import assert from 'node:assert/strict';

// theme.js's safeIconUrl resolves against the global `location`, so stub it
// before importing — same pattern as diff-dom.test.js's `document` stub.
globalThis.location = { origin: 'http://localhost' };

// applyStyle writes to document.body and reads/writes localStorage; stub the
// minimum so the wallpaper and palette paths below can be observed.
const body = {
  classList: { toggle() {} },
  style: {
    props: new Map(),
    backgroundImage: '',
    setProperty(k, v) { this.props.set(k, v); },
    removeProperty(k) { this.props.delete(k); },
  },
};
globalThis.document = { body, querySelector: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {} };

// Fake Image whose decode() the test settles by hand, so "assigned only once the
// file is ready" and "a superseded decode never lands" are both observable.
class FakeImage {
  static instances = [];
  constructor() { this.src = null; FakeImage.instances.push(this); }
  decode() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}
globalThis.Image = FakeImage;
const tick = () => new Promise((r) => setTimeout(r, 0));

const { safeIconUrl, selectStyle, setCustomStyles, onThemeChange, renderThemeRows, themeButtonHtml, themeSwatch, safeColour } = await import('./theme.js');

// ── safeIconUrl ──────────────────────────────────────────────────────────────
test('safeIconUrl: allows same-origin absolute paths', () => {
  assert.equal(safeIconUrl('/styles/foo/icon.png'), '/styles/foo/icon.png');
});
test('safeIconUrl: allows data:image/ URIs', () => {
  assert.equal(safeIconUrl('data:image/png;base64,abc123'), 'data:image/png;base64,abc123');
  assert.equal(safeIconUrl('data:image/svg+xml,<svg/>'), 'data:image/svg+xml,<svg/>');
});
test('safeIconUrl: rejects protocol-relative URLs (external origin bypass)', () => {
  assert.equal(safeIconUrl('//evil.com/x'), null);
  assert.equal(safeIconUrl('//evil.com/x.png'), null);
});
test('safeIconUrl: rejects backslash-normalized protocol-relative variants', () => {
  assert.equal(safeIconUrl('/\\evil.com/x'), null);
  assert.equal(safeIconUrl('\\/evil.com/x'), null);
  assert.equal(safeIconUrl('\\\\evil.com/x'), null);
});
test('safeIconUrl: rejects other schemes', () => {
  assert.equal(safeIconUrl('https://evil.com/x'), null);
  assert.equal(safeIconUrl('javascript:alert(1)'), null);
  assert.equal(safeIconUrl('data:text/html,<script>'), null);
});
test('safeIconUrl: rejects non-string/empty input', () => {
  assert.equal(safeIconUrl(''), null);
  assert.equal(safeIconUrl(null), null);
  assert.equal(safeIconUrl(undefined), null);
});

// ── applyStyle: wallpaper preload ────────────────────────────────────────────
const sky = (wallpaper, vars = { '--fg': '#fff' }) =>
  ({ id: 'sky', name: 'Sky', base: 'dark', icon: 'M0 0', vars, wallpaperUrl: `/styles/sky/${wallpaper}` });

test('wallpaper: assigned only after the image has decoded, not on request', async () => {
  FakeImage.instances.length = 0;
  setCustomStyles([sky('a.png')]);
  selectStyle('sky');
  assert.equal(FakeImage.instances.length, 1);
  assert.equal(FakeImage.instances[0].src, '/styles/sky/a.png');
  assert.notEqual(body.style.backgroundImage, 'url("/styles/sky/a.png")');
  FakeImage.instances[0].resolve();
  await tick();
  assert.equal(body.style.backgroundImage, 'url("/styles/sky/a.png")');
});

test('wallpaper: a change while a decode is in flight supersedes it — the stale one never lands', async () => {
  FakeImage.instances.length = 0;
  setCustomStyles([sky('b.png')]);
  setCustomStyles([sky('c.png')]);
  assert.equal(FakeImage.instances.length, 2);
  FakeImage.instances[1].resolve();
  await tick();
  assert.equal(body.style.backgroundImage, 'url("/styles/sky/c.png")');
  FakeImage.instances[0].resolve();
  await tick();
  assert.equal(body.style.backgroundImage, 'url("/styles/sky/c.png")');
});

test('wallpaper: a failed decode still assigns (degrades to the old behaviour, never a stuck wallpaper)', async () => {
  FakeImage.instances.length = 0;
  setCustomStyles([sky('d.png')]);
  FakeImage.instances[0].reject(new Error('EncodingError'));
  await tick();
  assert.equal(body.style.backgroundImage, 'url("/styles/sky/d.png")');
});

test('wallpaper: re-applying the same style requests nothing', () => {
  FakeImage.instances.length = 0;
  setCustomStyles([sky('d.png')]);
  assert.equal(FakeImage.instances.length, 0);
});

test('background: a raw CSS background value needs no asset and applies synchronously', () => {
  FakeImage.instances.length = 0;
  setCustomStyles([{ ...sky('d.png'), background: 'linear-gradient(red, blue)' }]);
  assert.equal(FakeImage.instances.length, 0);
  assert.equal(body.style.backgroundImage, 'linear-gradient(red, blue)');
});

test('wallpaper: with no Image constructor the URL is assigned synchronously', () => {
  const saved = globalThis.Image;
  delete globalThis.Image;
  try {
    setCustomStyles([sky('e.png')]);
    assert.equal(body.style.backgroundImage, 'url("/styles/sky/e.png")');
  } finally { globalThis.Image = saved; }
});

// ── applyStyle: palette untouched when only the wallpaper moved ──────────────
test('palette: a manifest that only repoints its wallpaper does not re-set vars or re-theme the terminal', async () => {
  let rethemes = 0;
  onThemeChange(() => { rethemes++; });
  setCustomStyles([sky('f.png', { '--fg': '#abc' })]);
  assert.equal(rethemes, 1);
  assert.equal(body.style.props.get('--fg'), '#abc');
  body.style.props.set('--sentinel', 'kept');
  setCustomStyles([sky('g.png', { '--fg': '#abc' })]);
  assert.equal(rethemes, 1);
  assert.equal(body.style.props.get('--sentinel'), 'kept');
  setCustomStyles([sky('g.png', { '--fg': '#def' })]);
  assert.equal(rethemes, 2);
  assert.equal(body.style.props.get('--fg'), '#def');
  onThemeChange(null);
});

test('the re-theme hook is told which style it now is, for api.onThemeChange', () => {
  const seen = [];
  onThemeChange((t) => seen.push(t));
  selectStyle('light');
  selectStyle('dark');
  assert.deepEqual(seen, [{ id: 'light', base: 'light' }, { id: 'dark', base: 'dark' }]);
  onThemeChange(null);
});

// ── a saved style that goes missing ──────────────────────────────────────────
test('a missing saved style shows Dark without overwriting cm-style, and comes back with its theme', () => {
  const writes = [];
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
  const seen = [];
  onThemeChange((t) => seen.push(t.id));
  try {
    setCustomStyles([sky('h.png', { '--fg': '#123' })]);
    selectStyle('sky');
    writes.length = 0;
    seen.length = 0;

    setCustomStyles([]);
    assert.deepEqual(seen, ['dark']);
    assert.match(renderThemeRows(), /class="theme-row active" data-id="dark"/);
    assert.deepEqual(writes, []);

    setCustomStyles([sky('h.png', { '--fg': '#123' })]);
    assert.deepEqual(seen, ['dark', 'sky']);
    assert.match(renderThemeRows(), /class="theme-row active" data-id="sky"/);
    assert.deepEqual(writes, []);

    setCustomStyles([]);
    seen.length = 0;
    selectStyle('sky');
    assert.deepEqual(writes, []);
    assert.deepEqual(seen, []);
    setCustomStyles([sky('h.png', { '--fg': '#123' })]);
    assert.deepEqual(seen, ['sky']);
  } finally {
    globalThis.localStorage = saved;
    onThemeChange(null);
  }
});

// ── themeButtonHtml ──────────────────────────────────────────────────────────
test('themeSwatch: reads the theme\'s own opaque panel, text and status colours from vars', () => {
  const sw = themeSwatch({ base: 'dark', vars: { '--bg': 'rgba(1,2,3,0.3)', '--panel-bg': '#1a0e2e', '--fg': '#e7e0ff', '--accent': '#ff2e88', '--green': 'rgb(0, 255, 156)', '--red': '#ff2d4f' } });
  assert.deepEqual(sw, { tile: '#1a0e2e', ink: '#e7e0ff', dots: ['#ff2e88', 'rgb(0, 255, 156)', '#ff2d4f'] });
});

test('themeSwatch: a built-in or a theme missing a colour takes its base\'s values', () => {
  assert.deepEqual(themeSwatch({ base: 'light', vars: {} }), { tile: '#fcfcfb', ink: '#1b1d21', dots: ['#4f46e5', '#3eb489', '#dc2626'] });
  assert.equal(themeSwatch({ base: 'dark', vars: { '--accent': '#abc' } }).tile, '#151b23');
  assert.equal(themeSwatch({ base: 'dark', vars: { '--surface': '#202020' } }).tile, '#202020');
});

test('themeSwatch: reads a raw theme.json colors block, for a theme /api/styles does not list', () => {
  const sw = themeSwatch({ base: 'dark', colors: { bg: 'rgba(1,2,3,0.3)', 'panel-bg': '#10406c', fg: '#eaf6ff', accent: '#22b8e0', green: '#46c98a', red: 'url(x)' } });
  assert.deepEqual(sw, { tile: '#10406c', ink: '#eaf6ff', dots: ['#22b8e0', '#46c98a', '#f85149'] });
});

test('safeColour: only plain hex/rgb/hsl values reach a style attribute', () => {
  assert.equal(safeColour('#ff2e88'), '#ff2e88');
  assert.equal(safeColour(' hsla(10, 20%, 30%, .5) '), 'hsla(10, 20%, 30%, .5)');
  for (const bad of ['red;background:url(//x)', '#fff;color:red', 'url(x)', 'var(--accent)', 'expression(1)', '"><img>', 7, null]) {
    assert.equal(safeColour(bad), null, String(bad));
  }
  const html = themeButtonHtml({ id: 'x', name: 'X', base: 'dark', vars: { '--panel-bg': '#000;background-image:url(//evil)' } });
  assert.doesNotMatch(html, /evil/);
  assert.match(html, /background:#151b23/);
});

test('themeButtonHtml: marks the chosen theme active and pressed, escapes text', () => {
  const s = { id: 'a"b', name: '<Sky>', base: 'light', vars: { '--accent': '#123456' } };
  const off = themeButtonHtml(s);
  assert.match(off, /^<button class="theme-row" data-id="a&quot;b" type="button" aria-pressed="false">/);
  assert.match(off, /&lt;Sky&gt;/);
  assert.match(off, /<i style="background:#123456"><\/i>/);
  assert.match(themeButtonHtml(s, { active: true }), /^<button class="theme-row active" data-id="a&quot;b" type="button" aria-pressed="true">/);
});

test('themeButtonHtml: tags fill and stroke icons so the tile can draw them at one weight', () => {
  assert.match(themeButtonHtml({ id: 'f', name: 'F', iconFill: true, iconViewBox: '0 0 512 512', icon: 'M0 0h512v512z' }), /class="icon icon-fill" viewBox="0 0 512 512"/);
  assert.match(themeButtonHtml({ id: 's', name: 'S', icon: 'M1 1L2 2' }), /class="icon icon-stroke" viewBox="0 0 24 24"/);
  assert.match(themeButtonHtml({ id: 'i', name: 'I', iconImageUrl: '/styles/i/icon.png' }), /<span class="theme-tile"[^>]*><img class="icon" src="\/styles\/i\/icon.png"/);
});
