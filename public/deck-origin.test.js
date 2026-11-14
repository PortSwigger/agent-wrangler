import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckOrigin } from './deck-origin.js';

const loc = (href) => new URL(href);
const doc = (port) => ({ querySelector: (sel) => (sel === 'meta[name="aw-deck-port"]' && port != null ? { getAttribute: () => String(port) } : null) });

test('a loopback board reaches the deck on its own port, cross-origin', () => {
  assert.deepEqual(deckOrigin(loc('http://localhost:7878/'), doc(7879)), { http: 'http://127.0.0.1:7879', ws: 'ws://127.0.0.1:7879' });
  assert.deepEqual(deckOrigin(loc('http://127.0.0.1:7878/#x'), doc(7900)), { http: 'http://127.0.0.1:7900', ws: 'ws://127.0.0.1:7900' });
});

test('a board opened from another host, or with no deck port named, goes through its own origin', () => {
  assert.deepEqual(deckOrigin(loc('http://192.168.1.4:7878/'), doc(7879)), { http: 'http://192.168.1.4:7878', ws: 'ws://192.168.1.4:7878' });
  assert.deepEqual(deckOrigin(loc('https://board.example/'), doc(null)), { http: 'https://board.example', ws: 'wss://board.example' });
});
