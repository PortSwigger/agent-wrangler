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

test('recap text and its next step never reach innerHTML', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s}</p>` });
  const node = dom.itemNode({
    type: 'recap',
    event: { kind: 'recap', text: '<img src=x onerror=alert(1)>', next: '<script>bad()</script>', ts: 1 },
  });
  assert.equal(walk(node).map((n) => n._html).filter(Boolean).join(''), '', 'no innerHTML in a recap subtree');
  const texts = walk(node).map((n) => n._text).filter(Boolean);
  assert.ok(texts.some((t) => t.includes('<img src=x')), 'the raw summary is carried as text');
  assert.ok(texts.some((t) => t.includes('<script>')), 'the raw next step is carried as text');
});

test('a recap with no next step renders no button to press', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '' });
  const node = dom.itemNode({ type: 'recap', event: { kind: 'recap', text: 'All done.', next: null, ts: 1 } });
  assert.equal(walk(node).filter((n) => n.tagName === 'BUTTON').length, 0);
});

test('a recap with a next step renders exactly one button carrying it', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '' });
  const node = dom.itemNode({ type: 'recap', event: { kind: 'recap', text: 'Researched it.', next: 'plan phase 1', ts: 1 } });
  const buttons = walk(node).filter((n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  assert.ok(walk(buttons[0]).some((n) => n._text === 'plan phase 1'));
});

test('liveRow carries a label and an empty elapsed slot for chat-view to fill', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '' });
  const row = dom.liveRow();
  assert.equal(row.className, 'chat-live');
  assert.ok(walk(row).some((n) => n.className === 'chat-live-label'));
  assert.ok(walk(row).some((n) => n.className === 'chat-live-elapsed'));
});

test('a user turn with no images keeps the plain single-node bubble', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '<p>nope</p>' });
  const node = dom.itemNode({ type: 'user', event: { kind: 'user', text: 'hi', ts: 1, images: [] } });
  assert.equal(node.className, 'chat-user');
  assert.equal(node.children.length, 0, 'no wrapper is paid for when there is nothing to wrap');
  assert.equal(node._text, 'hi');
});

test('a user turn with images renders a chip per image, as text and never markup', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '<p>nope</p>' });
  const node = dom.itemNode({
    type: 'user',
    event: {
      kind: 'user', ts: 1, text: 'Compare [Image #1] and [Image #2]:',
      images: [{ label: 'Image #1', name: 'a.png' }, { label: 'Image #2', name: 'b.png' }],
    },
  });
  const all = walk(node);
  assert.equal(all.map((n) => n._html).filter(Boolean).join(''), '', 'a filename is untrusted content — never innerHTML');
  const chips = all.filter((n) => n.className === 'chat-user-image');
  assert.deepEqual(chips.map((c) => c._text), ['Image #1', 'Image #2']);
  // The filename is the only part a reader might want, and often the only thing
  // telling two pastes apart.
  assert.deepEqual(chips.map((c) => c.attrs.title), ['a.png', 'b.png']);
  assert.ok(all.some((n) => n.className === 'chat-user-text' && n._text === 'Compare [Image #1] and [Image #2]:'));
});

test('an image-only user turn renders the chips with no empty text node above them', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '<p>nope</p>' });
  const node = dom.itemNode({ type: 'user', event: { kind: 'user', ts: 1, text: '', images: [{ label: 'Image #1', name: 's.png' }] } });
  assert.equal(walk(node).some((n) => n.className === 'chat-user-text'), false);
  assert.equal(walk(node).filter((n) => n.className === 'chat-user-image').length, 1);
});

test('a chip with no filename still renders its label, unnamed rather than mislabelled', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '<p>nope</p>' });
  const node = dom.itemNode({ type: 'user', event: { kind: 'user', ts: 1, text: 'x', images: [{ label: 'Image #2', name: '' }] } });
  const chip = walk(node).find((n) => n.className === 'chat-user-image');
  assert.equal(chip._text, 'Image #2');
  assert.equal(chip.attrs.title, undefined);
});
