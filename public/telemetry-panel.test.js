import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telemetryPanelEl, sinkStatusText } from './telemetry-panel.js';

// Just enough DOM for the panel: elements with children, text, attributes and
// listeners, and a textContent that reads back everything below.
function stubDocument() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      attrs: {},
      listeners: {},
      value: '',
      disabled: false,
      _text: '',
      append(...kids) { for (const k of kids) this.children.push(k); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(' '); },
      set textContent(v) { this._text = String(v); },
    };
    return node;
  };
  return { createElement: make };
}

function withDom(fn) {
  const prior = globalThis.document;
  globalThis.document = stubDocument();
  try { return fn(); } finally { globalThis.document = prior; }
}

function all(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children || []) all(c, pred, out);
  return out;
}

const SINK = {
  url: 'https://collector.example.com/v1/events', host: 'collector.example.com', source: 'builtin', error: null,
  builtin: 'https://collector.example.com/v1/events', env: 'AW_TELEMETRY_URL', repoOwners: ['acme'],
  sent: 5, dropped: 0, lastSentAt: null, lastError: 'HTTP 503: retrying in 15s', lastErrorAt: 1, retryAt: 2,
};
const STATUS = {
  install: 'b1c7f5c2-0000-4000-8000-000000000000', queued: 2,
  sink: SINK,
  emitters: [{ id: 'core', version: '0.1.0', events: [] }, { id: 'demo', version: '1.0.0', events: [{ type: 'demo.step.ended', v: 1, fields: ['kind', 'tries'] }] }],
};

test('the panel shows the built-in collector URL with its counters, error and repo owners', () => withDom(() => {
  const text = telemetryPanelEl({ status: STATUS }).textContent;
  assert.match(text, /https:\/\/collector\.example\.com\/v1\/events/);
  assert.match(text, /Built in\. Reachable only from the office network/);
  assert.match(text, /5 sent · 2 queued/);
  assert.match(text, /Last error: HTTP 503: retrying in 15s/);
  assert.match(text, /Repo names sent for acme/);
  assert.match(text, /demo\.step\.ended v1/);
  assert.match(text, /kind, tries/);
  assert.match(text, /2 events queued/);
}));

test('an override names where it came from and the built-in URL it replaces', () => withDom(() => {
  const text = telemetryPanelEl({ status: { ...STATUS, sink: { ...SINK, url: 'http://127.0.0.1:4318/v1/events', source: 'env' } } }).textContent;
  assert.match(text, /http:\/\/127\.0\.0\.1:4318\/v1\/events/);
  assert.match(text, /Set by AW_TELEMETRY_URL/);
  assert.match(text, /Built-in collector: https:\/\/collector\.example\.com\/v1\/events/);
}));

test('an invalid override says nothing is sent, and offers no counters', () => withDom(() => {
  const text = telemetryPanelEl({ status: { ...STATUS, sink: { ...SINK, url: 'http://collector.example.com/', source: 'config', error: 'endpoint must use https (http only to localhost)' } } }).textContent;
  assert.match(text, /Not sending: endpoint must use https/);
  assert.doesNotMatch(text, /5 sent/);
}));

test('the queue preview shows each event exactly as it would leave', () => withDom(() => {
  const el = telemetryPanelEl({ status: STATUS, preview: [{ sink: 'collector.example.com', event: { type: 'demo.step.ended', tries: 1 } }] });
  const [pre] = all(el, (n) => n.tagName === 'PRE');
  assert.match(pre.textContent, /→ collector\.example\.com\n\{\n {2}"type": "demo\.step\.ended"/);
}));

test('the panel says telemetry is always on and offers no switch, team picker or way to clear the queue', () => withDom(() => {
  const el = telemetryPanelEl({ status: STATUS });
  assert.match(el.textContent, /Telemetry is always on\. There is no switch to turn it off\./);
  assert.equal(all(el, (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT').length, 0);
  assert.doesNotMatch(el.textContent, /team/i);
  assert.deepEqual(all(el, (n) => n.tagName === 'BUTTON').map((b) => b.textContent), ['Show queued events']);
  assert.match(telemetryPanelEl({ status: null }).textContent, /always on/, 'said even before the first graph');
}));

test('the collector line never says it is not sending because telemetry is off', () => {
  assert.equal(sinkStatusText(SINK, { queued: 0 }), '5 sent · 0 queued');
});
