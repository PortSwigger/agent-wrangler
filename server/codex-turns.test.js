import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { turnRecordFrom, turnsDir, writeTurnRecord, readTurnRecord } from './codex-turns.js';

const run = promisify(execFile);
const hookPath = fileURLToPath(new URL('./codex-notify-hook.js', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-turns-'));
const payload = { type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'u1', cwd: '/w', client: 'codex-tui', 'input-messages': ['hi'], 'last-assistant-message': 'done' };

async function waitFor(file, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

function runHook({ dataDir, codexHome, arg = JSON.stringify(payload) }) {
  return run(process.execPath, [hookPath, arg], { env: { ...process.env, AW_DATA_DIR: dataDir, CODEX_HOME: codexHome } });
}

test('turnRecordFrom maps the Codex payload', () => {
  const r = turnRecordFrom({ ...payload, 'last-assistant-message': 'x'.repeat(2500) }, 1000);
  assert.deepEqual(r, { threadId: 't1', turnId: 'u1', endedAt: 1000, lastAssistantMessage: 'x'.repeat(2000), cwd: '/w' });
});

test('turnRecordFrom rejects other events and missing ids', () => {
  assert.equal(turnRecordFrom({ type: 'approval-requested', 'thread-id': 't1' }, 1), null);
  assert.equal(turnRecordFrom({ type: 'agent-turn-complete' }, 1), null);
  assert.equal(turnRecordFrom('nope', 1), null);
});

test('writeTurnRecord then readTurnRecord round-trips under a temp data dir', async () => {
  const dir = tmp();
  const rec = turnRecordFrom(payload, 5);
  await writeTurnRecord(rec, dir);
  assert.equal(turnsDir(dir), path.join(dir, 'codex-turns'));
  assert.deepEqual(readTurnRecord('t1', dir), rec);
  assert.equal(readTurnRecord('missing', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTurnRecord is null for invalid JSON or a non-finite endedAt', () => {
  const dir = tmp();
  fs.mkdirSync(turnsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(turnsDir(dir), 'bad.json'), '{nope');
  fs.writeFileSync(path.join(turnsDir(dir), 'nan.json'), JSON.stringify({ threadId: 'nan', endedAt: 'x' }));
  assert.equal(readTurnRecord('bad', dir), null);
  assert.equal(readTurnRecord('nan', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the hook script writes the record and chains the user notify command with the payload appended', async () => {
  const dataDir = tmp();
  const codexHome = tmp();
  const rec = path.join(codexHome, 'rec.sh');
  const argvOut = path.join(codexHome, 'argv.txt');
  fs.writeFileSync(rec, `printf '%s\\n' "$@" > "${argvOut}"\n`);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `notify = [ "/bin/sh", "${rec}", "turn-ended" ]\n`);
  await runHook({ dataDir, codexHome });
  assert.equal(readTurnRecord('t1', dataDir).turnId, 'u1');
  const out = await waitFor(argvOut);
  assert.deepEqual(out.trimEnd().split('\n'), ['turn-ended', JSON.stringify(payload)]);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});

test('the hook script exits 0 and still writes the record when the user command is missing', async () => {
  const dataDir = tmp();
  const codexHome = tmp();
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');
  await runHook({ dataDir, codexHome });
  assert.equal(readTurnRecord('t1', dataDir).turnId, 'u1');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});

test('the hook script exits 0 on an unparsable payload', async () => {
  const dataDir = tmp();
  const codexHome = tmp();
  await runHook({ dataDir, codexHome, arg: '{nope' });
  assert.equal(fs.existsSync(turnsDir(dataDir)), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});

test('the hook script does not chain to itself', async () => {
  const dataDir = tmp();
  const codexHome = tmp();
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `notify = ["${process.execPath}", "${hookPath}"]\n`);
  const started = Date.now();
  await runHook({ dataDir, codexHome });
  assert.ok(Date.now() - started < 2000);
  const first = readTurnRecord('t1', dataDir).endedAt;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readTurnRecord('t1', dataDir).endedAt, first);
  assert.deepEqual(fs.readdirSync(turnsDir(dataDir)), ['t1.json']);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});
