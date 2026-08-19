import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatDom, activityTitle } from './chat-dom.js';

// A DOM stub sufficient for the node-building assertions: no jsdom, matching how
// the rest of public/ tests stay DOM-free.
function stubDocument() {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], className: '', dataset: {},
      _text: null, _html: null, attrs: {},
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      set textContent(v) { this._text = v; },
      get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
    return el;
  };
  return { createElement: make };
}

const walk = (node, out = []) => {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
};

test('tool output and targets never reach innerHTML', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s}</p>` });
  const node = dom.itemNode({
    type: 'activity', label: 'Ran 1 command', adds: 0, dels: 0,
    tools: [{ kind: 'tool', name: 'Bash', target: '<img src=x onerror=alert(1)>', output: '<script>bad()</script>', ok: true }],
  });
  const html = walk(node).map((n) => n._html).filter(Boolean).join('');
  assert.equal(html, '', 'no innerHTML anywhere in a tool subtree');
  const texts = walk(node).map((n) => n._text).filter(Boolean);
  assert.ok(texts.some((t) => t.includes('<img src=x')), 'the raw string is carried as text, not markup');
});

test('assistant prose is the one thing rendered as markdown', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s.toUpperCase()}</p>` });
  const node = dom.itemNode({ type: 'assistant', event: { kind: 'assistant', text: 'hello', ts: 1, model: 'claude-opus-5' } });
  const html = walk(node).map((n) => n._html).filter(Boolean).join('');
  assert.equal(html, '<p>HELLO</p>');
});

test('a user turn is plain text, never markdown', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '<p>nope</p>' });
  const node = dom.itemNode({ type: 'user', event: { kind: 'user', text: '**not bold**', ts: 1 } });
  assert.equal(walk(node).map((n) => n._html).filter(Boolean).join(''), '');
  assert.ok(walk(node).some((n) => n._text === '**not bold**'));
});

test('activityTitle appends the diff counts only when an edit run has them', () => {
  assert.equal(activityTitle({ label: 'Edited 2 files', adds: 11, dels: 2 }), 'Edited 2 files +11 −2');
  assert.equal(activityTitle({ label: 'Read 2 files', adds: 0, dels: 0 }), 'Read 2 files');
});

test('a codex thinking item with no text renders without a duration or body', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '' });
  const node = dom.itemNode({ type: 'thinking', event: { kind: 'thinking', ts: 1 } });
  assert.ok(walk(node).some((n) => n._text === 'Thinking'));
});

test('subagent name never reaches innerHTML', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s}</p>` });
  const node = dom.itemNode({
    type: 'subagent',
    event: { kind: 'subagent', id: 'sub-1', name: '<img src=x onerror=alert(1)>', ts: 1 },
  });
  const html = walk(node).map((n) => n._html).filter(Boolean).join('');
  assert.equal(html, '', 'no innerHTML anywhere in a subagent subtree');
  const texts = walk(node).map((n) => n._text).filter(Boolean);
  assert.ok(texts.some((t) => t.includes('<img src=x')), 'the raw name is carried as text, not markup');
});

test('notice text never reaches innerHTML', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s}</p>` });
  const node = dom.itemNode({
    type: 'notice',
    event: { kind: 'notice', noticeKind: 'denied', text: '<img src=x onerror=alert(1)>', ts: 1 },
  });
  const html = walk(node).map((n) => n._html).filter(Boolean).join('');
  assert.equal(html, '', 'no innerHTML anywhere in a notice subtree');
  const texts = walk(node).map((n) => n._text).filter(Boolean);
  assert.ok(texts.some((t) => t.includes('<img src=x')), 'the raw text (built from a tool target/name) is carried as text, not markup');
});
