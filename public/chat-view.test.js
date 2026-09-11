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
      // Enough for the jump-to-last-message pill: a settable rect (tests move it
      // on/off "screen" by writing to it directly) and a scrollIntoView spy.
      _rect: { top: 0, bottom: 0, left: 0, right: 0 },
      getBoundingClientRect() { return this._rect; },
      scrollIntoView(opts) { this._scrolledIntoViewWith = opts; },
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
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
    'chat-notice-bar', 'chat-jump-last', 'chat-exit-notice',
  ]) byId.set(id, make(id === 'chat-input' ? 'textarea' : 'div'));

  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => make(tag),
    // fillLinked's plain-text-segment path (chat-dom.js) — the jump-pill tests
    // are the first in this suite to append a real 'user' event.
    createTextNode: (text) => ({ textContent: text }),
    // Only .chat-box is looked up this way (setStatus dims it while blocked).
    querySelector: () => make('div'),
  };
  return { document, byId, listeners };
}

async function mountView({ onSend, cwd = null, onGoTerminal } = {}) {
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
  // The send burst is the one timer this suite DOES assert on, so its callbacks
  // are captured rather than dropped: `timers` records what was scheduled and at
  // what delay, and cancelled entries are marked so a test can tell "armed" from
  // "armed then called off".
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms, cancelled: false });
    return timers.length;
  };
  globalThis.clearTimeout = (id) => {
    const t = timers[id - 1];
    if (t) t.cancelled = true;
  };
  const { initChatView } = await import('./chat-view.js');
  const sent = [];
  const opened = [];
  const view = initChatView({
    send: (m) => { sent.push(m); return onSend?.(m) ?? true; },
    onSubagentClick() {},
    onOpenDiff() {},
    onGoTerminal: (id) => onGoTerminal?.(id),
    onPickModel() {},
    onOpenFile: (p) => opened.push(p),
    cwdFor: () => cwd,
  });
  const input = byId.get('chat-input');
  // Wire the auto-grow listener's dependency the way a browser would.
  return {
    view, sent, byId, input, opened, document, timers,
    fire: (el, type) => el.dispatchEvent({ type }),
    // Only the still-live ones — a cancelled timeout is exactly what a browser
    // would never run.
    runTimers: () => { for (const t of timers) if (!t.cancelled) t.fn(); },
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
  const first = sent.filter((m) => m.type === 'message').pop();
  view.onMessageResult({ requestId: first.requestId, sessionId: 'sess-1', ok: true });
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

test('sending retains the composer until its matching delivery acknowledgement', async () => {
  const { view, input, sent } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'once';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });
  const message = sent.find((m) => m.type === 'message');
  assert.equal(input.value, 'once');
  assert.equal(input.disabled, true);
  view.onMessageResult({ requestId: 'other', sessionId: 'sess-1', ok: true });
  assert.equal(input.value, 'once');
  view.onMessageResult({ requestId: message.requestId, sessionId: 'sess-1', ok: true });
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
});

test('a rejected delivery retains and re-enables the composer', async () => {
  const { view, input, sent, byId } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'do not lose this';
  send(input);
  const message = sent.find((m) => m.type === 'message');
  view.onMessageResult({ requestId: message.requestId, sessionId: 'sess-1', ok: false, error: 'pane unavailable' });
  assert.equal(input.value, 'do not lose this');
  assert.equal(input.disabled, false);
  assert.match(byId.get('chat-hint').textContent, /Not sent: pane unavailable/);
});

test('a dropped websocket message leaves the composer editable', async () => {
  const { view, input, sent, byId } = await mountView({ onSend: () => false });
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'keep me';
  send(input);
  assert.equal(sent.filter((m) => m.type === 'message').length, 1);
  assert.equal(input.value, 'keep me');
  assert.equal(input.disabled, false);
  assert.match(byId.get('chat-hint').textContent, /Not sent: connection unavailable/);
});

test('a connection close releases an unacknowledged delivery and retains its draft', async () => {
  const { view, input, sent, byId } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'keep me after reconnect';
  send(input);
  assert.equal(sent.filter((m) => m.type === 'message').length, 1);
  view.onConnectionClosed();
  assert.equal(input.disabled, false);
  assert.equal(input.value, 'keep me after reconnect');
  assert.match(byId.get('chat-hint').textContent, /Delivery status unknown/);
});

test('a second Enter while delivery is pending sends only one frame', async () => {
  const { view, input, sent } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'once only';
  send(input);
  send(input);
  assert.equal(sent.filter((m) => m.type === 'message').length, 1);
});

test('pending delivery in one session does not block another session', async () => {
  const { view, input, sent } = await mountView();
  view.mount('sess-1');
  view.setStatus('idle');
  input.value = 'first';
  send(input);
  const first = sent.find((m) => m.type === 'message');
  view.mount('sess-2');
  view.setStatus('idle');
  input.value = 'second';
  send(input);
  const second = sent.filter((m) => m.type === 'message').at(-1);
  assert.notEqual(second.requestId, first.requestId);
  view.onMessageResult({ requestId: first.requestId, sessionId: 'sess-1', ok: true });
  assert.equal(input.value, 'second');
  view.onMessageResult({ requestId: second.requestId, sessionId: 'sess-2', ok: true });
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

// --- the composer collapsing to nothing ---------------------------------------

// The auto-grow listener sizes the box from scrollHeight, and an element that is
// not rendered (display:none somewhere above it — the sidebar hidden by the diff
// view's fullscreen, the pane hidden on unmount) reports 0. Writing that 0px back
// as the height leaves a textarea nobody can see or click once the pane returns,
// which is exactly what a human saw as "the prompt box is just an empty space".
test('a measurement taken while unrendered never becomes the composer height', async () => {
  const { view, input, fire } = await mountView();
  // The real sequence: the box was sized while visible, THEN the pane went
  // display:none and loadDraft fired — so seed a stale pixel height first, or a
  // listener that never ran at all would pass the assertions below unnoticed.
  input.scrollHeight = 54;
  fire(input, 'input');
  assert.equal(input.style.height, '54px');
  input.scrollHeight = 0; // what a display:none ancestor makes the browser report
  view.mount('sess-1');
  assert.equal(input.style.height, 'auto', 'mount must reset the stale height and never pin 0px');
  input.value = 'typed while the pane happened to be hidden';
  fire(input, 'input');
  assert.equal(input.style.height, 'auto', 'nor may the auto-grow listener');
  // Once rendered again the measurement is real and must be honoured as before.
  input.scrollHeight = 54;
  fire(input, 'input');
  assert.equal(input.style.height, '54px');
  input.scrollHeight = 900;
  fire(input, 'input');
  assert.equal(input.style.height, '140px', 'the cap still applies');
});

// A send, the way a human makes one — Enter in the composer.
const send = (input) => input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, preventDefault() {} });

// --- the send burst ----------------------------------------------------------
// A send is invisible until a poll reads the turn back, and the measured write is
// ~330ms for both agents while the poll cadence is 2s — so the scheduling wait,
// not the write, was most of the delay a human saw. These pin the burst that
// closes it and, just as importantly, the cases where it must be called off.

test('the burst schedule brackets the write without outliving one poll period', async () => {
  const { SEND_BURST_MS, POLL_MS } = await import('./chat-view.js');
  assert.ok(SEND_BURST_MS.length > 1, 'a single early poll would just lose the race and wait the full period');
  for (let i = 1; i < SEND_BURST_MS.length; i++) {
    assert.ok(SEND_BURST_MS[i] > SEND_BURST_MS[i - 1], 'strictly increasing');
  }
  // Below the ~330ms median write: a poll that finds nothing is cheap, one that
  // lands early saves a whole period.
  assert.ok(SEND_BURST_MS[0] < 330, 'the first poll must not coin-flip against the median write');
  // Past the ~850ms worst write measured, so the burst still covers the outliers.
  assert.ok(SEND_BURST_MS[SEND_BURST_MS.length - 1] > 850);
  assert.ok(SEND_BURST_MS[SEND_BURST_MS.length - 1] < POLL_MS, 'a burst must never outlive the interval it front-runs');
});

test('sending brings the next polls forward instead of waiting for the tick', async () => {
  const { view, sent, input, timers, runTimers } = await mountView();
  const { SEND_BURST_MS } = await import('./chat-view.js');
  view.mount('s1');
  view.setStatus('idle');
  const before = sent.filter((m) => m.type === 'chat').length;
  input.value = 'hello';
  send(input);
  const message = sent.find((m) => m.type === 'message');
  view.onMessageResult({ requestId: message.requestId, sessionId: 's1', ok: true });
  assert.deepEqual(timers.filter((t) => !t.cancelled).map((t) => t.ms), SEND_BURST_MS);
  runTimers();
  assert.equal(sent.filter((m) => m.type === 'chat').length - before, SEND_BURST_MS.length);
});

test('a burst poll carries the current token, so a stale one is still dropped', async () => {
  const { view, sent, input, runTimers } = await mountView();
  view.mount('s1');
  view.setStatus('idle');
  input.value = 'hello';
  send(input);
  runTimers();
  const polls = sent.filter((m) => m.type === 'chat');
  const last = polls[polls.length - 1];
  assert.equal(last.sessionId, 's1');
  assert.equal(typeof last.token, 'number');
});

test('switching session calls the burst off — it would poll the wrong card', async () => {
  const { view, sent, input, runTimers } = await mountView();
  view.mount('s1');
  view.setStatus('idle');
  input.value = 'hello';
  send(input);
  view.mount('s2');
  const before = sent.filter((m) => m.type === 'chat').length;
  runTimers();
  assert.equal(sent.filter((m) => m.type === 'chat').length, before, 'nothing left armed after the remount');
});

test('closing the view calls the burst off', async () => {
  const { view, sent, input, runTimers } = await mountView();
  view.mount('s1');
  view.setStatus('idle');
  input.value = 'hello';
  send(input);
  view.unmount();
  const before = sent.filter((m) => m.type === 'chat').length;
  runTimers();
  assert.equal(sent.filter((m) => m.type === 'chat').length, before);
});

// --- jump-to-last-message pill ------------------------------------------------

test('the jump pill stays hidden with no user message to jump to', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  assert.equal(byId.get('chat-jump-last').hidden, true);
});

test('the jump pill shows only once the last user message scrolls out of view', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  const streamEl = byId.get('chat-stream');
  streamEl._rect = { top: 0, bottom: 400 };
  view.onChatReply({ sessionId: 's1', token: 1, offset: 1, epoch: 0, events: [{ kind: 'user', text: 'hi' }] });
  const userNode = streamEl.children.find((c) => c.className === 'chat-user');
  assert.ok(userNode, 'the user bubble was appended');
  userNode._rect = { top: 50, bottom: 80 }; // inside the stream's visible box
  streamEl.dispatchEvent({ type: 'scroll' });
  assert.equal(byId.get('chat-jump-last').hidden, true, 'still on screen');
  userNode._rect = { top: -100, bottom: -20 }; // scrolled above the stream's own box
  streamEl.dispatchEvent({ type: 'scroll' });
  assert.equal(byId.get('chat-jump-last').hidden, false);
});

test('clicking the jump pill scrolls to and briefly highlights the last user message', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  view.onChatReply({ sessionId: 's1', token: 1, offset: 1, epoch: 0, events: [{ kind: 'user', text: 'hi' }] });
  const streamEl = byId.get('chat-stream');
  const userNode = streamEl.children.find((c) => c.className === 'chat-user');
  byId.get('chat-jump-last').dispatchEvent({ type: 'click' });
  assert.ok(userNode._scrolledIntoViewWith, 'scrollIntoView was called on the bubble');
  assert.equal(userNode.classList.contains('chat-jump-target'), true);
});

test('the jump highlight only ever clears the bubble it was actually pulsing', async () => {
  const { view, byId, runTimers } = await mountView();
  view.mount('s1');
  view.onChatReply({ sessionId: 's1', token: 1, offset: 1, epoch: 0, events: [{ kind: 'user', text: 'first' }] });
  const streamEl = byId.get('chat-stream');
  const firstNode = streamEl.children.find((c) => c.className === 'chat-user');
  byId.get('chat-jump-last').dispatchEvent({ type: 'click' });
  // A second user message arrives — and gets its own click — before the first
  // click's highlight timeout fires. The captured `target` in the click handler
  // is what stops the first timeout from wiping the second bubble's flash.
  view.onChatReply({ sessionId: 's1', token: 1, offset: 2, epoch: 0, events: [{ kind: 'user', text: 'second' }] });
  const secondNode = streamEl.children.filter((c) => c.className === 'chat-user')[1];
  byId.get('chat-jump-last').dispatchEvent({ type: 'click' });
  runTimers();
  assert.equal(firstNode.classList.contains('chat-jump-target'), false);
  assert.equal(secondNode.classList.contains('chat-jump-target'), false, 'its own timeout also ran');
});

test('isHumanTypedUserItem rejects Agent-Wrangler-authored notices, accepts everything else', async () => {
  const { isHumanTypedUserItem, AGENT_WRANGLER_NOTICE_PREFIX } = await import('./chat-view.js');
  assert.equal(isHumanTypedUserItem({ event: { text: 'a real question' } }), true);
  assert.equal(isHumanTypedUserItem({ event: { text: `${AGENT_WRANGLER_NOTICE_PREFIX} 📬 New mail — 1 message, read when convenient.` } }), false);
  assert.equal(isHumanTypedUserItem({ event: { text: `${AGENT_WRANGLER_NOTICE_PREFIX} PR #42: checks passing` } }), false);
  assert.equal(isHumanTypedUserItem({ event: {} }), true, 'an image-only paste has no text and is still human');
});

test('a mail/PR-nudge bubble is never the jump target, even as the newest one', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  const streamEl = byId.get('chat-stream');
  streamEl._rect = { top: 0, bottom: 400 };
  view.onChatReply({ sessionId: 's1', token: 1, offset: 1, epoch: 0, events: [{ kind: 'user', text: 'a real question' }] });
  const humanNode = streamEl.children.find((c) => c.className === 'chat-user');
  // Delivered AFTER the human's own message, and renders in the same bubble
  // style (CLAUDE.md's mailbox bullet: it belongs on screen) — but it must not
  // displace the real message as the jump target.
  view.onChatReply({ sessionId: 's1', token: 1, offset: 2, epoch: 0, events: [{ kind: 'user', text: '[Agent Wrangler] 📬 New mail — 1 message, read when convenient.' }] });
  const mailNode = streamEl.children.filter((c) => c.className === 'chat-user')[1];
  humanNode._rect = { top: -100, bottom: -20 };
  mailNode._rect = { top: 50, bottom: 80 };
  streamEl.dispatchEvent({ type: 'scroll' });
  assert.equal(byId.get('chat-jump-last').hidden, false, 'the human message is still off screen');
  byId.get('chat-jump-last').dispatchEvent({ type: 'click' });
  assert.ok(humanNode._scrolledIntoViewWith, 'jumped to the real message');
  assert.equal(mailNode._scrolledIntoViewWith, undefined, 'never jumped to the mail bubble');
});

test('mounting a different session resets the jump pill', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  view.onChatReply({ sessionId: 's1', token: 1, offset: 1, epoch: 0, events: [{ kind: 'user', text: 'hi' }] });
  const streamEl = byId.get('chat-stream');
  streamEl.children.find((c) => c.className === 'chat-user')._rect = { top: -100, bottom: -20 };
  streamEl.dispatchEvent({ type: 'scroll' });
  assert.equal(byId.get('chat-jump-last').hidden, false);
  view.mount('s2');
  assert.equal(byId.get('chat-jump-last').hidden, true, 'a fresh session has nothing yet to jump to');
});

// --- the dead-pane exit notice --------------------------------------------

test('setExitNotice renders a labelled block with the exact captured text', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  view.setExitNotice('boom: process exited 1\nAW_VERIFY_MARKER');
  const el = byId.get('chat-exit-notice');
  assert.equal(el.hidden, false);
  assert.equal(el.children.length, 2, 'a head line plus the preformatted body');
  assert.match(el.children[0].textContent, /exited/i);
  assert.equal(el.children[1].textContent, 'boom: process exited 1\nAW_VERIFY_MARKER');
});

test('setExitNotice(null) hides the block and clears its content', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  view.setExitNotice('some output');
  view.setExitNotice(null);
  const el = byId.get('chat-exit-notice');
  assert.equal(el.hidden, true);
  assert.equal(el.children.length, 0);
});

test('mounting a different session clears the previous one\'s exit notice', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  view.setExitNotice('s1 died here');
  view.mount('s2');
  const el = byId.get('chat-exit-notice');
  assert.equal(el.hidden, true, 's2 has not died — must not inherit s1\'s banner');
  assert.equal(el.children.length, 0);
});

test('unmount clears the exit notice too', async () => {
  const { view, byId } = await mountView();
  view.mount('s1');
  view.setExitNotice('s1 died here');
  view.unmount();
  const el = byId.get('chat-exit-notice');
  assert.equal(el.hidden, true);
});

// --- the needs-you notice bar, including the waitingFor-specific wording -----

test('setStatus(needs-you) with no waitingFor shows the generic line and blocks the composer', async () => {
  const { view, byId, input } = await mountView();
  view.mount('s1');
  view.setStatus('needs-you');
  const bar = byId.get('chat-notice-bar');
  assert.equal(bar.hidden, false);
  assert.match(bar.children[0].textContent, /waiting on you/i);
  assert.equal(input.disabled, true);
  assert.equal(byId.get('chat-send').disabled, true);
});

test('setStatus(needs-you, waitingFor) shows the specific reason, not "this needs the terminal" verbatim for an unrelated cause', async () => {
  const { view, byId, input } = await mountView();
  view.mount('s1');
  view.setStatus('needs-you', 'Codex has a CLI update available');
  const bar = byId.get('chat-notice-bar');
  assert.equal(bar.hidden, false);
  assert.match(bar.children[0].textContent, /Codex has a CLI update available/);
  assert.equal(input.disabled, true);
  assert.equal(byId.get('chat-send').disabled, true);
  // The regression this guards: appending a hardcoded "this needs the
  // terminal" to an arbitrary waitingFor overclaims for a reason (e.g. a
  // dropped API connection) that isn't itself a terminal matter — see
  // CLAUDE.md and the PR discussion. The wording must describe why Send is
  // blocked, not assert the underlying cause lives in the terminal.
  assert.doesNotMatch(bar.children[0].textContent, /this needs the terminal\.$/);
});

test('a "Terminal →" button is offered and calls onGoTerminal for the mounted session', async () => {
  const goTo = [];
  const { view, byId } = await mountView({ onGoTerminal: (id) => goTo.push(id) });
  view.mount('s1');
  view.setStatus('needs-you', 'Codex has a CLI update available');
  const bar = byId.get('chat-notice-bar');
  bar.children[1].dispatchEvent({ type: 'click' });
  assert.deepEqual(goTo, ['s1']);
});

test('clearing needs-you re-enables the composer and hides the bar', async () => {
  const { view, byId, input } = await mountView();
  view.mount('s1');
  view.setStatus('needs-you', 'Codex has a CLI update available');
  view.setStatus('idle');
  const bar = byId.get('chat-notice-bar');
  assert.equal(bar.hidden, true);
  assert.equal(input.disabled, false);
});
