import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { restoreSessionTool } from './restore-session.js';

function deps({ live = false, cwd = os.tmpdir() } = {}) {
  const calls = { resume: [], rebuild: 0 };
  return {
    calls,
    sessionManager: {
      entryFor: (id) => (id === 'S1' ? { cwd, archivedAt: 1 } : undefined),
      clearSnooze: () => false,
      resume: async (id, dir, opts) => { calls.resume.push({ id, dir, opts }); return { tmux: 't' }; },
    },
    taskStore: { isAssignedToArchivedTask: () => false, unassign() {} },
    sessionFromGraph: () => (live ? { tmux: 'x' } : null),
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('resumes an archived session', async () => {
  const d = deps();
  const out = await restoreSessionTool.handler({ deps: d }, { target: 'S1' });
  assert.equal(out.isError, undefined);
  assert.equal(d.calls.resume.length, 1);
  assert.equal(out.structuredContent.restored, true);
});

test('asks for recreate_dir when the launch dir is gone', async () => {
  const d = deps({ cwd: path.join(os.tmpdir(), 'aw-missing-dir-xyz') });
  const out = await restoreSessionTool.handler({ deps: d }, { target: 'S1' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /recreate_dir/);
  assert.equal(d.calls.resume.length, 0);
});

test('rejects unknown and live sessions', async () => {
  assert.equal((await restoreSessionTool.handler({ deps: deps() }, { target: 'nope' })).isError, true);
  const out = await restoreSessionTool.handler({ deps: deps({ live: true }) }, { target: 'S1' });
  assert.match(out.content[0].text, /already live/);
});
