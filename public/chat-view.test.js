import test from 'node:test';
import assert from 'node:assert/strict';

// chat-view.js had NO tests, and the two bugs that reached a human both lived in
// exactly the state it owns: a composer value that outlived its session, and an
// Esc restore that replayed a stale value. Neither was reachable from
// chat-dom/chat-group/chat-handoff, which is where the existing coverage stops.
//
// No jsdom, matching the rest of public/. Instead the handful of DOM calls the
// module actually makes (10 getElementById, 5 createElement, one querySelector,
// addEventListener, and window.markdownit) are stubbed, and the module is imported
// dynamically AFTER the globals are installed — it reads `document` at call time
// inside initChatView, but markdown-preview.js reads `window.markdownit` when the
// factory runs, so ordering matters.
const descend = (node, sel) => {
  const want = String(sel).replace(/^\./, '');
  const out = [];
  for (const c of node.children || []) {
    if (String(c.className || '').split(/\s+/).includes(want)) out.push(c);
    out.push(...descend(c, sel));
  }
  return out;
};

function stubDom() {
  const listeners = new Map();
  const make = (tag = 'div') => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      dataset: {},
      style: {},
      attrs: {},
      value: '',
      hidden: false,
      disabled: false,
      placeholder: '',
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      selectionStart: 0,
      selectionEnd: 0,
      _text: null,
      _html: null,
      _events: new Map(),
      appendChild(c) { c._parent = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(type, fn) {
        if (!this._events.has(type)) this._events.set(type, []);
        this._events.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of this._events.get(ev.type) || []) fn(ev);
        return true;
      },
      focus() {},
      remove() { this._parent?.removeChild(this); },
      setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
      // Class selectors only — that is all chat-view.js uses on an element
      // (.chat-live-label, .chat-live-elapsed, .chat-activity-chip, …), and the
      // live row it queries is built by chat-dom through this same stub.
      querySelector(sel) { return descend(this, sel)[0] ?? null; },
      querySelectorAll(sel) { return descend(this, sel); },
      // Enough for the stream's delegated markdown-link handler: an attribute
      // selector and a class selector, walked up through _parent.
      closest(sel) {
        const attr = /^\[data-([\w-]+)\]$/.exec(sel);
        const key = attr && attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        for (let n = this; n; n = n._parent) {
          if (key ? n.dataset?.[key] != null : String(n.className || '').split(/\s+/).includes(sel.replace(/^\./, ''))) return n;
        }
        return null;
      },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; this.children = []; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; },
      // The composer's auto-grow listener reads this; a fixed value is enough.
      get title() { return this.attrs.title; },
    };
    return el;
  };

  const byId = new Map();
  for (const id of [
    'chat-wrap', 'chat-stream', 'chat-input', 'chat-send', 'chat-stop',
    'chat-hint', 'chat-suggestion', 'chat-current-model', 'chat-attachments',
    'chat-notice-bar',
  ]) byId.set(id, make(id === 'chat-input' ? 'textarea' : 'div'));

  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => make(tag),
    // Only .chat-box is looked up this way (setStatus dims it while blocked).
    querySelector: () => make('div'),
  };
  return { document, byId, listeners };
}

async function mountView({ onSend, cwd = null } = {}) {
  const { document, byId } = stubDom();
  globalThis.document = document;
  // Just enough markdown-it for createRenderer's constructor dance. This suite is
  // about composer and restore state, never about rendered prose — chat-dom.test.js
  // owns that — so the renderer only has to exist.
  globalThis.window = {
    markdownit: () => ({
      renderer: { rules: {} },
      // createRenderer's markdown-path rules escape through md.utils, so the stub
      // has to carry it even though this suite never asserts on rendered prose.
      utils: { escapeHtml: (s) => String(s ?? '') },
      render: (src) => String(src ?? ''),
    }),
  };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  // mount() starts a 2s poll and the live row starts a 1s tick. Neither is what
  // this suite is about, and a real timer keeps node's event loop alive so the
  // runner never exits — so they are no-ops here.
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  const { initChatView } = await import('./chat-view.js');
  const sent = [];
  const opened = [];
  const view = initChatView({
    send: (m) => { sent.push(m); onSend?.(m); },
    onSubagentClick() {},
    onOpenDiff() {},
    onGoTerminal() {},
    onPickModel() {},
    onOpenFile: (p) => opened.push(p),
    cwdFor: () => cwd,
  });
  const input = byId.get('chat-input');
  // Wire the auto-grow listener's dependency the way a browser would.
  return {
    view, sent, byId, input, opened, document,
    fire: (el, type) => el.dispatchEvent({ type }),
  };
}

// --- the cross-session composer leak -----------------------------------------

test('a draft does not follow the reader to another session', async () => {
  const { view, byId, input } = await mountView();
  view.mount('sess-1');
  input.value = 'SESSION-ONE-SECRET-PROMPT';
  view.mount('sess-2');
  assert.equal(input.value, '', 'the composer opened for sess-2 must not hold sess-1 text');
  assert.equal(byId.get('chat-send').disabled, true, 'and Send must not be live over it');
});

test('switching back restores the draft rather than discarding the work', async () => {
  const { view, input } = await mountView();
  view.mount('sess-1');
  input.value = 'half-written thought';
  view.mount('sess-2');
  input.value = 'a different thought';
  view.mount('sess-1');
  assert.equal(input.value, 'half-written thought');
  view.mount('sess-2');
  assert.equal(input.value, 'a different thought');
});

test('unmount puts the draft away and leaves the shared composer empty', async () => {
  const { view, input } = await mountView();
  view.mount('sess-1');
  input.value = 'unsent';
  view.unmount();
  assert.equal(input.value, '');
  view.mount('sess-1');
  assert.equal(input.value, 'unsent');
});

// --- Esc: the restore is now the SERVER's answer ------------------------------

test('Esc asks the server for the prompt and loads nothing on its own', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  const req = sent.find((m) => m.type === 'interrupt');
  assert.ok(req, 'the interrupt is sent');
  assert.ok(req.token, 'era-stamped so a stale reply can be dropped');
  // The old behaviour replayed a locally-held value here, which is what handed
  // back the previous prompt when Esc beat the 2s poll.
  assert.equal(input.value, '', 'nothing is put in the composer until the reply lands');
});

test('the interrupt reply fills the composer', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  const { token } = sent.find((m) => m.type === 'interrupt');
  view.onInterruptRestore({ token, text: 'the prompt that was running', source: 'pane' });
  assert.equal(input.value, 'the prompt that was running');
});

test('a reply whose token does not match is ignored', async () => {
  const { view, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  view.onInterruptRestore({ token: 'someone-elses-token', text: 'WRONG SESSION PROMPT', source: 'pane' });
  assert.equal(input.value, '', 'an unmatched reply must never reach the composer');
});

test('a reply arriving after the view moved on cannot reach the new session', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  const { token } = sent.find((m) => m.type === 'interrupt');
  // The reader switches cards while the interrupt is still in flight.
  view.mount('sess-2');
  view.onInterruptRestore({ token, text: 'SESSION-ONE PROMPT', source: 'transcript' });
  assert.equal(input.value, '', "sess-1's prompt must not land in sess-2's composer");
});

test('a restore never overwrites something typed since Esc was pressed', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.value = 'I already started typing this';
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  const { token } = sent.find((m) => m.type === 'interrupt');
  view.onInterruptRestore({ token, text: 'the interrupted prompt', source: 'pane' });
  assert.equal(input.value, 'I already started typing this');
});

test('an empty reply leaves the composer alone', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  const { token } = sent.find((m) => m.type === 'interrupt');
  view.onInterruptRestore({ token, text: null, source: 'none' });
  assert.equal(input.value, '');
});

test('Esc does nothing unless the session is actually working', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(sent.some((m) => m.type === 'interrupt'), false);
});

// --- the send that follows must clear the pane -------------------------------

test('the send after an interrupt asks for the pane composer to be cleared', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  const { token } = sent.find((m) => m.type === 'interrupt');
  view.onInterruptRestore({ token, text: 'original prompt', source: 'pane' });
  input.value = 'edited prompt';
  view.setStatus('idle');
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  const message = sent.find((m) => m.type === 'message');
  assert.equal(message.text, 'edited prompt');
  // Without this the edited prompt pastes onto the prompt Claude Code restored in
  // the pane and the agent receives one fused prompt.
  assert.equal(message.clearComposer, true);
});

test('an ordinary send does NOT ask for a clear — a pane draft is the human\'s', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'just a prompt';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  const message = sent.find((m) => m.type === 'message');
  assert.equal(message.clearComposer, undefined);
});

test('the clear is consumed by one send, not carried into the next', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  view.setStatus('idle');
  input.value = 'first';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  input.value = 'second';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  const messages = sent.filter((m) => m.type === 'message');
  assert.equal(messages[0].clearComposer, true);
  assert.equal(messages[1].clearComposer, undefined);
});

test('switching sessions disarms the clear, so another session\'s pane is never wiped', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('working');
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  view.mount('sess-2');
  view.setStatus('idle');
  input.value = 'a prompt for the other session';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  const message = sent.filter((m) => m.type === 'message').pop();
  assert.equal(message.sessionId, 'sess-2');
  assert.equal(message.clearComposer, undefined);
});

// --- composer basics that nothing else covered -------------------------------

test('Shift+Enter does not send — it is how a multi-line prompt is written', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'line one';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true, preventDefault() {} });
  assert.equal(sent.some((m) => m.type === 'message'), false);
  assert.equal(input.value, 'line one', 'and the draft is untouched');
});

test('an IME composition Enter does not send', async () => {
  // Pressing Enter to confirm a composition is not a submit; without the guard it
  // fires before the composed text has even landed in the field.
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'にほんご';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, isComposing: true, preventDefault() {} });
  assert.equal(sent.some((m) => m.type === 'message'), false);
});

test('an empty composer sends nothing', async () => {
  const { view, sent, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = '   ';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  assert.equal(sent.some((m) => m.type === 'message'), false);
});

test('sending clears the composer so the same prompt cannot go twice', async () => {
  const { view, input } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'once';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  assert.equal(input.value, '');
});


// --- markdown-file links -----------------------------------------------------
// The controls inside assistant prose are built by a markdown-it renderer rule and
// never pass through appendItems, so they can only be reached by delegation off
// the stream — which is what this covers.

test('a click on a markdown-file control opens the preview at its resolved path', async () => {
  const { view, byId, opened, document } = await mountView({ cwd: '/repo' });
  view.mount('sess-1');
  const btn = document.createElement('button');
  btn.dataset.mdPath = '/repo/docs/plan.md';
  byId.get('chat-stream').appendChild(btn);
  let prevented = false;
  byId.get('chat-stream').dispatchEvent({ type: 'click', target: btn, preventDefault: () => { prevented = true; } });
  assert.deepEqual(opened, ['/repo/docs/plan.md']);
  assert.equal(prevented, true);
});

test('a click on ordinary stream content opens nothing', async () => {
  const { view, byId, opened, document } = await mountView({ cwd: '/repo' });
  view.mount('sess-1');
  const plain = document.createElement('div');
  byId.get('chat-stream').appendChild(plain);
  byId.get('chat-stream').dispatchEvent({ type: 'click', target: plain, preventDefault() {} });
  assert.deepEqual(opened, []);
});

test('Enter and Space activate a markdown-file control — it has no href to do it for us', async () => {
  const { view, byId, opened, document } = await mountView({ cwd: '/repo' });
  view.mount('sess-1');
  const link = document.createElement('a');
  link.dataset.mdPath = '/repo/docs/plan.md';
  byId.get('chat-stream').appendChild(link);
  const press = (key) => byId.get('chat-stream').dispatchEvent({ type: 'keydown', key, target: link, preventDefault() {} });
  press('Enter');
  press(' ');
  press('a');
  assert.deepEqual(opened, ['/repo/docs/plan.md', '/repo/docs/plan.md'], 'an ordinary key opens nothing');
});
