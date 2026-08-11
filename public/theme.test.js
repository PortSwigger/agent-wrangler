import { test } from 'node:test';
import assert from 'node:assert/strict';

// theme.js's safeIconUrl resolves against the global `location`, so stub it
// before importing — same pattern as diff-dom.test.js's `document` stub.
globalThis.location = { origin: 'http://localhost' };

const { safeIconUrl } = await import('./theme.js');

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
