import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionEmbed } from './session-embed.js';

// A DOM stub with just the tree moves the embed makes — no jsdom, matching the
// rest of public/'s tests. `isConnected` walks up to the stub document's root.
function stubDom() {
  const root = node('root');
  function node(id) {
    const n = {
      id,
      className: '',
      children: [],
      parentNode: null,
      classList: { add() {}, remove() {}, toggle() {} },
      get nextSibling() {
        const sibs = n.parentNode?.children;
        return sibs ? sibs[sibs.indexOf(n) + 1] || null : null;
      },
      get isConnected() {
        let p = n;
        while (p.parentNode) p = p.parentNode;
        return p === root;
      },
      appendChild(c) { return n.insertBefore(c, null); },
      insertBefore(c, ref) {
        c.parentNode?.removeChild(c);
        const at = ref ? n.children.indexOf(ref) : -1;
        if (ref && at < 0) throw new Error('ref is not a child');
        if (at < 0) n.children.push(c); else n.children.splice(at, 0, c);
        c.parentNode = n;
        return c;
      },
      removeChild(c) {
        const at = n.children.indexOf(c);
        if (at >= 0) n.children.splice(at, 1);
        c.parentNode = null;
        return c;
      },
    };
    return n;
  }
  // <main>: #grid, #diff-panel, #ext-views > (.ext-view A, .ext-view B), #sidebar > (#panel, #term-wrap)
  const main = root.appendChild(node('main'));
  main.appendChild(node('grid'));
  const diffPanel = main.appendChild(node('diff-panel'));
  const extViews = main.appendChild(node('ext-views'));
  const viewA = extViews.appendChild(node('view-a'));
  const viewB = extViews.appendChild(node('view-b'));
  const sidebar = main.appendChild(node('sidebar'));
  sidebar.appendChild(node('panel'));
  const termWrap = sidebar.appendChild(node('term-wrap'));
  return { root, main, diffPanel, extViews, viewA, viewB, sidebar, termWrap, document: { createElement: () => node('wrap') } };
}

function harness() {
  const dom = stubDom();
  const log = [];
  const embed = createSessionEmbed({
    document: dom.document,
    parts: () => ({ sidebar: dom.sidebar, diffPanel: dom.diffPanel, diffAnchor: dom.termWrap }),
    show: (sid) => log.push(`show ${sid}`),
    release: (o) => log.push(`release ${o.sessionId}`),
  });
  const ids = (n) => n.children.map((c) => c.id);
  return { ...dom, embed, log, ids };
}

test('mount lends the panel to the element, with the diff under the header, and unmount puts both back where they were', () => {
  const h = harness();
  const before = h.ids(h.main);
  const handle = h.embed.mount(h.viewA, 's1');
  const wrap = h.viewA.children[0];
  assert.equal(wrap.className, 'session-embed');
  assert.deepEqual(h.ids(wrap), ['sidebar']);
  assert.deepEqual(h.ids(h.sidebar), ['panel', 'diff-panel', 'term-wrap']);
  assert.deepEqual(h.ids(h.main), ['grid', 'ext-views']);
  assert.equal(handle.sessionId, 's1');
  assert.equal(h.embed.active()?.sessionId, 's1');
  assert.deepEqual(h.log, ['show s1']);

  handle.unmount();
  assert.deepEqual(h.ids(h.main), before);
  assert.deepEqual(h.ids(h.sidebar), ['panel', 'term-wrap']);
  assert.deepEqual(h.viewA.children, [], 'the wrapper went with it');
  assert.equal(handle.sessionId, null);
  assert.equal(h.embed.active(), null);
  assert.deepEqual(h.log, ['show s1', 'release s1'], 'released before the move');
  handle.unmount();
  assert.deepEqual(h.log, ['show s1', 'release s1'], 'a second unmount is a no-op');
});

test('show and a repeat mount into the same element swap the session without moving anything', () => {
  const h = harness();
  const handle = h.embed.mount(h.viewA, 's1');
  assert.equal(handle.show('s2'), true);
  assert.equal(h.embed.mount(h.viewA, 's3'), handle);
  assert.equal(h.viewA.children.length, 1);
  assert.equal(handle.sessionId, 's3');
  assert.deepEqual(h.log, ['show s1', 'show s2', 'show s3']);
});

test('a mount into another element takes the panel over and the older handle goes inert', () => {
  const h = harness();
  const a = h.embed.mount(h.viewA, 's1');
  const b = h.embed.mount(h.viewB, 's2');
  assert.deepEqual(h.viewA.children, []);
  assert.deepEqual(h.ids(h.viewB.children[0]), ['sidebar']);
  assert.equal(a.sessionId, null);
  assert.equal(a.show('s9'), false);
  a.unmount();
  assert.equal(b.sessionId, 's2', 'the stale handle cannot take it back');
  assert.deepEqual(h.log, ['show s1', 'release s1', 'show s2']);
});

test('park sends the panel home for the board and unpark lends it back on the same session', () => {
  const h = harness();
  const handle = h.embed.mount(h.viewA, 's1');
  h.embed.park();
  assert.deepEqual(h.ids(h.main), ['grid', 'diff-panel', 'ext-views', 'sidebar']);
  assert.equal(h.embed.active(), null);
  assert.equal(handle.sessionId, 's1', 'still owned while parked');
  handle.show('s2');
  h.embed.unpark();
  assert.deepEqual(h.ids(h.viewA.children[0]), ['sidebar']);
  assert.deepEqual(h.log, ['show s1', 'release s1', 'show s2']);
  h.embed.park();
  handle.unmount();
  assert.deepEqual(h.log, ['show s1', 'release s1', 'show s2', 'release s2'], 'unmounting a parked embed releases nothing twice');
  h.embed.unpark();
  assert.equal(h.embed.owner(), null);
});

test('a mount whose view is not on screen starts parked', () => {
  const h = harness();
  h.embed.mount(h.viewA, 's1', { active: false });
  assert.deepEqual(h.viewA.children, []);
  assert.deepEqual(h.log, []);
  h.embed.unpark();
  assert.deepEqual(h.log, ['show s1']);
});

test('an element dropped from the document is reclaimed, and an extension switched off takes its embed', () => {
  const h = harness();
  h.embed.mount(h.viewA, 's1', { extId: 'jobs' });
  assert.equal(h.embed.reclaimOrphan(), false);
  h.extViews.removeChild(h.viewA);
  assert.equal(h.embed.reclaimOrphan(), true);
  assert.deepEqual(h.ids(h.main), ['grid', 'diff-panel', 'ext-views', 'sidebar']);
  assert.equal(h.embed.owner(), null);

  h.embed.mount(h.viewB, 's2', { extId: 'jobs' });
  h.embed.dropExtension('other');
  assert.ok(h.embed.owner());
  h.embed.dropExtension('jobs');
  assert.equal(h.embed.owner(), null);
  assert.deepEqual(h.ids(h.main), ['grid', 'diff-panel', 'ext-views', 'sidebar']);
});
