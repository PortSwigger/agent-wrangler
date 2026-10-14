import { createAdditionalFolders } from './additional-folders.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchModePresentation } from './dispatch-mode.js';
import { createBoardOpen } from './board-open.js';

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
  const add = { addEventListener() {} };
  const additionalFolders = createAdditionalFolders({ list: {}, add, send() {} });
  const note = { hidden: true, classList: { toggle: (_name, hidden) => { note.hidden = hidden; } } };
  const document = {
    getElementById: (id) => ({ 'm-runtime': rt, 'm-model': model, 'm-add-dirs-note': note })[id],
    createElement: () => stubOption(),
  };
  const app = loadApp(
    ['function syncRuntimeToggle() {', 'function syncExtRuntimeOptions() {'],
    ['syncExtRuntimeOptions', 'syncRuntimeToggle', 'setExtensions'],
    'let latestExtensions = []; const setExtensions = (v) => { latestExtensions = v; };',
    { document, additionalFolders },
  );
  return { rt, add, note, ...app };
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
  const els = Object.fromEntries(['m-runtime', 'm-quick-launch-row', 'm-quick-launch', 'm-model-row', 'm-effort-row', 'm-auto-compact-row', 'm-runtime-row', 'm-worktree-box-row', 'worktree-box']
    .map((id) => [id, make()]));
  els['m-runtime'].value = 'local';
  const top = make(); top.dataset.at = 'top';
  const document = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: (q) => (q === '.ext-dispatch-slot' ? [top] : []),
    createElement: () => make(),
  };
  const slots = createSlots({ document, storage: null, onError: () => {}, hideDispatchFieldsFor: (id) => (id === 'x' ? ['worktree', 'runtime'] : id === 'q' ? ['quickLaunch'] : []) });
  const wiring = appSrc.match(/^document\.getElementById\('m-runtime'\)\.addEventListener\('change', syncDispatchExtFields\);$/m)?.[0];
  assert.ok(wiring, 'app.js should wire #m-runtime change to syncDispatchExtFields');
  const app = loadApp(
    ['const DISPATCH_FIELD_ROWS = {', 'function dispatchFieldHidden(name) {', 'function dispatchFieldCtx(core = readCoreDispatchFields()) {', 'function applyDispatchFieldVeto(ctx) {', 'function syncDispatchExtFields() {', 'function openDispatchExtFields(saved) {', 'function scheduleMode() {'],
    ['syncDispatchExtFields', 'openDispatchExtFields', 'setModalMode', 'dispatchFieldHidden', 'setGraph'],
    `let modalMode = 'launch'; const setModalMode = (m) => { modalMode = m; };
     const availableAgents = [];
     const readCoreDispatchFields = () => ({ runtime: document.getElementById('m-runtime').value });
     let vetoedDispatchFields = new Set();
     const extApi = {}; let latestGraph = null; let latestHistory = [];
     const setGraph = (g, h) => { latestGraph = g; if (h) latestHistory = h; };
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

test('openModal fires the per-open hook once, after its last sync and just before the modal is shown', () => {
  const open = appDecl('function openModal({ mode, taskId = null, schedule = null }) {');
  const calls = open.match(/openDispatchExtFields\(/g) || [];
  assert.equal(calls.length, 1);
  const hook = open.indexOf('openDispatchExtFields(d.ext)');
  assert.ok(hook > open.lastIndexOf('syncDispatchExtFields()'), 'open() must follow the final anchor sync');
  assert.ok(hook > open.indexOf('syncWorktreeFields()'), 'open() must follow every core reset');
  assert.ok(hook < open.indexOf("modal.classList.remove('hidden')"), 'open() must run before the modal is shown');
  // The saved bag comes from the same `d` every core field is restored from.
  assert.match(open, /const d = \(action\?\.kind === 'dispatch' \? action\.dispatch : null\) \|\| \{\};/);
});

test('openDispatchExtFields hands open() editing, mode and its own saved slice', async () => {
  const { slots, syncDispatchExtFields, openDispatchExtFields, setModalMode } = await dispatchExtHarness();
  const seen = [];
  slots.register('dispatch.field', 'x', { id: 'a', at: 'top', mount() {}, open: (el, ctx) => seen.push([ctx.mode, ctx.editing, ctx.saved, ctx.draft.runtime]) });
  syncDispatchExtFields();
  openDispatchExtFields(undefined);
  setModalMode('schedule-create');
  openDispatchExtFields(undefined);
  setModalMode('schedule-edit');
  openDispatchExtFields({ x: { usd: 50 }, y: { usd: 1 } });
  openDispatchExtFields({ y: { usd: 1 } });
  assert.deepEqual(seen, [
    ['launch', false, null, 'local'],
    ['schedule', false, null, 'local'],
    ['schedule', true, { usd: 50 }, 'local'],
    // Editing a schedule saved with nothing for this extension: null, but editing.
    ['schedule', true, null, 'local'],
  ]);
});

test('a throwing open() lifts its veto before the modal is shown', async () => {
  const { els, slots, syncDispatchExtFields, openDispatchExtFields } = await dispatchExtHarness();
  slots.register('dispatch.field', 'x', { id: 'a', at: 'top', hides: ['runtime'], mount() {}, open() { throw new Error('boom'); } });
  syncDispatchExtFields();
  assert.equal(els['m-runtime-row'].classList.contains('hidden'), true);
  openDispatchExtFields(undefined);
  assert.equal(els['m-runtime-row'].classList.contains('hidden'), false);
});

test('runtime selection disables folder assignment for devcontainers and restores it for local agents', () => {
  const { rt, add, note, syncRuntimeToggle } = runtimeHarness();
  rt.value = 'devcontainer';
  syncRuntimeToggle();
  assert.equal(add.disabled, true);
  assert.equal(note.hidden, false);
  rt.value = 'local';
  syncRuntimeToggle();
  assert.equal(add.disabled, false);
  assert.equal(note.hidden, true);
  const codex = runtimeHarness('codex');
  codex.rt.value = 'devcontainer';
  codex.syncRuntimeToggle();
  assert.equal(codex.rt.value, 'local');
  assert.equal(codex.add.disabled, false);
});

test('extension runtimes disable additional folder grants until Local is selected', () => {
  const { rt, add, note, syncRuntimeToggle, syncExtRuntimeOptions, setExtensions } = runtimeHarness();
  setExtensions([ext()]);
  syncExtRuntimeOptions();
  rt.value = 'sandbox';
  syncRuntimeToggle();
  assert.equal(add.disabled, true);
  assert.equal(note.hidden, false);
  rt.value = 'local';
  syncRuntimeToggle();
  assert.equal(add.disabled, false);
  assert.equal(note.hidden, true);
});

test('Codex quick launch restores retained grants when switching from a non-local Claude runtime', () => {
  for (const runtime of ['devcontainer', 'sandbox']) {
    const rt = stubSelect(['local', runtime]);
    const model = stubSelect(['claude-model', 'codex-model']);
    model.options[0].dataset.agent = 'claude';
    model.options[1].dataset.agent = 'codex';
    const element = () => ({ append() {}, replaceChildren() {}, addEventListener() {} });
    const document = {
      createElement: element,
      getElementById: (id) => ({
        'm-runtime': rt, 'm-model': model,
        'm-add-dirs-note': { classList: { toggle() {} } },
      })[id] || { value: '', checked: false },
    };
    const additionalFolders = createAdditionalFolders({ list: element(), add: element(), document, send() {} });
    additionalFolders.reset(['/extra']);
    const app = loadApp(
      ['function quickLaunch(value) {', 'function syncRuntimeToggle() {', 'function readCoreDispatchFields() {'],
      ['quickLaunch', 'syncRuntimeToggle', 'dispatched'],
      `let modelEdited = false; const dispatchMode = 'standard'; const reviewMode = false;
       const autoCompactTokens = undefined; const parentSessionId = null;
       const dispatched = []; const submitDispatch = () => dispatched.push(readCoreDispatchFields());`,
      { document, additionalFolders, modal: { classList: { contains: () => false } },
        scheduleMode: () => false, cwdField: () => '/repo' },
    );
    rt.value = runtime;
    app.syncRuntimeToggle();
    assert.deepEqual(additionalFolders.values(), []);
    app.quickLaunch('codex-model');
    assert.equal(app.dispatched[0].agent, 'codex');
    assert.equal(app.dispatched[0].runtime, undefined);
    assert.deepEqual(app.dispatched[0].addDirs, ['/extra']);
  }
});

function scheduleHarness(kind = 'dispatch', editing = false) {
  const sent = [];
  const state = { invalid: true, closed: false };
  const go = { disabled: false };
  const document = { getElementById: (id) => id === 'm-go' ? go : { value: id === 'm-sch-target' ? 'S1' : 'Example' } };
  const action = kind === 'dispatch' ? { kind, dispatch: { cwd: '/repo', addDirs: ['/extra'] } } : { kind: 'session', sessionId: 'S1' };
  const app = loadApp(
    ['function scheduleActionValid() {', 'function syncScheduleGo() {', 'function submitSchedule() {'],
    ['submitSchedule', 'syncScheduleGo'],
    `const scheduleAction = ${JSON.stringify(kind)}; const modalMode = ${JSON.stringify(editing ? 'schedule-edit' : 'schedule-create')}; const editingScheduleId = 'SCH1';`,
    {
      document, additionalFolders: { invalid: () => state.invalid },
      scheduleMode: () => true, readPicker: () => ({}), whenValid: () => true,
      compileWhen: () => '2027-01-01T09:00:00Z', readScheduleAction: () => action,
      send: (msg) => sent.push(msg), closeModal: () => { state.closed = true; },
      openSchedulesPanel() {}, toast() {},
    },
  );
  return { ...app, sent, state, go };
}

for (const editing of [false, true]) {
  test(`a known-invalid folder blocks dispatch schedule ${editing ? 'editing' : 'creation'}`, () => {
    const { submitSchedule, syncScheduleGo, sent, state, go } = scheduleHarness('dispatch', editing);
    syncScheduleGo();
    assert.equal(go.disabled, true);
    submitSchedule();
    assert.deepEqual(sent, []);
    assert.equal(state.closed, false);
    state.invalid = false;
    syncScheduleGo();
    assert.equal(go.disabled, false);
    submitSchedule();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, editing ? 'schedule-update' : 'schedule-create');
    assert.equal(state.closed, true);
  });
}

test('session schedules ignore folder errors in the unused dispatch fields', () => {
  const { submitSchedule, sent, go } = scheduleHarness('session');
  submitSchedule();
  assert.equal(sent[0].type, 'schedule-create');
  assert.equal(go.disabled, false);
});


test('session schedule includes focus only when checked; dispatch ignores it', () => {
  const fields = { 'm-sch-target': { value: 'CARD1' }, 'm-sch-message': { value: ' ping ' }, 'm-sch-focus': { checked: true } };
  const app = loadApp(['function readScheduleAction() {'], ['readScheduleAction'], "let scheduleAction = 'session';", {
    document: { getElementById: (id) => fields[id] }, readDispatchFields: () => ({ intent: 'launch' }),
  });
  assert.deepEqual(app.readScheduleAction(), { kind: 'session', sessionId: 'CARD1', message: 'ping', focus: true });
  fields['m-sch-focus'].checked = false;
  assert.equal(app.readScheduleAction().focus, undefined);
  const dispatchApp = loadApp(['function readScheduleAction() {'], ['readScheduleAction'], "let scheduleAction = 'dispatch';", {
    document: { getElementById: (id) => fields[id] }, readDispatchFields: () => ({ intent: 'launch' }),
  });
  fields['m-sch-focus'].checked = true;
  assert.deepEqual(dispatchApp.readScheduleAction(), { kind: 'dispatch', dispatch: { intent: 'launch' } });
});

function scheduledFocusHarness(sessions = []) {
  const selected = [], landed = [], views = {}, notices = [];
  const diff = { open: false };
  const boardOpen = createBoardOpen();
  const clock = { now: 0 };
  const app = loadApp(
    ['function onScheduleFired(msg) {', 'function tryFulfillScheduledFocus() {', 'function tryFulfillPending() {'],
    ['onScheduleFired', 'tryFulfillScheduledFocus', 'state'],
    "let pendingSelect = null; let pendingScheduledFocus = null; let latestSessions = []; let currentView = 'search'; let maximized = false; const state = { set sessions(value) { latestSessions = value; }, get pending() { return pendingScheduledFocus?.sessionId ?? pendingScheduledFocus; }, get view() { return currentView; }, get pendingSelect() { return pendingSelect; }, set pendingSelect(v) { pendingSelect = v; } };",
    { Date: { now: () => clock.now }, toast: (msg) => notices.push(msg), selectSession: (id) => selected.push(id), setView: () => {}, setMaximized: () => {},
      landOnCard: (id, opts, select) => { landed.push(id); select(id); },
      setSessionView: (id, view) => { views[id] = view; }, disarmChatHandoff() {},
      isDiffPanelOpen: () => diff.open, closeDiffPanel: () => { diff.open = false; }, boardOpen },
  );
  app.state.sessions = sessions;
  return { ...app, boardOpen, selected, landed, views, notices, diff, clock };
}

test('focused schedule opens the live target terminal, unfocused schedule leaves selection alone', () => {
  const app = scheduledFocusHarness([{ sessionId: 'CARD1', managed: true }]);
  app.onScheduleFired({ name: 'Ping', sessionId: 'CARD1' });
  assert.deepEqual(app.selected, []);
  app.onScheduleFired({ name: 'Ping', sessionId: 'CARD1', focus: true });
  assert.deepEqual(app.selected, ['CARD1']);
  assert.equal(app.views.CARD1, 'terminal');
  assert.deepEqual(app.landed, ['CARD1']);
  assert.equal(app.state.pending, null);
});

test('focused schedule waits for resumed target to be live without requesting another resume', () => {
  const app = scheduledFocusHarness([{ sessionId: 'CARD1', managed: false }]);
  app.onScheduleFired({ name: 'Wake', sessionId: 'CARD1', focus: true });
  app.tryFulfillScheduledFocus();
  assert.deepEqual(app.selected, []);
  assert.equal(app.state.pending, 'CARD1');
  app.state.sessions = [{ sessionId: 'CARD1', managed: true }];
  app.tryFulfillScheduledFocus();
  assert.deepEqual(app.selected, ['CARD1']);
  assert.equal(app.views.CARD1, 'terminal');
});


test('scheduled focus dismisses a diff panel so the target terminal is visible', () => {
  const app = scheduledFocusHarness([{ sessionId: 'CARD1', managed: true }]);
  app.diff.open = true;
  app.onScheduleFired({ name: 'Ping', sessionId: 'CARD1', focus: true });
  assert.equal(app.diff.open, false);
  assert.deepEqual(app.selected, ['CARD1']);
});


test('scheduled focus discards an older pending select and board-open request', () => {
  const app = scheduledFocusHarness([{ sessionId: 'CARD1', managed: true }]);
  app.state.pendingSelect = 'OLD';
  app.boardOpen.request('OLD', { diff: true, onClose: null });
  app.onScheduleFired({ name: 'Ping', sessionId: 'CARD1', focus: true });
  assert.equal(app.state.pendingSelect, null);
  assert.equal(app.boardOpen.claim('OLD'), null);
});

test('scheduled focus expires after a failed resume instead of jumping to a later wake', () => {
  const app = scheduledFocusHarness([{ sessionId: 'CARD1', managed: false }]);
  app.onScheduleFired({ name: 'Wake', sessionId: 'CARD1', focus: true });
  app.diff.open = true;
  app.clock.now = 8000;
  app.state.sessions = [{ sessionId: 'CARD1', managed: true }];
  app.tryFulfillScheduledFocus();
  assert.equal(app.state.pending, null);
  assert.deepEqual(app.selected, []);
  assert.deepEqual(app.views, {});
  assert.equal(app.diff.open, true);
});

// ── openSessionInBoard: api.openSession / api.openDiff from an extension view ──
function boardOpenHarness(sessions = [], { minimised = [], tiles = {} } = {}) {
  const log = [];
  const boardOpen = createBoardOpen();
  const minimisedIds = new Set(minimised);
  const app = loadApp(
    ['function openSessionInBoard(sessionId, { diff = false, onClose = null } = {}) {', 'function landOnCard(sessionId, { diff, onClose }, select) {', 'function tryFulfillPending() {'],
    ['openSessionInBoard', 'tryFulfillPending', 'state'],
    "let pendingSelect = null; let latestSessions = []; let currentView = 'ext:jobs:board'; let maximized = false; const ADHOC_ID = 'adhoc'; const state = { set sessions(v) { latestSessions = v; }, get pending() { return pendingSelect; }, set maximized(v) { maximized = v; }, set view(v) { currentView = v; } };",
    {
      boardOpen, minimisedIds, CSS: { escape: (x) => x },
      setView: (v) => { log.push(`view:${v}`); app.state.view = v; },
      send: (f) => log.push(`send:${f.type}:${f.sessionId}`),
      toast: () => {},
      assignedTaskId: (sid) => tiles[sid] || null,
      unminimise: (id) => { minimisedIds.delete(id); log.push(`unminimise:${id}`); },
      focusSession: (sid) => log.push(`focus:${sid}`),
      selectSession: (sid) => log.push(`select:${sid}`),
      document: { querySelector: (sel) => ({ scrollIntoView: () => log.push(`scroll:${sel.match(/data-sid="([^"]+)"/)[1]}`) }) },
      setMaximized: (on) => log.push(`maximized:${on}`),
      openDiffPanel: (sid) => log.push(`diff:${sid}`),
    },
  );
  app.state.sessions = sessions;
  return { ...app, log, boardOpen, minimisedIds };
}

test('openSession on a live card shows the grid, restores its tile from the tray and scrolls to it', () => {
  const app = boardOpenHarness([{ sessionId: 'S1' }], { minimised: ['T1'], tiles: { S1: 'T1' } });
  app.openSessionInBoard('S1');
  assert.deepEqual(app.log, ['view:grid', 'unminimise:T1', 'focus:S1', 'scroll:S1']);
});

test('openSession on an archived card restores it, then lands on it when the graph brings it back', () => {
  const app = boardOpenHarness([], { minimised: ['adhoc'] });
  app.openSessionInBoard('S1');
  assert.deepEqual(app.log, ['view:grid', 'send:resume:S1']);
  assert.equal(app.state.pending, 'S1');
  app.tryFulfillPending();
  assert.equal(app.log.length, 2, 'nothing to land on until the card is back');
  app.state.sessions = [{ sessionId: 'S1' }];
  app.tryFulfillPending();
  // selectSession, not focusSession: the card has just been resumed, so it must
  // not be resumed again.
  assert.deepEqual(app.log.slice(2), ['unminimise:adhoc', 'select:S1', 'scroll:S1']);
});

test('openDiff on a live card lands on it, then opens its diff panel and reports the close', () => {
  const app = boardOpenHarness([{ sessionId: 'S1' }]);
  app.state.maximized = true;
  let closed = 0;
  app.openSessionInBoard('S1', { diff: true, onClose: () => { closed += 1; } });
  assert.deepEqual(app.log, ['view:grid', 'focus:S1', 'scroll:S1', 'maximized:false', 'diff:S1']);
  app.boardOpen.diffClosed('S1');
  assert.equal(closed, 1);
});

test('openDiff on an archived card opens the diff only once the restored card is back', () => {
  const app = boardOpenHarness([]);
  let closed = 0;
  app.openSessionInBoard('S1', { diff: true, onClose: () => { closed += 1; } });
  assert.ok(!app.log.includes('diff:S1'));
  app.state.sessions = [{ sessionId: 'S1' }];
  app.tryFulfillPending();
  assert.deepEqual(app.log.slice(-3), ['select:S1', 'scroll:S1', 'diff:S1']);
  app.boardOpen.diffClosed('S1');
  assert.equal(closed, 1);
});

test('a live card asked for while another is restoring drops the restore\'s pending jump', () => {
  const app = boardOpenHarness([{ sessionId: 'S2' }]);
  app.openSessionInBoard('S1', { diff: true });
  app.openSessionInBoard('S2');
  assert.equal(app.state.pending, null);
  app.state.sessions = [{ sessionId: 'S1' }, { sessionId: 'S2' }];
  app.tryFulfillPending();
  assert.ok(!app.log.includes('select:S1') && !app.log.includes('diff:S1'), 'S1 coming back does not steal the board');
});

// ── quickLaunch as a hideable field (1.28.0) ───────────────────────────────
test('#m-quick-launch sits inside its own #m-quick-launch-row wrapper in .modal-actions', () => {
  const actions = html.slice(html.indexOf('<div class="modal-actions">'));
  const row = actions.indexOf('<div class="dispatch-field quick-launch-row" id="m-quick-launch-row">');
  const inner = actions.indexOf('<div class="quick-launch" id="m-quick-launch">');
  const cancel = actions.indexOf('id="m-cancel"');
  assert.ok(row >= 0 && row < inner && inner < cancel);
});

test('a quickLaunch veto hides #m-quick-launch-row and gates the ⌘1–⌘3 binding; removing it brings both back', async () => {
  const { els, slots, syncDispatchExtFields, dispatchFieldHidden } = await dispatchExtHarness();
  slots.register('dispatch.field', 'q', { id: 'ql', at: 'top', mount() {}, hides: ['quickLaunch'] });
  els['m-quick-launch'].classList.toggle('hidden', true); // syncQuickLaunch's schedule-mode state
  syncDispatchExtFields();
  assert.equal(els['m-quick-launch-row'].classList.contains('hidden'), true);
  assert.equal(dispatchFieldHidden('quickLaunch'), true);
  slots.removeExtension('q');
  syncDispatchExtFields();
  assert.equal(els['m-quick-launch-row'].classList.contains('hidden'), false);
  assert.equal(dispatchFieldHidden('quickLaunch'), false);
  assert.equal(els['m-quick-launch'].classList.contains('hidden'), true, 'the veto must not touch the inner group');
  // The core binding's `when` reads the same veto, so it falls through to an
  // extension binding on the same keys (keybindings.js tries the next candidate).
  const binding = appSrc.slice(appSrc.indexOf("'dispatch.quickLaunch': {"));
  assert.match(binding.slice(0, binding.indexOf('run:')), /when: \(e\) => inDispatchModal\(e\) && !scheduleMode\(\) && !dispatchFieldHidden\('quickLaunch'\)/);
});

test('dispatch.field update sees the cached history on a tick whose graph carried none', async () => {
  const { slots, syncDispatchExtFields, setGraph } = await dispatchExtHarness();
  const seen = [];
  slots.register('dispatch.field', 'x', { id: 'a', at: 'top', mount() {}, update: (el, ctx, graph) => seen.push(graph) });
  setGraph({ sessions: [{ sessionId: 's' }] }, [{ sessionId: 'h', model: 'opus', effort: 'high' }]);
  syncDispatchExtFields();
  assert.deepEqual(seen.at(-1).history, [{ sessionId: 'h', model: 'opus', effort: 'high' }]);
  assert.deepEqual(seen.at(-1).sessions, [{ sessionId: 's' }]);
});

// ── submitDispatchFromExt (api.dispatch.submit, 1.28.0) ────────────────────
function extSubmitHarness({ mode = 'launch', hidden = false, images = [], imagesBusy = false, runtimeAgentGate = true } = {}) {
  const model = stubSelect(['opus', 'sonnet']);
  const runtime = stubSelect(['local', 'devcontainer']);
  for (const [id, ext] of [['bifrost', 'bifrost'], ['toy', 'toy']]) { const o = runtime.appendChild(stubOption(id)); o.dataset.ext = ext; }
  const effort = stubSelect(['', 'low', 'high']);
  const modalClasses = new Set(hidden ? ['hidden'] : []);
  const sent = []; const calls = [];
  const state = { cwdBlocked: false, effortsAfterModel: null };
  const els = { 'm-model': model, 'm-effort': effort, 'm-intent': { value: 'x' }, 'm-runtime': runtime };
  const document = { getElementById: (id) => els[id] || { classList: { remove() {}, add() {} } } };
  const app = loadApp(
    ['function scheduleMode() {', 'function readDispatchFields() {', 'function dispatchFieldCtx(core = readCoreDispatchFields()) {', 'function submitDispatch(over) {', 'function submitDispatchFromExt({ model, effort, runtime } = {}) {', 'function runtimeOwnsModel(extId, runtimeId) {'],
    ['submitDispatchFromExt', 'flags'],
    `let modalMode = ${JSON.stringify(mode)}; let modelEdited = false; let effortEdited = false;
     let wtPending = false; const dispatchMode = 'standard'; const wtValidation = null; const availableAgents = [];
     const flags = () => ({ modelEdited, effortEdited });
     const latestExtensions = [{ id: 'bifrost', runtimes: [{ id: 'bifrost', ownsModel: true }] }, { id: 'toy', runtimes: [{ id: 'toy', ownsModel: false }] }];
     const readCoreDispatchFields = () => { const rt = document.getElementById('m-runtime').value; return { model: document.getElementById('m-model').value, effort: document.getElementById('m-effort').value || undefined, worktree: false, addDirs: [], runtime: rt !== 'local' ? rt : undefined }; };
     const syncRuntimeToggle = () => { calls.push('syncRuntimeToggle'); if (state.snapRuntime) document.getElementById('m-runtime').value = 'local'; };
     const syncDispatchExtFields = () => calls.push('syncDispatchExtFields');
     const populateEffortSelect = () => { calls.push('populateEffortSelect'); if (state.effortsAfterModel) { const e = document.getElementById('m-effort'); e.options.length = 0; for (const v of state.effortsAfterModel) e.appendChild(stubOption(v)); } };`,
    {
      document, stubOption, calls, state,
      modal: { classList: { contains: (c) => modalClasses.has(c), add: (c) => modalClasses.add(c) } },
      slots: { dispatchFields: () => (state.extSlices ? { extra: 1, ext: state.extSlices } : { extra: 1 }) },
      cwdBlocked: () => state.cwdBlocked, renderCwdState() {},
      additionalFolders: { invalid: () => false },
      send: (m) => sent.push(m), dispatchWaiter: { submit() {} }, toast() {},
      submitSchedule: () => calls.push('submitSchedule'), worktreeStatusMsg: () => null, setDispatchPending() {},
      intentImages: { busy: () => imagesBusy, names: () => images.slice(), reset: () => { state.imageResets = (state.imageResets || 0) + 1; } },
    },
  );
  return { app, sent, calls, state, modalClasses };
}

test('dispatch.submit rejects unless the modal is open in launch mode', () => {
  for (const opts of [{ hidden: true }, { mode: 'schedule-create' }, { mode: 'schedule-edit' }, { mode: 'subagent' }]) {
    const { app, sent, calls } = extSubmitHarness(opts);
    assert.throws(() => app.submitDispatchFromExt({}), /not open in launch mode/);
    assert.deepEqual(sent, []);
    assert.ok(!calls.includes('submitSchedule'));
  }
});

test('dispatch.submit sets model + effort, marks both edited, and sends them with the fields() merge', () => {
  const { app, sent, calls, modalClasses } = extSubmitHarness();
  assert.equal(app.submitDispatchFromExt({ model: 'sonnet', effort: 'high' }), true);
  assert.deepEqual(app.flags(), { modelEdited: true, effortEdited: true });
  assert.deepEqual(calls, ['syncRuntimeToggle', 'populateEffortSelect']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'dispatch');
  assert.equal(sent[0].model, 'sonnet');
  assert.equal(sent[0].effort, 'high');
  assert.equal(sent[0].extra, 1);
  assert.ok(modalClasses.has('hidden'), 'a plain launch closes the modal');
});

test('dispatch.submit with no options launches whatever the modal holds', () => {
  const { app, sent } = extSubmitHarness();
  app.submitDispatchFromExt();
  assert.equal(sent[0].model, 'opus');
  assert.deepEqual(app.flags(), { modelEdited: false, effortEdited: false });
});

test('dispatch.submit rejects a model or effort the modal does not offer', () => {
  let h = extSubmitHarness();
  assert.throws(() => h.app.submitDispatchFromExt({ model: 'haiku' }), /model not offered: haiku/);
  assert.deepEqual(h.sent, []);
  h = extSubmitHarness();
  assert.throws(() => h.app.submitDispatchFromExt({ effort: 'max' }), /effort not offered: max/);
  assert.deepEqual(h.sent, []);
  // Efforts are checked AFTER the model change repopulates them.
  h = extSubmitHarness();
  h.state.effortsAfterModel = ['', 'low'];
  assert.throws(() => h.app.submitDispatchFromExt({ model: 'sonnet', effort: 'high' }), /effort not offered: high/);
});

test('dispatch.submit sets an offered runtime and lets the ext fields redraw for it', () => {
  const { app, sent, calls } = extSubmitHarness();
  assert.equal(app.submitDispatchFromExt({ model: 'sonnet', runtime: 'devcontainer' }), true);
  assert.deepEqual(calls, ['syncRuntimeToggle', 'populateEffortSelect', 'syncRuntimeToggle', 'syncDispatchExtFields']);
  assert.equal(sent[0].runtime, 'devcontainer');
  assert.equal(sent[0].model, 'sonnet');
  assert.equal('ext' in sent[0], false);
});

test('dispatch.submit hands a model-owning runtime its model as ext.<extId>.model, leaving the core model alone', () => {
  const { app, sent, state } = extSubmitHarness();
  state.extSlices = { bifrost: { other: 1 } };
  assert.equal(app.submitDispatchFromExt({ model: 'gpt-5.4', effort: 'high', runtime: 'bifrost' }), true);
  assert.equal(sent[0].runtime, 'bifrost');
  assert.equal(sent[0].model, 'opus', 'the core select is untouched');
  assert.equal(sent[0].effort, 'high');
  assert.deepEqual(sent[0].ext, { bifrost: { other: 1, model: 'gpt-5.4' } });
  assert.deepEqual(app.flags(), { modelEdited: false, effortEdited: true });
});

test('dispatch.submit still checks the model against the modal for a runtime that does not own its models', () => {
  const { app, sent } = extSubmitHarness();
  assert.throws(() => app.submitDispatchFromExt({ model: 'gpt-5.4', runtime: 'toy' }), /model not offered: gpt-5.4/);
  assert.deepEqual(sent, []);
});

test('dispatch.submit rejects a runtime the modal does not offer, or one the model\'s agent snaps back', () => {
  let h = extSubmitHarness();
  assert.throws(() => h.app.submitDispatchFromExt({ runtime: 'nope' }), /runtime not offered: nope/);
  assert.deepEqual(h.sent, []);
  h = extSubmitHarness();
  h.state.snapRuntime = true;
  assert.throws(() => h.app.submitDispatchFromExt({ runtime: 'devcontainer' }), /runtime not offered for this model: devcontainer/);
  assert.deepEqual(h.sent, []);
});

test('dispatch.submit rejects when core validation blocks the launch', () => {
  const { app, sent, state } = extSubmitHarness();
  state.cwdBlocked = true;
  assert.throws(() => app.submitDispatchFromExt({ model: 'opus' }), /dispatch blocked by validation/);
  assert.deepEqual(sent, []);
});

test('dispatch carries the intent box images by name, then clears them so a relaunch cannot reuse them', () => {
  const { app, sent, state } = extSubmitHarness({ images: ['paste-1-abcd.png'] });
  assert.equal(app.submitDispatchFromExt(), true);
  assert.deepEqual(sent[0].imageNames, ['paste-1-abcd.png']);
  assert.equal(state.imageResets, 1);
  const plain = extSubmitHarness();
  plain.app.submitDispatchFromExt();
  assert.equal('imageNames' in plain.sent[0], false, 'no images, no field');
});

test('dispatch waits while an intent image is still uploading', () => {
  const { app, sent } = extSubmitHarness({ images: [], imagesBusy: true });
  assert.throws(() => app.submitDispatchFromExt(), /blocked/);
  assert.equal(sent.length, 0);
});
