import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browseFoldersHandler } from './browse-folders.js';

function tempTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-bf-')));
  for (const d of ['alpha', 'alpine', 'beta', '.hidden']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'alfafile'), 'x');
  fs.symlinkSync(path.join(root, 'beta'), path.join(root, 'linked'));
  return root;
}

function ctx() {
  const sent = [];
  return { sent, reply: (o) => sent.push(o) };
}

const call = async (p) => { const c = ctx(); await browseFoldersHandler.handler({ path: p }, c); return c.sent[0]; };

test('browse-folders: trailing slash lists the folder\'s own children', async () => {
  const root = tempTree();
  const r = await call(`${root}/`);
  assert.deepEqual(r.entries.map((p) => path.basename(p)), ['alpha', 'alpine', 'beta', 'linked']);
  assert.equal(r.exists, true);
});

test('browse-folders: a partial name filters siblings by prefix, directories only', async () => {
  const root = tempTree();
  const r = await call(`${root}/alp`);
  assert.deepEqual(r.entries.map((p) => path.basename(p)), ['alpha', 'alpine']);
  assert.equal(r.exists, false); // 'alp' itself isn't a folder
});

test('browse-folders: a symlink to a directory is offered, a plain file is not', async () => {
  const root = tempTree();
  assert.deepEqual((await call(`${root}/link`)).entries.map((p) => path.basename(p)), ['linked']);
  assert.deepEqual((await call(`${root}/alf`)).entries, []);
});

test('browse-folders: dotfolders only appear once a dot is typed', async () => {
  const root = tempTree();
  assert.equal((await call(`${root}/`)).entries.some((p) => p.endsWith('.hidden')), false);
  assert.deepEqual((await call(`${root}/.h`)).entries.map((p) => path.basename(p)), ['.hidden']);
});

test('browse-folders: blank path has no opinion on existence; a missing parent yields no entries', async () => {
  assert.equal((await call('')).exists, null);
  assert.equal((await call('   ')).exists, null);
  const r = await call('/definitely/not/here/x');
  assert.equal(r.exists, false);
  assert.deepEqual(r.entries, []);
});

test('browse-folders: a relative path is rejected rather than resolved against cwd', async () => {
  const r = await call('server');
  assert.equal(r.exists, false);
  assert.deepEqual(r.entries, []);
});

test('browse-folders: the typed path is echoed verbatim so a stale reply can be dropped', async () => {
  const root = tempTree();
  assert.equal((await call(`${root}/alp`)).path, `${root}/alp`);
});

test('browse-folders: a trailing slash on an existing folder still reads as existing', async () => {
  const root = tempTree();
  assert.equal((await call(`${root}/beta/`)).exists, true);
});
