import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepoAccess, repoRequestsOf, requestText } from './repo-access.js';

function fakeDoc() {
  const els = {};
  const el = (id) => {
    const classes = new Set(id === 'repos-modal' ? ['hidden'] : []);
    const listeners = {};
    return els[id] ||= {
      id, value: '', innerHTML: '', textContent: '', disabled: false, focused: 0,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      },
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      fire: (t, e = {}) => { for (const fn of listeners[t] || []) fn({ preventDefault() {}, target: els[id], ...e }); },
      focus() { this.focused += 1; },
    };
  };
  return { getElementById: el, els };
}

const card = (extra = {}) => ({ sessionId: 's1', label: 'Fix the API', repos: ['acme/widgets'], repoRequests: [], ...extra });
const ask = { id: 'rr_1', repos: ['acme/gadgets'], why: 'The client lives there', at: 1 };

function setup() {
  const doc = fakeDoc();
  const sent = [];
  const toasts = [];
  const dismissed = [];
  const access = createRepoAccess({ document: doc, send: (m) => sent.push(m), toast: (text, sev, opts) => toasts.push({ text, sev, opts }), dismissToast: (id) => dismissed.push(id) });
  return { doc, sent, toasts, dismissed, access };
}

test('requests are read off every card, and named with the card and the repos', () => {
  const items = repoRequestsOf([card({ repoRequests: [ask] }), { sessionId: 's2', repos: null }]);
  assert.deepEqual(items, [{ sessionId: 's1', label: 'Fix the API', request: ask }]);
  assert.equal(requestText(items[0]), 'Fix the API asks to reach acme/gadgets');
});

test('a request is toasted once, sticky, with its reason and Allow/Decline that answer it', () => {
  const { sent, toasts, access } = setup();
  access.onGraph([card({ repoRequests: [ask] })]);
  access.onGraph([card({ repoRequests: [ask] })]);
  assert.equal(toasts.length, 1);
  const { opts } = toasts[0];
  assert.deepEqual([opts.id, opts.duration, opts.details], ['repo-request:rr_1', Infinity, 'The client lives there']);
  assert.deepEqual(opts.actions.map((a) => a.label), ['Allow', 'Decline']);
  opts.actions[0].onClick();
  opts.actions[1].onClick();
  assert.deepEqual(sent, [
    { type: 'repo-request', sessionId: 's1', requestId: 'rr_1', allow: true },
    { type: 'repo-request', sessionId: 's1', requestId: 'rr_1', allow: false },
  ]);
});

test('the dialog lists the repos and waiting requests, adds only valid repos, and answers a request from its row', () => {
  const { doc, sent, access } = setup();
  access.onGraph([card({ repoRequests: [ask] })]);
  access.open('s1');
  const { els } = doc;
  assert.equal(els['repos-modal'].classList.contains('hidden'), false);
  assert.match(els['rp-have'].innerHTML, /<li>acme\/widgets<\/li>/);
  assert.match(els['rp-requests'].innerHTML, /data-request="rr_1"[\s\S]*acme\/gadgets[\s\S]*The client lives there/);
  assert.equal(els['rp-go'].disabled, true, 'nothing typed yet');
  els['rp-add'].value = 'acme/x, nope';
  els['rp-add'].fire('input');
  assert.equal(els['rp-go'].disabled, true);
  assert.match(els['rp-msg'].textContent, /"nope" is not a GitHub repo/);
  els['rp-add'].value = 'https://github.com/acme/x acme/y';
  els['rp-add'].fire('input');
  els['rp-go'].fire('click');
  assert.deepEqual(sent.at(-1), { type: 'add-repos', sessionId: 's1', repos: ['acme/x', 'acme/y'] });
  const allow = { dataset: { allow: 'true' }, closest: (sel) => (sel === '[data-allow]' ? allow : { dataset: { request: 'rr_1' } }) };
  els['rp-requests'].fire('click', { target: allow });
  assert.deepEqual(sent.at(-1), { type: 'repo-request', sessionId: 's1', requestId: 'rr_1', allow: true });
});

test('the dialog closes when its card stops being a location card or goes away, and never opens for one', () => {
  const { doc, access } = setup();
  access.onGraph([card()]);
  access.open('s1');
  access.onGraph([]);
  assert.equal(doc.els['repos-modal'].classList.contains('hidden'), true);
  access.onGraph([card({ repos: null })]);
  access.open('s1');
  assert.equal(doc.els['repos-modal'].classList.contains('hidden'), true);
});

test('a request answered anywhere takes its toast down', () => {
  const { toasts, dismissed, access } = setup();
  access.onGraph([card({ repoRequests: [ask] })]);
  assert.equal(toasts.length, 1);
  access.onGraph([card({ repoRequests: [ask] })]);
  assert.deepEqual(dismissed, []);
  access.onGraph([card({ repos: ['acme/widgets', 'acme/gadgets'] })]);
  access.onGraph([card({ repos: ['acme/widgets', 'acme/gadgets'] })]);
  assert.deepEqual(dismissed, ['repo-request:rr_1']);
});
