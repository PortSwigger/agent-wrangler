import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMailTool } from './list-mail.js';
import { MailboxStore } from '../../mailbox-store.js';

function store() {
  return new MailboxStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-listmail-')), 'mailbox.json'));
}

test('list_mail: metadata only, never a body, oldest-first', async () => {
  const mailStore = store();
  mailStore.append('CARD1', { from: 'sess_a', body: 'x'.repeat(50), fromLabel: 'Alpha' }, 100);
  mailStore.append('CARD1', { from: 'sess_b', body: 'y'.repeat(50) }, 50);
  const out = await listMailTool.handler({ deps: { mailStore }, caller: 'CARD1' });
  assert.equal(out.structuredContent.messages.length, 2);
  assert.equal(out.structuredContent.messages[0].from, 'sess_b'); // 50 < 100
  for (const m of out.structuredContent.messages) assert.equal('body' in m, false);
});

test('list_mail: includes read and undeliverable mail alongside unread', async () => {
  const mailStore = store();
  const { id: readId } = mailStore.append('CARD1', { from: 'sess_a', body: 'a' }, 1);
  mailStore.getOne('CARD1', readId);
  mailStore.append('CARD1', { from: 'sess_b', body: 'b' }, 2);
  mailStore.markUndeliverable('CARD1'); // marks the still-unread one (sess_b's)
  const out = await listMailTool.handler({ deps: { mailStore }, caller: 'CARD1' });
  const states = out.structuredContent.messages.map((m) => m.state);
  assert.ok(states.includes('read'));
  assert.ok(states.includes('undeliverable'));
});

test('list_mail: an identity-less caller is refused', async () => {
  const mailStore = store();
  const out = await listMailTool.handler({ deps: { mailStore }, caller: null });
  assert.equal(out.isError, true);
});

test('list_mail does not drain or mutate the box (a read-only peek)', async () => {
  const mailStore = store();
  mailStore.append('CARD1', { from: 'sess_a', body: 'hi' }, 1);
  await listMailTool.handler({ deps: { mailStore }, caller: 'CARD1' });
  assert.equal(mailStore.drain('CARD1').length, 1); // still unread, still drainable
});
