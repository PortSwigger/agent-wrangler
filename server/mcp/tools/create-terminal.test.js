import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createTerminalTool } from './create-terminal.js';

function makeDeps(overrides = {}) {
  return {
    sessionManager: { entryFor: () => ({ cwd: '/tmp/test', intent: 'test' }), socket: 'aw' },
    boardClients: () => 1,
    terminalRegistry: { set: () => {} },
    createShellSession: async () => 'sh_ab12',
    broadcast: () => {},
    ...overrides,
  };
}

test('create_terminal rejects command containing a newline', async () => {
  const schema = z.object(createTerminalTool.inputSchema);
  assert.equal(schema.safeParse({ command: 'echo hello\necho bad' }).success, false);
  assert.equal(schema.safeParse({ command: 'echo hello' }).success, true);
  assert.equal(schema.safeParse({}).success, true); // command optional
});

test('create_terminal errors when no caller', async () => {
  const out = await createTerminalTool.handler({ deps: makeDeps(), caller: null }, {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /session identity/);
});

test('create_terminal errors when caller entry has no cwd', async () => {
  const deps = makeDeps({ sessionManager: { entryFor: () => ({ intent: 'x' }), socket: '' } });
  const out = await createTerminalTool.handler({ deps, caller: 'CARD1' }, {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /working directory/);
});

test('create_terminal errors when no board clients connected', async () => {
  const deps = makeDeps({ boardClients: () => 0 });
  const out = await createTerminalTool.handler({ deps, caller: 'CARD1' }, {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /No board clients/);
});

test('create_terminal creates session, registers it, broadcasts, and returns success', async () => {
  const captured = {};
  const deps = makeDeps({
    terminalRegistry: { set: (id, entry) => { captured.id = id; captured.entry = entry; } },
    broadcast: (obj) => { captured.broadcast = obj; },
  });
  const out = await createTerminalTool.handler({ deps, caller: 'CARD1' }, { command: 'ls -la' });
  assert.equal(out.isError, undefined);
  assert.match(out.content[0].text, /Shell terminal opened/);
  assert.match(captured.id, /^t_/);
  assert.equal(captured.entry.tmuxName, 'sh_ab12');
  assert.equal(captured.broadcast.type, 'open-terminal');
  assert.equal(captured.broadcast.command, 'ls -la');
});
