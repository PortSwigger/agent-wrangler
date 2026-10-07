import test from 'node:test';
import assert from 'node:assert/strict';
import { startupStyle, bannerLines, listenErrorMessage } from './startup-output.js';

const styles = [
  { isTTY: true, supervised: false, want: 'banner' },
  { isTTY: true, supervised: true, want: 'line' },
  { isTTY: false, supervised: false, want: 'line' },
  { isTTY: undefined, supervised: false, want: 'line' },
  { isTTY: false, supervised: true, want: 'line' },
];

for (const { isTTY, supervised, want } of styles) {
  test(`startupStyle: isTTY=${isTTY} supervised=${supervised} → ${want}`, () => {
    assert.equal(startupStyle({ isTTY, supervised }), want);
  });
}

test('bannerLines carries the version, URL, data dir and how to stop', () => {
  const text = bannerLines({ version: '1.2.3', url: 'http://localhost:7878', dataDir: '/tmp/aw' }).join('\n');
  assert.match(text, /Agent Wrangler 1\.2\.3/);
  assert.match(text, /http:\/\/localhost:7878/);
  assert.match(text, /\/tmp\/aw/);
  assert.match(text, /Ctrl-C to stop/);
});

const listenErrors = [
  { name: 'port in use', err: Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }), match: /port 7878 is already in use — pass --port/ },
  { name: 'privileged port', err: Object.assign(new Error('listen EACCES'), { code: 'EACCES' }), match: /not allowed to listen on port 7878 — pass --port/ },
  { name: 'anything else', err: Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' }), match: /could not listen on port 7878: getaddrinfo ENOTFOUND nope/ },
];

for (const { name, err, match } of listenErrors) {
  test(`listenErrorMessage: ${name}`, () => {
    assert.match(listenErrorMessage(err, 7878), match);
  });
}
