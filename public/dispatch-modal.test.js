import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchModePresentation } from './dispatch-mode.js';

const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const dispatch = html.match(/<div id="m-dispatch-fields">([\s\S]*?)<\/div>\s*<div id="m-subagent"/)?.[1];

test('dispatch modal keeps the primary form compact and puts optional controls in Advanced options', () => {
  assert.ok(dispatch, 'dispatch form should exist');
  assert.match(dispatch, /<div class="mode-segmented" id="m-mode-cards" role="group" aria-label="Session type">/);
  assert.doesNotMatch(dispatch, /id="m-mode-helper"/);
  assert.doesNotMatch(dispatch, /class="mode-card"/);
  assert.match(dispatch, /class="mode-segment-desc">Free-text prompt in any folder\.<\/span>/);
  assert.match(dispatch, /class="mode-segment-desc">Issue to PR autopilot\.<\/span>/);

  const worktree = dispatch.indexOf('class="worktree-box"');
  const advanced = dispatch.indexOf('id="m-advanced-options"');
  assert.ok(worktree >= 0 && worktree < advanced, 'worktree controls should remain before Advanced options');
  assert.match(dispatch, /<details class="advanced-options" id="m-advanced-options">/);

  const advancedMarkup = dispatch.slice(advanced);
  assert.doesNotMatch(advancedMarkup, /id="m-effort"/);
  for (const id of ['m-runtime', 'm-auto-compact-presets', 'm-wf-auto-merge']) {
    assert.match(advancedMarkup, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(advancedMarkup, /id="m-auto-compact-tokens"/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="50000"[^>]*>50k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="100000"[^>]*>100k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="250000"[^>]*>250k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="500000"[^>]*>500k<\/button>/);
  assert.match(advancedMarkup, /data-auto-compact-tokens="1000000"[^>]*>1m<\/button>/);
});

test('workflow mode presentation updates the compact control and contextual copy', () => {
  assert.deepEqual(dispatchModePresentation('standard'), {
    standardPressed: true,
    workflowPressed: false,
    intentLabel: 'Intent / first prompt',
    intentPlaceholder: 'What should the agent work on?',
    launchLabel: 'Launch',
  });
  assert.deepEqual(dispatchModePresentation('workflow'), {
    standardPressed: false,
    workflowPressed: true,
    intentLabel: 'Issue (Jira key, GitHub issue, or description)',
    intentPlaceholder: 'ENT-1234, a GitHub issue URL or #number, or a free-text task',
    launchLabel: 'Start workflow',
  });
});

// ── The `dispatch.field` anchor hosts and the hideable core rows ──────────
test('the dispatch modal carries the three dispatch.field anchor hosts', () => {
  for (const at of ['top', 'model', 'advanced']) {
    assert.match(dispatch, new RegExp(`<div class="ext-dispatch-slot" data-at="${at}"></div>`));
  }
});

test('the `model` anchor host sits OUTSIDE #m-model-row, so hiding model keeps the extension control', () => {
  const rowStart = dispatch.indexOf('id="m-model-row"');
  const rowEnd = dispatch.indexOf('</div>', dispatch.indexOf('<select id="m-model">'));
  const host = dispatch.indexOf('data-at="model"');
  assert.ok(rowStart >= 0 && rowEnd > rowStart, '#m-model-row should wrap the model label and select');
  assert.ok(host > rowEnd, 'the model anchor host must come after #m-model-row closes, not inside it');
});

test('the `top` anchor host sits between the intent block and the Folder label', () => {
  const intent = dispatch.indexOf('id="m-intent"');
  const host = dispatch.indexOf('data-at="top"');
  const folder = dispatch.indexOf('<label>Folder (cwd)</label>');
  assert.ok(intent >= 0 && intent < host && host < folder, 'top host belongs after the intent block, before Folder');
});

test('the `advanced` anchor host is the last thing in the Advanced options body', () => {
  const body = dispatch.indexOf('class="advanced-options-body"');
  const autoMerge = dispatch.indexOf('id="m-wf-auto-merge-row"');
  const host = dispatch.indexOf('data-at="advanced"');
  assert.ok(body >= 0 && body < autoMerge && autoMerge < host, 'advanced host belongs inside the body, after the auto-merge row');
});

test('the effort row follows the `model` anchor host and precedes the worktree box', () => {
  const model = dispatch.indexOf('id="m-model-row"');
  const host = dispatch.indexOf('data-at="model"');
  const effort = dispatch.indexOf('id="m-effort-row"');
  const worktree = dispatch.indexOf('class="worktree-box"');
  assert.ok(model >= 0 && model < host && host < effort && effort < worktree,
    'effort row must sit after #m-model-row and its anchor host so effort-inline\'s sibling selectors still pair the two');
});

test('every hideable core field is wrapped in its own id\'d .dispatch-field row', () => {
  const rows = {
    'm-model-row': ['<label>Model</label>', 'id="m-model"'],
    'm-effort-row': ['<label>Effort</label>', 'id="m-effort"'],
    'm-auto-compact-row': ['<label>Auto-compaction threshold</label>', 'id="m-auto-compact-presets"'],
    'm-runtime-row': ['<label>Runtime</label>', 'id="m-runtime"'],
    'm-worktree-box-row': ['class="worktree-box"', 'id="m-worktree"'],
  };
  for (const [id, parts] of Object.entries(rows)) {
    const start = dispatch.indexOf(`<div class="dispatch-field" id="${id}">`);
    assert.ok(start >= 0, `${id} should exist as a .dispatch-field wrapper`);
    // Bounded by the next wrapper (or the end), so a part living in a SIBLING
    // row cannot satisfy this row's assertion.
    const rest = dispatch.slice(start + 1);
    const nextRow = rest.indexOf('<div class="dispatch-field"');
    const slice = nextRow >= 0 ? rest.slice(0, nextRow) : rest;
    for (const part of parts) assert.ok(slice.includes(part), `${id} should wrap ${part}`);
  }
});

test('the worktree box sits inside its own #m-worktree-box-row wrapper, the workflow note outside it', () => {
  const row = dispatch.indexOf('<div class="dispatch-field" id="m-worktree-box-row">');
  const box = dispatch.indexOf('<div class="worktree-box">');
  const note = dispatch.indexOf('id="m-wf-worktree-note"');
  assert.ok(row >= 0 && row < box && box < note);
});

// ── app.js behaviour, run from its own source ──────────────────────────────
// app.js cannot be imported under node:test (xterm, WebSocket and the live DOM
// at import — see module-syntax.test.js), so the functions under test are cut
// out of its source by brace-matching and run against a stub DOM. A `head` runs
// up to and including the body's opening brace (so a destructured parameter is
// not mistaken for it). Brace-naive, fine for the plain functions picked here.
const appSrc = readFileSync(join(import.meta.dirname, 'app.js'), 'utf8');
function appDecl(head) {
  const start = appSrc.indexOf(head);
  assert.ok(start >= 0 && head.endsWith('{'), `app.js should declare ${head}`);
  let depth = 0;
  for (let j = start + head.length - 1; j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}' && --depth === 0) return appSrc.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${head}`);
}
// `prelude` declares the free variables the cut-out declarations read; `names`
// are handed back so the test can call them.
function loadApp(heads, names, prelude, scope) {
  const body = `${prelude}\n${heads.map(appDecl).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function(...Object.keys(scope), body)(...Object.values(scope));
}

// Just enough <select>/<option> for the runtime picker: value reads the
// selected option, a value matching nothing reads back '' (as in a browser),
// and removing the selected option snaps the selection to the first one.
function stubOption(value = '') {
  return {
    value, textContent: '', dataset: {}, disabled: false, parent: null,
    remove() {
      const p = this.parent; const at = p.options.indexOf(this);
      const wasSelected = p.selectedIndex === at;
      p.options.splice(at, 1);
      if (wasSelected) p.selectedIndex = p.options.length ? 0 : -1;
      else if (p.selectedIndex > at) p.selectedIndex--;
    },
  };
}
function stubSelect(values) {
  const sel = {
    options: [],
    selectedIndex: 0,
    get value() { return this.options[this.selectedIndex]?.value ?? ''; },
    set value(v) { this.selectedIndex = this.options.findIndex((o) => o.value === v); },
    appendChild(o) { o.parent = this; this.options.push(o); return o; },
  };
  for (const v of values) sel.appendChild(stubOption(v));
  return sel;
}

function runtimeHarness(agent = 'claude') {
  const rt = stubSelect(['local', 'devcontainer']);
  const model = { selectedIndex: 0, options: [{ dataset: { agent } }] };
  const document = {
    getElementById: (id) => ({ 'm-runtime': rt, 'm-model': model })[id],
    createElement: () => stubOption(),
  };
  const app = loadApp(
    ['function syncRuntimeToggle() {', 'function syncExtRuntimeOptions() {'],
    ['syncExtRuntimeOptions', 'setExtensions'],
    'let latestExtensions = []; const setExtensions = (v) => { latestExtensions = v; };',
    { document },
  );
  return { rt, ...app };
}
const ext = (over = {}) => ({ id: 'sbx', enabled: true, quarantine: null, runtimes: [{ id: 'sandbox', label: 'Sandbox <b>' }], ...over });

test('an enabled, unquarantined extension\'s runtimes are appended to #m-runtime, tagged data-ext', () => {
  const { rt, syncExtRuntimeOptions, setExtensions } = runtimeHarness();
  setExtensions([ext()]);
  syncExtRuntimeOptions();
  syncExtRuntimeOptions(); // idempotent: never a second copy
  assert.deepEqual(rt.options.map((o) => [o.value, o.dataset.ext]), [['local', undefined], ['devcontainer', undefined], ['sandbox', 'sbx']]);
  assert.equal(rt.options[2].textContent, 'Sandbox <b>', 'the third-party label is set as text');
});

test('an extension runtime goes when its extension is disabled or quarantined, and a stale selection falls back to local', () => {
  for (const off of [{ enabled: false }, { quarantine: { reason: 'boom' }, runtimes: [] }, { quarantine: { reason: 'boom' } }]) {
    const { rt, syncExtRuntimeOptions, setExtensions } = runtimeHarness();
    setExtensions([ext()]);
    syncExtRuntimeOptions();
    rt.value = 'sandbox';
    setExtensions([ext(off)]);
    syncExtRuntimeOptions();
    assert.deepEqual(rt.options.map((o) => o.value), ['local', 'devcontainer'], JSON.stringify(off));
    assert.equal(rt.value, 'local');
  }
});

test('a surviving selection is kept across a reconcile, and a built-in id is never shadowed', () => {
  const { rt, syncExtRuntimeOptions, setExtensions } = runtimeHarness();
  setExtensions([ext({ runtimes: [{ id: 'sandbox', label: 'Sandbox' }, { id: 'devcontainer', label: 'Theirs' }] })]);
  syncExtRuntimeOptions();
  rt.value = 'devcontainer';
  setExtensions([ext({ runtimes: [{ id: 'sandbox', label: 'Sandbox' }, { id: 'vm', label: 'VM' }] })]);
  syncExtRuntimeOptions();
  assert.deepEqual(rt.options.map((o) => [o.value, o.dataset.ext]), [['local', undefined], ['devcontainer', undefined], ['sandbox', 'sbx'], ['vm', 'sbx']]);
  assert.equal(rt.value, 'devcontainer');
});

test('an extension runtime is Claude-only like every non-local runtime', () => {
  const { rt, syncExtRuntimeOptions, setExtensions } = runtimeHarness('codex');
  setExtensions([ext()]);
  syncExtRuntimeOptions();
  assert.equal(rt.options.find((o) => o.value === 'sandbox').disabled, true);
});

test('openModal adds the extension runtimes BEFORE restoring a saved runtime, and falls back to local', () => {
  const open = appDecl('function openModal({ mode, taskId = null, schedule = null }) {');
  const sync = open.indexOf('syncExtRuntimeOptions()');
  const restore = open.indexOf(".value = d.runtime || 'local'");
  assert.ok(sync >= 0 && restore > sync, 'syncExtRuntimeOptions must run before the runtime prefill');
  assert.match(open.slice(restore), /if \(rtSel\.value !== \(d\.runtime \|\| 'local'\)\) rtSel\.value = 'local';/);
  assert.match(appDecl('function syncClientExtensions() {'), /syncExtRuntimeOptions\(\);/);
});

// The real #m-runtime wiring line, the real syncDispatchExtFields /
// applyDispatchFieldVeto / DISPATCH_FIELD_ROWS and the real slots.js, against
// a stub modal.
async function dispatchExtHarness() {
  const { createSlots } = await import('./slots.js');
  const make = () => {
    const classes = new Set();
    const el = {
      children: [], dataset: {}, className: '', parentNode: null, listeners: {},
      classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
      appendChild(c) { this.children.push(c); c.parentNode = el; return c; },
      removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      fire(type) { for (const fn of this.listeners[type] || []) fn({ target: el }); },
    };
    return el;
  };
  const els = Object.fromEntries(['m-runtime', 'm-model-row', 'm-effort-row', 'm-auto-compact-row', 'm-runtime-row', 'm-worktree-box-row', 'worktree-box']
    .map((id) => [id, make()]));
  els['m-runtime'].value = 'local';
  const top = make(); top.dataset.at = 'top';
  const document = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: (q) => (q === '.ext-dispatch-slot' ? [top] : []),
    createElement: () => make(),
  };
  const slots = createSlots({ document, storage: null, onError: () => {}, hideDispatchFieldsFor: (id) => (id === 'x' ? ['worktree', 'runtime'] : []) });
  const wiring = appSrc.match(/^document\.getElementById\('m-runtime'\)\.addEventListener\('change', syncDispatchExtFields\);$/m)?.[0];
  assert.ok(wiring, 'app.js should wire #m-runtime change to syncDispatchExtFields');
  const app = loadApp(
    ['const DISPATCH_FIELD_ROWS = {', 'function dispatchFieldCtx(core = readCoreDispatchFields()) {', 'function applyDispatchFieldVeto(ctx) {', 'function syncDispatchExtFields() {'],
    ['syncDispatchExtFields', 'setModalMode'],
    `let modalMode = 'launch'; const setModalMode = (m) => { modalMode = m; };
     const scheduleMode = () => false; const availableAgents = [];
     const readCoreDispatchFields = () => ({ runtime: document.getElementById('m-runtime').value });
     const extApi = {}; const latestGraph = null;
     ${wiring}`,
    { document, slots },
  );
  return { els, slots, ...app };
}

test('a change on #m-runtime re-syncs dispatch.field contributions with the new runtime', async () => {
  const { els, slots, syncDispatchExtFields } = await dispatchExtHarness();
  const seen = [];
  slots.register('dispatch.field', 'x', { id: 'a', at: 'top', mount() {}, update: (el, ctx) => seen.push(ctx.draft.runtime) });
  syncDispatchExtFields();
  els['m-runtime'].value = 'sandbox';
  els['m-runtime'].fire('change');
  assert.deepEqual(seen, ['local', 'sandbox']);
});

test('the worktree veto toggles only #m-worktree-box-row, never the inner .worktree-box', async () => {
  const { els, slots, syncDispatchExtFields, setModalMode } = await dispatchExtHarness();
  slots.register('dispatch.field', 'x', { id: 'a', at: 'top', mount() {}, hides: (draft) => (draft?.runtime === 'sandbox' ? ['worktree'] : []) });
  els['worktree-box'].classList.toggle('hidden', true); // syncWorkflow's own state, e.g. workflow mode
  syncDispatchExtFields();
  assert.equal(els['m-worktree-box-row'].classList.contains('hidden'), false);
  els['m-runtime'].value = 'sandbox';
  els['m-runtime'].fire('change');
  assert.equal(els['m-worktree-box-row'].classList.contains('hidden'), true);
  assert.equal(els['m-runtime-row'].classList.contains('hidden'), false);
  assert.equal(els['worktree-box'].classList.contains('hidden'), true, 'the veto must not touch the inner box');
  // Subagent mode tears every contribution down, which lifts the veto.
  setModalMode('subagent');
  syncDispatchExtFields();
  assert.equal(els['m-worktree-box-row'].classList.contains('hidden'), false);
  assert.equal(els['worktree-box'].classList.contains('hidden'), true);
});
