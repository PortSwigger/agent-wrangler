import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nativeHookGroups } from './native-hooks.js';

test('Codex hook command resolves a quoted Claude plugin root', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-hook-root-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, 'skills', 'native');
  fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf %s "${CLAUDE_PLUGIN_ROOT}"' }] }],
  } }));
  const command = nativeHookGroups({ dir, skills: ['native'] }).UserPromptSubmit[0].hooks[0].command;
  assert.equal(execFileSync('sh', ['-c', command], { encoding: 'utf8' }), plugin);
});
