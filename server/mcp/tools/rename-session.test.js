import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSessionTool } from './rename-session.js';

function deps(entries = {}) {
  const calls = { rename: [], rebuild: 0 };
  return {
    calls,
    d: {
      sessionManager: {
        entryFor: (id) => entries[id] ?? null,
        rename: (target, name, snapshot) => { calls.rename.push({ target, name, snapshot }); return true; },
      },
      rebuild: async () => { calls.rebuild += 1; },
    },
  };
}

test('rename_session requires a target', async () => {
  const { d } = deps();
  const out = await renameSessionTool.handler({ deps: d }, { name: 'Useful title' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /target is required/);
});

test('rename_session rejects an unknown target', async () => {
  const { d, calls } = deps();
  const out = await renameSessionTool.handler({ deps: d }, { target: 'missing', name: 'Useful title' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown session missing/);
  assert.equal(calls.rename.length, 0);
});

test('rename_session renames a known target and rebuilds', async () => {
  const entry = { cwd: '/work/project', intent: 'Original task' };
  const { d, calls } = deps({ S1: entry });
  const out = await renameSessionTool.handler({ deps: d }, { target: 'S1', name: '  Useful title  ' });
  assert.deepEqual(out.structuredContent, { target: 'S1', name: 'Useful title', renamed: true });
  assert.deepEqual(calls.rename, [{ target: 'S1', name: '  Useful title  ', snapshot: entry }]);
  assert.equal(calls.rebuild, 1);
});

test('rename_session reports null when clearing a title', async () => {
  const { d } = deps({ S1: { cwd: '/work/project', intent: 'Original task' } });
  const out = await renameSessionTool.handler({ deps: d }, { target: 'S1', name: '' });
  assert.deepEqual(out.structuredContent, { target: 'S1', name: null, renamed: true });
});

test('rename_session only_if_unnamed preserves a human title', async () => {
  const { d, calls } = deps({ S1: { name: 'My chosen title', cwd: '/work/project', intent: 'Original task' } });
  const out = await renameSessionTool.handler({ deps: d }, { target: 'S1', name: 'Agent suggestion', only_if_unnamed: true });
  assert.deepEqual(out.structuredContent, { target: 'S1', name: 'My chosen title', renamed: false });
  assert.equal(calls.rename.length, 0);
  assert.equal(calls.rebuild, 0);
});

test('rename_session only_if_unnamed sets an unnamed card', async () => {
  const { d, calls } = deps({ S1: { cwd: '/work/project', intent: 'Original task' } });
  const out = await renameSessionTool.handler({ deps: d }, { target: 'S1', name: 'Agent suggestion', only_if_unnamed: true });
  assert.equal(out.structuredContent.renamed, true);
  assert.equal(calls.rename.length, 1);
});

test('rename_session only_if_unnamed can replace a fork title inherited from its parent', async () => {
  const { d, calls } = deps({ S1: { name: 'Parent title', nameInherited: true, cwd: '/work/project', intent: 'Fork task' } });
  const out = await renameSessionTool.handler({ deps: d }, { target: 'S1', name: 'Fork task title', only_if_unnamed: true });
  assert.equal(out.structuredContent.renamed, true);
  assert.equal(calls.rename.length, 1);
});
