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
  key: 'privsink/main', extId: 'privsink', extLabel: 'Private sink', id: 'main', label: '', host: 'collector.example.com',
  accepts: ['core.*', 'jobs.*'], headerNames: ['X-Ingest-Token'], pending: 2, sent: 5, dropped: 0, lastSentAt: null, lastError: 'HTTP 503: retrying in 15s', lastErrorAt: 1, retryAt: 2,
};
const STATUS = {
  enabled: true, install: 'b1c7f5c2-0000-4000-8000-000000000000', team: 'web', teams: ['platform', 'web'], queued: 2,
  sinks: [SINK],
  emitters: [{ id: 'core', version: '0.1.0', events: [] }, { id: 'demo', version: '1.0.0', events: [{ type: 'demo.step.ended', v: 1, fields: ['kind', 'tries'] }] }],
};

test('the panel names each sink by host and extension, with its counters, error and header names but no values', () => withDom(() => {
  const text = telemetryPanelEl({ status: STATUS }).textContent;
  assert.match(text, /collector\.example\.com/);
  assert.match(text, /from Private sink/);
  assert.match(text, /5 sent · 2 queued/);
  assert.match(text, /Last error: HTTP 503: retrying in 15s/);
  assert.match(text, /Sends headers X-Ingest-Token \(values hidden\)/);
  assert.match(text, /demo\.step\.ended v1/);
  assert.match(text, /kind, tries/);
  assert.match(text, /2 events queued/);
}));

test('with no sink the panel says nothing is sent, and offers no team picker', () => withDom(() => {
  const el = telemetryPanelEl({ status: { ...STATUS, sinks: [], teams: [], queued: 0 } });
  assert.match(el.textContent, /No extension supplies a sink, so nothing is sent/);
  assert.equal(all(el, (n) => n.tagName === 'SELECT').length, 0);
}));

test('the team picker offers the sinks\' teams and reports a pick, empty as null', () => withDom(() => {
  const picked = [];
  const el = telemetryPanelEl({ status: STATUS, onTeam: (t) => picked.push(t) });
  const [select] = all(el, (n) => n.tagName === 'SELECT');
  assert.deepEqual(select.children.map((o) => o.value), ['', 'platform', 'web']);
  assert.equal(select.value, 'web');
  select.value = '';
  select.listeners.change();
  assert.deepEqual(picked, [null]);
}));

test('the queue preview shows each event exactly as it would leave, and Clear is off for an empty queue', () => withDom(() => {
  const el = telemetryPanelEl({ status: STATUS, preview: [{ sink: 'collector.example.com', event: { type: 'demo.step.ended', tries: 1 } }] });
  const [pre] = all(el, (n) => n.tagName === 'PRE');
  assert.match(pre.textContent, /→ collector\.example\.com\n\{\n {2}"type": "demo\.step\.ended"/);
  const empty = telemetryPanelEl({ status: { ...STATUS, queued: 0 } });
  const clear = all(empty, (n) => n.tagName === 'BUTTON' && n.textContent === 'Clear queue')[0];
  assert.equal(clear.disabled, true);
}));

test('a sink line says when the switch is off', () => {
  assert.match(sinkStatusText(SINK, { enabled: false }), /not sending: telemetry is off/);
  assert.doesNotMatch(sinkStatusText(SINK, { enabled: true }), /not sending/);
});
