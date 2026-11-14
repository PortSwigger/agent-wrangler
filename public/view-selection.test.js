import { parseViewHash } from './hash-view.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function declaration(head) {
  const start = source.indexOf(head);
  assert.ok(start >= 0, head);
  let depth = 0;
  for (let i = start + head.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced ${head}`);
}

function harness() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { style: {}, classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c),
        contains: (c) => classes.has(c),
      } });
    }
    return nodes.get(id);
  }
  const log = [];
  const location = { hash: '', pathname: '/', search: '' };
  const listeners = {};
  const noop = () => {};
  const heads = [
    'function setView(view) {', 'function selectSession(sessionId) {',
    'function deselectSession() {', 'function setPendingSelect(id) {',
    'function tryFulfillPending() {', 'function syncHash() {',
    'function hashSessionId() {', 'function hashView() {',
    'function isHashView(view) {', 'function closePanel() {',
    'function isExtView(view) {', 'function settleDeepView(loaded = false) {', 'function trackExtLoad(promise) {', 'function releaseAwaitingView() {',
  ];
  const coldStart = source.slice(source.indexOf('if (hashView()) setView(hashView());'), source.indexOf('populateModelSelect();\nconnect();'));
  const hashListener = source.slice(source.indexOf("window.addEventListener('hashchange', () => {"), source.indexOf('// True when the board is collapsed'));
  const scope = {
    document: { getElementById: node, querySelectorAll: () => [] },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    location, history: { replaceState: () => { location.hash = ''; } },
    extViewHosts: new Map([['ext:example:list', node('extension')]]),
    sessionEmbed: { active: () => null }, syncSessionEmbed: noop,
    parseViewHash,
    clearSearch: noop, onEnterSearchView: noop, isDiffPanelOpen: () => false,
    closeDiffPanel: noop, diffPanelSessionId: noop, disarmChatHandoff: noop,
    acknowledge: noop, send: noop, setUnread: noop, renderSidebar: noop,
    syncShellTerminal: noop,
    renderPanel: (sid) => { node('sidebar').style.display = ''; log.push(['panel', sid]); },
    closeTerminal: () => log.push(['detach']),
    hideSidebar: () => { node('sidebar').style.display = 'none'; },
    renderGrid: noop,
    boardOpen: { claim: () => null }, applyEmbedView: noop,
  };
  const app = new Function(...Object.keys(scope), `
    let currentView = 'grid', selectedSessionId = null, selectedNewSlot = null;
    let selectionBeforeView = null, pendingSelect = null, currentShellTerm = null;
    let latestSessions = [{ sessionId: 'first / session' }, { sessionId: 'second' }];
    const HASH_VIEWS = ['search'];
    const AWAITING_EXT_VIEW_TIMEOUT_MS = 10000;
    const EXT_VIEW_PREFIX = 'ext:';
    let awaitingExtView = null, extGraphSeen = false, extLoadsInFlight = 0;
    ${heads.map(declaration).join('\n')}
    ${hashListener}
    const coldLoad = () => { ${coldStart} };
    return { coldLoad, trackExtLoad, settleDeepView, graphSeen: () => { extGraphSeen = true; }, awaiting: () => awaitingExtView, setView, selectSession, deselectSession, setPendingSelect, tryFulfillPending, closePanel,
      selected: () => selectedSessionId, view: () => currentView,
      sessions: (v) => { latestSessions = v; } };
  `)(...Object.values(scope));
  return { ...app, log, location, node, scope,
    hash: (value) => { location.hash = value; listeners.hashchange(); },
  };
}

for (const destination of ['search', 'ext:example:list']) {
  test(`${destination} restores a later selection despite an unresolved pending session`, () => {
    const h = harness();
    h.hash('#session=missing');
    h.selectSession('second');
    h.setView(destination);
    h.setView('grid');
    assert.equal(h.selected(), 'second');
    assert.equal(h.location.hash, '#session=second');
  });

  test(`${destination} detaches and restores the selected panel and session hash on grid`, () => {
    const h = harness();
    h.selectSession('first / session');
    h.log.length = 0;
    h.setView(destination);
    assert.equal(h.selected(), null);
    assert.equal(h.node('sidebar').style.display, 'none');
    assert.deepEqual(h.log, [['detach']]);
    assert.equal(h.location.hash, `#view=${destination}`);
    h.setView('grid');
    assert.equal(h.selected(), 'first / session');
    assert.equal(h.node('sidebar').style.display, '');
    assert.deepEqual(h.log, [['detach'], ['panel', 'first / session']]);
    assert.equal(h.location.hash, '#session=first%20%2F%20session');
  });

  test(`${destination} discards removed sessions and consumes their memory`, () => {
    const h = harness();
    h.selectSession('second');
    h.setView(destination);
    h.sessions([]);
    h.setView('grid');
    assert.equal(h.selected(), null);
    assert.equal(h.location.hash, '');
    h.sessions([{ sessionId: 'second' }]);
    h.setView('grid');
    assert.equal(h.selected(), null);
  });

  test(`${destination} without an initial selection returns to an empty grid`, () => {
    const h = harness();
    h.setView(destination);
    h.setView('grid');
    assert.equal(h.selected(), null);
    assert.deepEqual(h.log, []);
    assert.equal(h.location.hash, '');
  });
}

test('a pending session arriving after newer navigation never briefly reopens the remembered panel', () => {
  const h = harness();
  h.setPendingSelect('later');
  h.selectSession('second');
  h.setView('search');
  h.sessions([{ sessionId: 'second' }, { sessionId: 'later' }]);
  h.log.length = 0;
  h.tryFulfillPending();
  assert.deepEqual(h.log, [['panel', 'later']]);
  assert.equal(h.selected(), 'later');
  assert.equal(h.location.hash, '#session=later');
});

test('repeated and chained non-grid navigation preserves the remembered selection', () => {
  const h = harness();
  h.selectSession('second');
  for (const view of ['search', 'search', 'ext:example:list', 'search', 'ext:example:list']) h.setView(view);
  h.setView('grid');
  assert.equal(h.selected(), 'second');
});

for (const clear of ['deselectSession', 'closePanel']) {
  test(`${clear} deliberately clears remembered selection`, () => {
    const h = harness();
    h.selectSession('second');
    h.setView('search');
    h[clear]();
    h.setView('grid');
    assert.equal(h.selected(), null);
  });
}

test('a newer explicit selection replaces the remembered selection', () => {
  const h = harness();
  h.selectSession('first / session');
  h.setView('search');
  h.selectSession('second');
  h.setView('grid');
  assert.equal(h.selected(), 'second');
});

for (const pending of ['present', 'missing']) {
  test(`a ${pending} pending selection never briefly reopens the remembered panel`, () => {
    const h = harness();
    h.selectSession('first / session');
    h.setView('search');
    h.log.length = 0;
    const target = pending === 'present' ? 'second' : 'later';
    h.setPendingSelect(target);
    h.tryFulfillPending();
    h.setView('grid');
    assert.deepEqual(h.log, pending === 'present' ? [['panel', 'second']] : []);
    if (pending === 'missing') {
      h.sessions([{ sessionId: 'later' }]);
      h.tryFulfillPending();
      assert.equal(h.selected(), 'later');
    }
  });
}

test('a session hash deep link supersedes memory without reopening the old panel', () => {
  const h = harness();
  h.selectSession('first / session');
  h.setView('search');
  h.log.length = 0;
  h.hash('#session=second');
  assert.deepEqual(h.log, [['panel', 'second']]);
  assert.equal(h.location.hash, '#session=second');
});

test('clearing the hash deliberately discards remembered selection', () => {
  const h = harness();
  h.selectSession('second');
  h.setView('search');
  h.hash('');
  h.setView('grid');
  assert.equal(h.selected(), null);
});

test('an active extension embed keeps its selected panel and attached terminal', () => {
  const h = harness();
  h.selectSession('second');
  h.scope.sessionEmbed.active = () => ({ sessionId: 'second' });
  h.log.length = 0;
  h.setView('ext:example:list');
  assert.equal(h.selected(), 'second');
  assert.equal(h.node('sidebar').style.display, '');
  assert.deepEqual(h.log, []);
  assert.equal(h.location.hash, '#view=ext:example:list');
});

test('a #view=ext: deep link with extra params opens the extension view and keeps the params', () => {
  const h = harness();
  h.hash('#view=ext:example:list&cell=cell_1');
  assert.equal(h.location.hash, '#view=ext:example:list&cell=cell_1');
  assert.equal(h.view(), 'ext:example:list');
});

function gridHidden(h) {
  return h.node('grid').classList.contains('hidden');
}

test('a cold load of an unregistered ext view keeps the board hidden until it registers', () => {
  const h = harness();
  h.location.hash = '#view=ext:later:main&cell=c1';
  h.coldLoad();
  assert.equal(gridHidden(h), true);
  assert.equal(h.view(), 'grid');
  h.settleDeepView(true);
  assert.equal(gridHidden(h), true, 'no verdict before the first graph');
  h.graphSeen();
  h.scope.extViewHosts.set('ext:later:main', h.node('later'));
  h.settleDeepView(true);
  assert.equal(h.view(), 'ext:later:main');
  assert.equal(h.location.hash, '#view=ext:later:main&cell=c1');
  assert.equal(h.awaiting(), null);
});

test('a cold load of an unknown ext view falls back to the board once extensions have loaded', () => {
  const h = harness();
  h.location.hash = '#view=ext:nope:main&x=1';
  h.coldLoad();
  assert.equal(gridHidden(h), true);
  h.graphSeen();
  h.settleDeepView(false);
  assert.equal(gridHidden(h), true, 'extensions still loading');
  h.settleDeepView(true);
  assert.equal(gridHidden(h), false);
  assert.equal(h.location.hash, '');
  assert.equal(h.awaiting(), null);
});

test('a registered ext key with params is recognised by the real isExtView path', () => {
  const h = harness();
  h.hash('#view=ext:example:list&a=1&b=2');
  assert.equal(h.view(), 'ext:example:list');
  assert.equal(h.location.hash, '#view=ext:example:list&a=1&b=2');
});

test('legacy #view=history with params normalises to #view=search', () => {
  const h = harness();
  h.hash('#view=history&x=1');
  assert.equal(h.view(), 'search');
  assert.equal(h.location.hash, '#view=search');
});

test('a second load resolving mid-import does not trigger the fallback', async () => {
  const h = harness();
  h.location.hash = '#view=ext:slow:main&cell=c1';
  h.coldLoad();
  h.graphSeen();
  let finishImport;
  const first = h.trackExtLoad(new Promise((r) => { finishImport = r; }));
  await h.trackExtLoad(Promise.resolve(false));
  assert.equal(gridHidden(h), true, 'the first import is still pending');
  assert.equal(h.location.hash, '#view=ext:slow:main&cell=c1');
  h.scope.extViewHosts.set('ext:slow:main', h.node('slow'));
  finishImport(true);
  await first;
  assert.equal(h.view(), 'ext:slow:main');
});

test('a hashchange away from the awaited view releases the board', () => {
  const h = harness();
  h.location.hash = '#view=ext:later:main';
  h.coldLoad();
  assert.equal(gridHidden(h), true);
  h.hash('');
  assert.equal(gridHidden(h), false);
  assert.equal(h.awaiting(), null);
});

test('a hashchange to new params on the awaited view keeps waiting and keeps the hash', () => {
  const h = harness();
  h.location.hash = '#view=ext:later:main&cell=c1';
  h.coldLoad();
  h.hash('#view=ext:later:main&cell=c2');
  assert.equal(gridHidden(h), true);
  assert.equal(h.awaiting(), 'ext:later:main');
  assert.equal(h.location.hash, '#view=ext:later:main&cell=c2');
});

test('an import that never settles releases the board after the safety timeout', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness();
    h.location.hash = '#view=ext:stuck:main';
    h.coldLoad();
    assert.equal(gridHidden(h), true);
    mock.timers.tick(9999);
    assert.equal(gridHidden(h), true);
    mock.timers.tick(1);
    assert.equal(gridHidden(h), false);
    assert.equal(h.location.hash, '');
    assert.equal(h.awaiting(), null);
  } finally {
    mock.timers.reset();
  }
});
