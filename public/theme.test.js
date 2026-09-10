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

const { safeIconUrl, selectStyle, setCustomStyles, onThemeChange } = await import('./theme.js');

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
