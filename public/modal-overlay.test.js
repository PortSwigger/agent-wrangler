import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(here, 'styles.css'), 'utf8');

// A dialog's overlay and its `.hidden` rule are per-id in styles.css — some
// share one selector list, others have their own block — and nothing generates
// either, so a modal added to index.html and styled nowhere fails in a way that
// does not read as "missing backdrop": with no `position: fixed` it renders
// INLINE in the page flow as a permanently-visible panel, and with no `.hidden`
// rule nothing takes it away again, while its buttons stay dead because the open
// function is what attaches their listeners. #ext-consent-modal shipped exactly
// that way and read as a stray "Install extension" panel at the bottom of every
// page. So the markup is the source of truth and the CSS is asserted against it.
function modalIds() {
  // A dialog is a top-level `<div id="…" class="hidden">` whose FIRST element is
  // a `.modal-card`. Matched on that rather than a naming convention: the ids are
  // not uniformly suffixed (`#modal`, `#settings-modal`), and the card is what
  // makes one a dialog rather than a banner or a toast (`#system-banner` and
  // `#toast` are hidden top-level divs too, and are deliberately not overlays).
  const ids = [];
  const re = /<div id="([a-z0-9-]+)" class="hidden">\s*\n\s*<div[^>]*class="([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    if (/\bmodal-card\b/.test(m[2])) ids.push(m[1]);
  }
  return ids;
}

// Every rule block whose selector mentions the id, so the assertion below can
// ask whether ANY of them makes it an overlay — the ids are spread across a
// shared selector list and several per-modal blocks.
function blocksFor(id) {
  return css.match(new RegExp(`[^}]*?#${id}[,\\s]*[^{}]*\\{[^}]*\\}`, 'g')) || [];
}

test('every modal in index.html has an overlay rule and a hidden rule', () => {
  const ids = modalIds();
  // A guard on the scraper: if the markup shape changes and this stops matching,
  // fail loudly rather than silently assert nothing.
  assert.ok(ids.length >= 8, `expected to find the board's modals, found ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('ext-consent-modal'), 'the extension consent modal should be among them');

  for (const id of ids) {
    const overlay = blocksFor(id).filter((b) => /position:\s*fixed/.test(b));
    assert.ok(overlay.length, `#${id} has no rule setting position: fixed — it will render inline in the page flow as a visible panel`);
    assert.match(css, new RegExp(`#${id}\\.hidden[^{]*\\{[^}]*display:\\s*none`), `#${id}.hidden does not set display: none — nothing will ever hide it`);
  }
});
