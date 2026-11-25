import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatHandler } from './chat.js';
import { chatImageHandler, sniffRaster } from './chat-image.js';
import { buildActionRegistry, handleAction } from '../../deck/actions.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// A PNG header padded out, standing in for a full-size screenshot.
const screenshot = (bytes, fill = 1) => Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(bytes, fill)]).toString('base64');

const ts = (s) => `2026-11-25T10:00:${String(s).padStart(2, '0')}.000Z`;
const userLine = (text, s) => ({ type: 'user', timestamp: ts(s), message: { role: 'user', content: text } });
const toolUse = (id, name, input, s) => ({ type: 'assistant', timestamp: ts(s), message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] } });
const imageResult = (id, images, s, mediaType = 'image/png') => ({
  type: 'user', timestamp: ts(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })) }] },
});
const jsonl = (lines) => lines.map((o) => JSON.stringify(o)).join('\n') + '\n';

async function tmpFile(name, text) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-chat-image-'));
  const file = path.join(dir, name);
  await fsp.writeFile(file, text);
  return file;
}

function ctx(file, node = { liveSessionId: 'live-img', agent: 'claude' }) {
  const sent = [];
  return { sent, reply: (o) => sent.push(o), sessionFromGraph: () => node, findConversationFile: async () => file, analyzeProvider: async () => null };
}

async function poll(c, sessionId = 'card-img') {
  await chatHandler.handler({ type: 'chat', sessionId, token: 't' }, c);
  return c.sent.at(-1);
}

async function fetchImage(c, ref, sessionId = 'card-img') {
  c.sent.length = 0;
  await chatImageHandler.handler({ type: 'chat-image', sessionId, ref }, c);
  return c.sent.at(-1);
}

test('chat-image: a frame carries refs only, and each ref reads back its own image', async () => {
  const shots = [screenshot(1_500_000, 1), screenshot(1_500_000, 2), screenshot(900_000, 3)];
  const file = await tmpFile('conv.jsonl', jsonl([
    userLine('take some screenshots', 0),
    toolUse('r1', 'Read', { file_path: '/repo/docs/diagram.png' }, 1),
    imageResult('r1', [shots[0]], 2),
    toolUse('c1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }, 3),
    imageResult('c1', [shots[1], shots[2]], 4),
  ]));
  const c = ctx(file);
  const frame = await poll(c);
  const tools = frame.events.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((t) => t.images.length), [1, 2]);
  assert.ok(JSON.stringify(frame).length < 4096, `frame is ${JSON.stringify(frame).length} bytes for ~5 MB of screenshots`);

  const refs = tools.flatMap((t) => t.images.map((i) => i.ref));
  for (const [i, ref] of refs.entries()) {
    const reply = await fetchImage(c, ref);
    assert.equal(reply.type, 'chat-image');
    assert.equal(reply.mediaType, 'image/png');
    assert.equal(reply.data, shots[i], `ref ${i} reads back its own bytes`);
    assert.equal(reply.ref, ref);
  }
});

test('chat-image: a ref that no longer names the same line is refused, never served from elsewhere', async () => {
  const lines = [userLine('go', 0), toolUse('r1', 'Read', { file_path: '/a.png' }, 1), imageResult('r1', [PNG_1PX], 2)];
  const file = await tmpFile('conv.jsonl', jsonl(lines));
  const c = ctx(file);
  const [{ images: [{ ref }] }] = (await poll(c)).events.filter((e) => e.kind === 'tool');
  const [at, len, n, b64] = ref.split('-').map(Number);

  for (const forged of [`${at + 1}-${len}-${n}-${b64}`, `${at}-${len - 1}-${n}-${b64}`, `${at}-${len}-1-${b64}`, `${at}-${len}-${n}-${b64 + 4}`, `${at}-${len + 999}-0-${b64}`, 'not-a-ref']) {
    const reply = await fetchImage(c, forged);
    assert.equal(reply.type, 'error', forged);
  }

  // The transcript rewritten under the same name: the range now holds other bytes.
  await fsp.writeFile(file, jsonl([userLine('a different conversation entirely, longer than before', 0), ...lines.slice(1)]));
  assert.equal((await fetchImage(c, ref)).type, 'error');
});

test('chat-image: only real rasters are served, whatever the transcript labelled them', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const file = await tmpFile('conv.jsonl', jsonl([toolUse('r1', 'Read', { file_path: '/a.png' }, 1), imageResult('r1', [svg], 2, 'image/png')]));
  const c = ctx(file);
  const [{ images: [{ ref }] }] = (await poll(c)).events.filter((e) => e.kind === 'tool');
  const reply = await fetchImage(c, ref);
  assert.equal(reply.type, 'error');
  assert.match(reply.message, /not a PNG, JPEG, GIF or WebP/);

  assert.equal(sniffRaster(PNG_1PX), 'image/png');
  assert.equal(sniffRaster(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64')), 'image/jpeg');
  assert.equal(sniffRaster(Buffer.from('GIF89a\x01\x00').toString('base64')), 'image/gif');
  assert.equal(sniffRaster(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ').toString('base64')), 'image/webp');
  assert.equal(sniffRaster(svg), null);
});

test('chat-image: a PNG mislabelled as JPEG is served as what it is', async () => {
  const file = await tmpFile('conv.jsonl', jsonl([toolUse('r1', 'Read', { file_path: '/a.jpg' }, 1), imageResult('r1', [PNG_1PX], 2, 'image/jpeg')]));
  const c = ctx(file);
  const [{ images: [{ ref, type }] }] = (await poll(c)).events.filter((e) => e.kind === 'tool');
  assert.equal(type, 'image/jpeg');
  assert.equal((await fetchImage(c, ref)).mediaType, 'image/png');
});

test('chat-image: a Codex tool output image reads back through the rollout', async () => {
  const line = (payload, s) => ({ timestamp: ts(s), type: 'response_item', payload });
  const file = await tmpFile('rollout-2026-11-25T10-00-00-live-codex.jsonl', jsonl([
    line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look at the page' }] }, 0),
    line({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'shot()' }, 1),
    line({ type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'done' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG_1PX}` }] }, 2),
  ]));
  const c = ctx(file, { liveSessionId: 'live-codex', agent: 'codex' });
  const [tool] = (await poll(c)).events.filter((e) => e.kind === 'tool');
  const reply = await fetchImage(c, tool.images[0].ref);
  assert.equal(reply.data, PNG_1PX);
});

test('chat-image: a card at a location reads the image from its transcript hook', async () => {
  const text = jsonl([toolUse('r1', 'Read', { file_path: '/a.png' }, 1), imageResult('r1', [PNG_1PX], 2)]);
  const c = ctx(null, { liveSessionId: 'loc-img', agent: 'claude' });
  const entry = { liveSessionId: 'loc-img', agent: 'claude', runtime: 'remote', location: { box: 'b1' } };
  c.sessionManager = { entryFor: () => entry };
  c.findConversationFile = async () => { throw new Error('a location card must not read the deck disk'); };
  c.findRuntime = () => ({ id: 'remote', location: { transcript: async () => text } });
  const [tool] = (await poll(c, 'card-loc')).events.filter((e) => e.kind === 'tool');
  assert.equal((await fetchImage(c, tool.images[0].ref, 'card-loc')).data, PNG_1PX);
});

test('chat-image: through the deck, an image is a result and a refusal is a failed one', async () => {
  const file = await tmpFile('conv.jsonl', jsonl([toolUse('r1', 'Read', { file_path: '/a.png' }, 1), imageResult('r1', [PNG_1PX], 2)]));
  const c = ctx(file);
  const [tool] = (await poll(c)).events.filter((e) => e.kind === 'tool');
  const registry = buildActionRegistry({ handlers: [chatImageHandler] });
  const results = [];
  const deckCtx = { ...c, send: (r) => results.push(r), sessionFromGraph: () => ({ liveSessionId: 'live-img', agent: 'claude' }) };
  const invoke = (h, m, x) => h.handler(m, x);
  await handleAction({ type: 'action', id: 1, action: 'session.chat-image', session: 'card-img', args: { ref: tool.images[0].ref } }, deckCtx, { registry, invoke });
  await handleAction({ type: 'action', id: 2, action: 'session.chat-image', session: 'card-img', args: { ref: '0-1-0-4' } }, deckCtx, { registry, invoke });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].data.data, PNG_1PX);
  assert.equal(results[1].ok, false);
});
