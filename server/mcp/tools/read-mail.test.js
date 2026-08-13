import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMailTool } from './read-mail.js';
import { MailboxStore } from '../../mailbox-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function store() {
  return new MailboxStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-readmail-')), 'mailbox.json'));
}

test('read_mail with no id: drains everything unread, oldest-first', async () => {
  const mailStore = store();
  mailStore.append('CARD1', { from: 'sess_a', body: 'first' }, 100);
  mailStore.append('CARD1', { from: 'sess_b', body: 'second' }, 200);
  const out = await readMailTool.handler({ deps: { mailStore }, caller: 'CARD1' }, {});
  assert.equal(out.structuredContent.messages.length, 2);
  assert.equal(out.structuredContent.messages[0].body, 'first');
  assert.equal(mailStore.drain('CARD1').length, 0); // actually drained, not just peeked
});

test('read_mail with an id: returns that one message in full', async () => {
  const mailStore = store();
  const { id } = mailStore.append('CARD1', { from: 'sess_a', body: 'x'.repeat(6000) }, 100);
  const out = await readMailTool.handler({ deps: { mailStore }, caller: 'CARD1' }, { id });
  assert.equal(out.structuredContent.message.body.length, 6000); // full body, not excerpted
  assert.equal(out.structuredContent.message.truncated, false);
});

test('read_mail with an unknown id: errors', async () => {
  const mailStore = store();
  const out = await readMailTool.handler({ deps: { mailStore }, caller: 'CARD1' }, { id: 'nope' });
  assert.equal(out.isError, true);
});

test('read_mail: an identity-less caller is refused (no mailbox to read)', async () => {
  const mailStore = store();
  const out = await readMailTool.handler({ deps: { mailStore }, caller: null }, {});
  assert.equal(out.isError, true);
});

test('read_mail: reads only the CALLER\'s own mailbox, never another card\'s', async () => {
  const mailStore = store();
  mailStore.append('OTHER', { from: 'sess_a', body: 'not yours' }, 100);
  const out = await readMailTool.handler({ deps: { mailStore }, caller: 'CARD1' }, {});
  assert.deepEqual(out.structuredContent.messages, []);
});
