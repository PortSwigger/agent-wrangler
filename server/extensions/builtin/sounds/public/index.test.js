import { test } from 'node:test';
import assert from 'node:assert/strict';
import client from './index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoundStore } from '../store.js';
import { getSoundsHandler, setSoundsHandler } from '../handlers.js';
import { createSlots } from '../../../../../public/slots.js';

function documentStub() {
  const doc = { createElement(tag) {
    return { tag, ownerDocument: doc, children: [], listeners: {}, dataset: {},
      append(...nodes) { this.children.push(...nodes); },
      appendChild(node) { this.append(node); },
      removeChild(node) { this.children.splice(this.children.indexOf(node), 1); },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this[name] = value; },
    };
  } };
  return doc;
}
function descendants(root) { return [root, ...root.children.flatMap(descendants)]; }
function setup(t, initial = {}, { holdReads = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sound-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SoundStore(path.join(dir, 'sounds.json'));
  store.save(initial);
  const clients = [];
  let paused = false;
  const delayed = [];
  const server = { stores: { sounds: store }, broadcast(msg) {
    for (const slots of clients) slots.dispatchMessage({ ...msg, type: 'ext:sounds' });
  } };
  function createBrowser() {
    const document = documentStub();
    const slots = createSlots({ document, handlerTypesFor: () => ['sounds-get', 'sounds-set'] });
    clients.push(slots);
    const api = { send(msg) {
      if (msg.type === 'sounds-get' && holdReads) return;
      const reply = (response) => slots.dispatchMessage({ ...response, type: 'ext:sounds' });
      if (msg.type === 'sounds-set' && paused) delayed.push({ msg: structuredClone(msg), reply });
      else (msg.type === 'sounds-set' ? setSoundsHandler : getSoundsHandler).handler(msg, server, reply);
    } };
    client.register(slots.forExtension('sounds', api));
    const host = document.createElement('div');
    slots.mountInto('settings.panel', host, api, { onlyExt: 'sounds' });
    return { slots, host };
  }
  return { ...createBrowser(), read: () => store.read(), createBrowser, resumeReads: () => { holdReads = false; }, pauseSaves: () => { paused = true; }, flushSave: () => { paused = false; const { msg, reply } = delayed.shift(); setSoundsHandler.handler(msg, server, reply); } };
}

test('settings have no second toggle and reset shared audio on save', async (t) => {
  const { slots, host, read } = setup(t, { finished: { name: 'custom.wav', data: 'data:audio/wav;base64,AAAA' } });
  const elements = descendants(host);
  assert.equal(elements.some((el) => el.type === 'checkbox'), false);
  assert.ok(elements.some((el) => el.textContent === 'custom.wav'));
  assert.equal(elements.filter((el) => el.type === 'file').length, 2);
  await elements.find((el) => el.textContent === 'Use default').listeners.click();
  await slots.savePanels(host);
  assert.deepEqual(read(), {});
});

test('an invalid upload shows its error and does not overwrite saved audio', async (t) => {
  const { slots, host, read } = setup(t);
  const elements = descendants(host);
  const file = elements.find((el) => el.type === 'file');
  file.files = [{ size: 2 * 1024 * 1024, name: 'large.wav' }];
  await file.listeners.change();
  assert.ok(descendants(host).some((el) => /1 MB/.test(el.textContent || '')));
  await assert.rejects(slots.savePanels(host), /1 MB/);
  assert.deepEqual(read(), {});
});

test('save waits for a successful upload and persists the audio for later playback', async (t) => {
  const { slots, host, read } = setup(t);
  const original = globalThis.AudioContext;
  let finishDecode;
  globalThis.AudioContext = class {
    decodeAudioData() { return new Promise((resolve) => { finishDecode = resolve; }); }
    async close() {}
  };
  t.after(() => { globalThis.AudioContext = original; });
  const elements = descendants(host);
  const file = elements.find((el) => el.type === 'file');
  file.files = [{ name: 'custom.wav', size: 4, arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer }];
  const upload = file.listeners.change();
  await new Promise(setImmediate);
  const save = slots.savePanels(host);
  assert.deepEqual(read(), {});
  finishDecode();
  await upload;
  await save;
  assert.deepEqual(read(), {
    finished: { name: 'custom.wav', data: 'data:audio/wav;base64,UklGRg==' },
  });
});

test('a shared save updates another browser and disabling the extension removes playback', async (t) => {
  const { slots, host, createBrowser } = setup(t, { finished: { name: 'shared.wav', data: 'data:audio/wav;base64,AAAA' } });
  const peer = createBrowser();
  assert.ok(descendants(peer.host).some((el) => el.textContent === 'shared.wav'));
  descendants(host).find((el) => el.textContent === 'Use default').listeners.click();
  await slots.savePanels(host);
  assert.equal(descendants(peer.host).some((el) => el.textContent === 'shared.wav'), false);
  assert.equal(descendants(peer.host).filter((el) => el.textContent === 'Built-in tone').length, 2);
  peer.slots.removeExtension('sounds');
  assert.deepEqual(peer.slots.contributions('notification.cue'), []);
});

test('an edit made while saving stays unsaved after the acknowledgement', async (t) => {
  const { slots, host, createBrowser, pauseSaves, flushSave } = setup(t, {
    finished: { name: 'saved.wav', data: 'data:audio/wav;base64,AAAA' },
  });
  pauseSaves();
  const saving = slots.savePanels(host);
  await new Promise(setImmediate);
  descendants(host).find((el) => el.textContent === 'Use default').listeners.click();
  flushSave();
  await saving;
  const peer = createBrowser();
  await peer.slots.savePanels(peer.host);
  assert.equal(descendants(host).some((el) => el.textContent === 'saved.wav'), false);
});

test('a successful reconnect clears a load timeout and allows saving', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { slots, host, resumeReads } = setup(t, {}, { holdReads: true });
  t.mock.timers.tick(10001);
  await new Promise(setImmediate);
  assert.ok(descendants(host).some((el) => /timed out/.test(el.textContent || '')));
  resumeReads();
  slots.connected();
  assert.equal(descendants(host).some((el) => /timed out/.test(el.textContent || '')), false);
  await slots.savePanels(host);
});

test('reconnecting before a load timeout settles the earlier request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { slots, host, resumeReads } = setup(t, {}, { holdReads: true });
  resumeReads();
  slots.connected();
  t.mock.timers.tick(10001);
  await new Promise(setImmediate);
  assert.equal(descendants(host).some((el) => /timed out/.test(el.textContent || '')), false);
  await slots.savePanels(host);
});
