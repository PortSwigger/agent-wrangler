import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNotifyArgv, notifyOverride, userNotifyArgv } from './codex-notify-config.js';

test('parseNotifyArgv reads a single-line array', () => {
  assert.deepEqual(parseNotifyArgv('model = "x"\nnotify = [ "/opt/app/bin/client", "turn-ended" ]\n'), ['/opt/app/bin/client', 'turn-ended']);
});

test('parseNotifyArgv honours basic-string escapes', () => {
  assert.deepEqual(parseNotifyArgv('notify = ["C:\\\\tools\\\\n.exe", "say \\"hi\\""]'), ['C:\\tools\\n.exe', 'say "hi"']);
});

test('parseNotifyArgv returns null for multi-line or literal strings', () => {
  assert.equal(parseNotifyArgv('notify = [\n  "/a",\n  "b"\n]'), null);
  assert.equal(parseNotifyArgv("notify = [ '/a', 'b' ]"), null);
  assert.equal(parseNotifyArgv('[hooks]\nnotify = ["/a"]'), null);
  assert.equal(parseNotifyArgv('model = "x"'), null);
});

test('notifyOverride produces a TOML array of basic strings', () => {
  assert.equal(notifyOverride('/usr/bin/node', '/srv/a "b"/hook.js'), 'notify=["/usr/bin/node","/srv/a \\"b\\"/hook.js"]');
});

test('userNotifyArgv reads the given config and is null on a read error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-notify-cfg-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'notify = ["/bin/true", "x"]\n');
  assert.deepEqual(userNotifyArgv(file), ['/bin/true', 'x']);
  assert.equal(userNotifyArgv(path.join(dir, 'missing.toml')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
