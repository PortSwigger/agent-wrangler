import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const attachClipboard = app.slice(app.indexOf('function attachClipboard('), app.indexOf('// xterm.js 5.x defaults'));
const addon = readFileSync(new URL('./vendor/addon-clipboard.min.js', import.meta.url), 'utf8');

function terminalClipboard({ reject = false } = {}) {
  let clipboard = 'text waiting to be pasted';
  let writes = 0;
  let handleOsc;
  const toasts = [];
  const context = vm.createContext({
    Buffer,
    navigator: { clipboard: { writeText: async (text) => {
      writes++;
      if (reject) throw new Error('Clipboard access denied');
      clipboard = text;
    } } },
    toast: (...args) => toasts.push(args),
    term: {
      loadAddon: (addon) => addon.activate(context.term),
      parser: { registerOscHandler: (code, handler) => {
        assert.equal(code, 52);
        handleOsc = handler;
        return { dispose() {} };
      } },
    },
  });
  context.self = context;
  vm.runInContext(addon, context);
  vm.runInContext(`${attachClipboard}\nattachClipboard(term);`, context);
  return {
    copy: (text) => handleOsc(`;${Buffer.from(text).toString('base64')}`),
    read: () => clipboard,
    writes: () => writes,
    toasts,
  };
}

test('an empty tmux selection preserves the clipboard for pasting', async () => {
  const clipboard = terminalClipboard();
  await clipboard.copy('');
  assert.equal(clipboard.read(), 'text waiting to be pasted');
  assert.equal(clipboard.writes(), 0);
  assert.deepEqual(clipboard.toasts, []);
});

test('nonempty terminal selections still copy and confirm success', async () => {
  const clipboard = terminalClipboard();
  await clipboard.copy('selected terminal text');
  assert.equal(clipboard.read(), 'selected terminal text');
  assert.equal(clipboard.toasts.length, 1);
});

test('whitespace selections are copied verbatim without a toast', async () => {
  const clipboard = terminalClipboard();
  await clipboard.copy(' \t\n');
  assert.equal(clipboard.read(), ' \t\n');
  assert.deepEqual(clipboard.toasts, []);
});

test('denied clipboard writes do not report a successful copy or reject', async () => {
  const clipboard = terminalClipboard({ reject: true });
  await clipboard.copy('selected terminal text');
  assert.equal(clipboard.read(), 'text waiting to be pasted');
  assert.deepEqual(clipboard.toasts, []);
});
