import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScroll, chatScrollTop, terminalNotches, createSessionPanel, SCROLL_HOWS, CHAT_LINE_PX, TERMINAL_END_NOTCHES } from './session-panel.js';

test('planScroll knows the six ways and nothing else', () => {
  assert.deepEqual(SCROLL_HOWS.map(planScroll), [
    { dir: -1, unit: 'page' }, { dir: 1, unit: 'page' },
    { dir: -1, unit: 'line' }, { dir: 1, unit: 'line' },
    { dir: -1, unit: 'end' }, { dir: 1, unit: 'end' },
  ]);
  assert.equal(planScroll('up'), null);
  assert.equal(planScroll(undefined), null);
});

test('chatScrollTop steps by a line or most of a page and clamps at both ends', () => {
  const el = { scrollTop: 500, scrollHeight: 2000, clientHeight: 400 };
  assert.equal(chatScrollTop(el, planScroll('line-up')), 500 - CHAT_LINE_PX);
  assert.equal(chatScrollTop(el, planScroll('page-down')), 500 + 340);
  assert.equal(chatScrollTop(el, planScroll('top')), 0);
  assert.equal(chatScrollTop(el, planScroll('bottom')), 1600);
  assert.equal(chatScrollTop({ ...el, scrollTop: 1550 }, planScroll('page-down')), 1600);
  assert.equal(chatScrollTop({ ...el, scrollTop: 10 }, planScroll('page-up')), 0);
  assert.equal(chatScrollTop({ scrollTop: 0, scrollHeight: 100, clientHeight: 400 }, planScroll('bottom')), 0, 'a short stream does not scroll');
});

test('terminalNotches: a notch a line, 0.3 a row a page, a long burst to an end', () => {
  assert.equal(terminalNotches(planScroll('line-down'), 40), 1);
  assert.equal(terminalNotches(planScroll('page-up'), 56), 17);
  assert.equal(terminalNotches(planScroll('page-up'), 1), 1);
  assert.equal(terminalNotches(planScroll('top'), 40), TERMINAL_END_NOTCHES);
});

// A panel over fakes: `state.view` is what shows, `calls` what reached it.
function rig(over = {}) {
  const calls = [];
  const state = { view: 'chat', gate: null, composerOpen: true, sent: true, ...over };
  const stream = { scrollTop: 800, scrollHeight: 2000, clientHeight: 400 };
  const panel = createSessionPanel({
    view: () => state.view,
    session: () => (state.view ? { sessionId: 's1' } : null),
    gateFor: (sid) => (sid === 's1' ? state.gate : null),
    chat: () => ({
      stream,
      append: (t) => { calls.push(['append', t]); return state.composerOpen; },
      submit: () => { calls.push(['submit']); return state.sent; },
    }),
    terminal: () => ({
      rows: 30,
      wheel: (dir, n) => { calls.push(['wheel', dir, n]); return true; },
      paste: (t) => calls.push(['paste', t]),
      enter: () => { calls.push(['enter']); return true; },
    }),
    sendMessage: (sid, t) => { calls.push(['message', sid, t]); return state.sent; },
  });
  return { panel, calls, state, stream };
}

test('scroll moves the Chat stream, or wheels the Terminal, whichever shows', () => {
  const { panel, calls, state, stream } = rig();
  assert.deepEqual(panel.scroll('page-up'), { ok: true, view: 'chat', moved: true });
  assert.equal(stream.scrollTop, 800 - 340);
  panel.scroll('bottom');
  assert.deepEqual(panel.scroll('line-down'), { ok: true, view: 'chat', moved: false }, 'already at the bottom');
  state.view = 'terminal';
  assert.deepEqual(panel.scroll('page-up'), { ok: true, view: 'terminal', moved: true });
  panel.scroll('line-down');
  panel.scroll('top');
  assert.deepEqual(calls, [['wheel', -1, 9], ['wheel', 1, 1], ['wheel', -1, TERMINAL_END_NOTCHES]]);
  assert.deepEqual(panel.scroll('sideways'), { ok: false, reason: 'bad-scroll' });
  state.view = null;
  assert.deepEqual(panel.scroll('top'), { ok: false, reason: 'no-panel' });
  assert.equal(panel.view(), null);
});

test('type in Chat fills the composer and, with submit, sends it as the composer does', () => {
  const { panel, calls, state } = rig();
  assert.deepEqual(panel.type('hello '), { ok: true, view: 'chat', submitted: false });
  assert.deepEqual(panel.type('world', { submit: true }), { ok: true, view: 'chat', submitted: true });
  assert.deepEqual(calls, [['append', 'hello '], ['append', 'world'], ['submit']]);
  state.composerOpen = false;
  assert.deepEqual(panel.type('x'), { ok: false, reason: 'blocked' }, 'a needs-you composer takes nothing');
  state.composerOpen = true;
  state.sent = false;
  assert.deepEqual(panel.type('', { submit: true }), { ok: false, reason: 'not-sent' });
});

test('type in the Terminal pastes, and submit sends the text as a prompt or presses Enter', () => {
  const { panel, calls } = rig({ view: 'terminal' });
  assert.deepEqual(panel.type('fix the bug'), { ok: true, view: 'terminal', submitted: false });
  assert.deepEqual(panel.type('', { submit: true }), { ok: true, view: 'terminal', submitted: true });
  assert.deepEqual(panel.type('and test it', { submit: true }), { ok: true, view: 'terminal', submitted: true });
  assert.deepEqual(calls, [['paste', 'fix the bug'], ['enter'], ['message', 's1', 'and test it']]);
});

test('type is refused under the session\'s input gate, with no panel, or without text', () => {
  const { panel, calls, state } = rig({ gate: { reason: 'Step is paused' } });
  assert.deepEqual(panel.type('x', { submit: true }), { ok: false, reason: 'gated' });
  state.view = 'terminal';
  assert.deepEqual(panel.type('x'), { ok: false, reason: 'gated' });
  assert.equal(calls.length, 0, 'nothing reached the chat or the pane');
  state.gate = null;
  assert.deepEqual(panel.type(42), { ok: false, reason: 'bad-text' });
  state.view = null;
  assert.deepEqual(panel.type('x'), { ok: false, reason: 'no-panel' });
});
