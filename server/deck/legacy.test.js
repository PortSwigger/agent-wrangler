import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateStream } from './state.js';
import { NATIVE_ACTIONS } from './native-actions.js';
import { actionForLegacyType, createLegacyFileRoutes, legacyGraphFrame, legacyReply, resetLegacyWarnings, warnLegacy } from './legacy.js';

const graph = {
  generatedAt: 1,
  sessions: [{ id: 'session:a', type: 'session', sessionId: 'a', label: 'A', pid: 12, socket: 's', jobId: 'j' }],
  history: [{ sessionId: 'h' }],
  nodes: [{ id: 'session:a', type: 'session', sessionId: 'a', label: 'A', pid: 12, socket: 's', jobId: 'j' }, { id: 'folder:/x', type: 'folder' }],
  edges: [],
  tasks: { tasks: [] },
  schedules: [],
  defaultRuntime: 'local',
  codeVersion: 'abc',
  todos: { items: [1] },
};

test('the legacy graph frame is built from the state frame and gives back the full session record', () => {
  const stream = createStateStream({ startRev: 1 });
  stream.observe(graph, { todos: { todos: { items: [1] } } });
  const state = JSON.parse(stream.next());
  assert.ok(!('pid' in state.sessions[0]), 'the state frame itself leaves the field out');
  const frame = JSON.parse(legacyGraphFrame(state));
  assert.equal(frame.type, 'graph');
  assert.deepEqual(frame.graph, { ...graph, tasks: { tasks: [] } });
});

test('a state frame without history makes a graph frame without history', () => {
  const stream = createStateStream({ startRev: 1 });
  stream.observe(graph, {});
  stream.next();
  stream.observe({ ...graph, defaultRuntime: 'docker' }, {});
  const frame = JSON.parse(legacyGraphFrame(JSON.parse(stream.next())));
  assert.ok(!('history' in frame.graph));
  assert.equal(frame.graph.defaultRuntime, 'docker');
});

test('events and results turn back into the old reply types', () => {
  assert.deepEqual(legacyReply({ type: 'event', event: 'notify', session: null, data: { type: 'notify', x: 1 } }), { type: 'notify', x: 1 });
  assert.deepEqual(legacyReply({ type: 'result', id: 1, ok: true, data: { type: 'task-created', taskId: 't' } }), { type: 'task-created', taskId: 't' });
  assert.equal(legacyReply({ type: 'result', id: 1, ok: true, data: null }), null, 'no reply, nothing sent');
  assert.deepEqual(legacyReply({ type: 'result', id: 1, ok: false, data: null, error: { code: 'failed', message: 'boom' } }), { type: 'error', message: 'boom' });
  assert.equal(legacyReply({ type: 'result', id: 1, ok: false, data: null, error: { code: 'unsupported', message: 'x' } }), null, 'an unknown type stays a no-op');
});

test('a legacy type finds its action by the handler behind it, core or extension', () => {
  const registry = new Map([
    ['task.create', { action: 'task.create', handler: { type: 'task-create' } }],
    ['ext.todos.todo-add', { action: 'ext.todos.todo-add', handler: { type: 'todo-add', extId: 'todos' } }],
    ['session.file', { action: 'session.file', run: () => {} }],
  ]);
  assert.equal(actionForLegacyType(registry, 'task-create'), 'task.create');
  assert.equal(actionForLegacyType(registry, 'todo-add'), 'ext.todos.todo-add');
  assert.equal(actionForLegacyType(registry, 'session.file'), null);
  assert.equal(actionForLegacyType(registry, 'nope'), null);
});

test('each surface warns once, naming its replacement', () => {
  resetLegacyWarnings();
  const lines = [];
  warnLegacy('GET /file', 'the session.file action', (m) => lines.push(m));
  warnLegacy('GET /file', 'the session.file action', (m) => lines.push(m));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GET \/file is deprecated.*use the session\.file action instead/);
});

function response() {
  const res = { status: null, headers: null, body: null, headersSent: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

test('GET /file and GET /ext-file run the actions and answer as they always did', async () => {
  const calls = [];
  const ctx = {
    readMarkdownFile: async (p) => { calls.push(['file', p]); return p === '/ok.md' ? { status: 200, path: '/real/ok.md', content: '# ok' } : { status: 415, message: 'only .md' }; },
    openExtFile: async (ext, p) => { calls.push(['ext', ext, p]); return ext === 'todos' ? { ok: true, kind: 'markdown', content: 'x' } : { ok: false, reason: 'not-permitted' }; },
  };
  const registry = () => new Map(NATIVE_ACTIONS.map((a) => [a.action, a]));
  const routes = createLegacyFileRoutes({ registry, ctx: () => ctx, allowedHost: (h) => h === 'localhost:1' });
  const req = (url, host = 'localhost:1') => ({ url, headers: { host } });

  let res = response();
  await routes.file(req('/file?path=%2Fok.md'), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { path: '/real/ok.md', content: '# ok' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(!('Access-Control-Allow-Origin' in res.headers));

  res = response();
  await routes.file(req('/file?path=%2Fa.txt'), res);
  assert.equal(res.status, 415);
  assert.deepEqual(res.body, { error: 'only .md' });

  res = response();
  await routes.file(req('/file?path=%2Fok.md', 'evil.example:1'), res);
  assert.equal(res.status, 403);

  res = response();
  await routes.extFile(req('/ext-file?ext=todos&path=a.md'), res);
  assert.deepEqual([res.status, res.body], [200, { ok: true, kind: 'markdown', content: 'x' }]);
  res = response();
  await routes.extFile(req('/ext-file?ext=other&path=a.md'), res);
  assert.deepEqual([res.status, res.body], [200, { ok: false, reason: 'not-permitted' }]);
  res = response();
  await routes.extFile(req('/ext-file?path=a.md'), res);
  assert.deepEqual([res.status, res.body], [200, { ok: false, reason: 'not-permitted' }], 'no ext id, as before');
  assert.deepEqual(calls, [['file', '/ok.md'], ['file', '/a.txt'], ['ext', 'todos', 'a.md'], ['ext', 'other', 'a.md']]);
});
