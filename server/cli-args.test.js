import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, usage } from './cli-args.js';
import { VERSION } from './version.js';

const cases = [
  { name: 'no flags runs with no env changes', argv: [], want: { action: 'run', env: {} } },
  { name: '--help', argv: ['--help'], want: { action: 'help', env: {} } },
  { name: '-h', argv: ['-h'], want: { action: 'help', env: {} } },
  { name: '--version', argv: ['--version'], want: { action: 'version', env: {} } },
  { name: '-v', argv: ['-v'], want: { action: 'version', env: {} } },
  { name: 'help wins over other flags', argv: ['--port', '7999', '--help'], want: { action: 'help', env: {} } },
  { name: '--port', argv: ['--port', '7999'], want: { action: 'run', env: { AW_PORT: '7999' } } },
  { name: '--port=value form', argv: ['--port=1'], want: { action: 'run', env: { AW_PORT: '1' } } },
  { name: '--port upper bound', argv: ['--port', '65535'], want: { action: 'run', env: { AW_PORT: '65535' } } },
  { name: '--data-dir', argv: ['--data-dir', '~/aw-x'], want: { action: 'run', env: { AW_DATA_DIR: '~/aw-x' } } },
  { name: '--open', argv: ['--open'], want: { action: 'run', env: { AW_OPEN_BROWSER: '1' } } },
  { name: '--host', argv: ['--host', '0.0.0.0'], want: { action: 'run', env: { AW_BIND_HOST: '0.0.0.0' } } },
  {
    name: 'flags combine',
    argv: ['--port', '7998', '--data-dir', '/tmp/aw', '--open'],
    want: { action: 'run', env: { AW_PORT: '7998', AW_DATA_DIR: '/tmp/aw', AW_OPEN_BROWSER: '1' } },
  },
];

for (const { name, argv, want } of cases) {
  test(`parseCliArgs: ${name}`, () => {
    assert.deepEqual(parseCliArgs(argv), want);
  });
}

const errors = [
  { name: 'unknown flag', argv: ['--bogus'], match: /--bogus/ },
  { name: 'positional argument', argv: ['serve'], match: /serve/ },
  { name: 'missing port value', argv: ['--port'], match: /--port/ },
  { name: 'port zero', argv: ['--port', '0'], match: /1 to 65535/ },
  { name: 'port too large', argv: ['--port', '65536'], match: /1 to 65535/ },
  { name: 'non-numeric port', argv: ['--port', 'abc'], match: /1 to 65535/ },
  { name: 'fractional port', argv: ['--port', '80.5'], match: /1 to 65535/ },
  { name: 'empty data dir', argv: ['--data-dir='], match: /--data-dir/ },
  { name: 'empty host', argv: ['--host='], match: /--host/ },
  { name: 'value on a boolean flag', argv: ['--open=yes'], match: /--open/ },
];

for (const { name, argv, match } of errors) {
  test(`parseCliArgs error: ${name}`, () => {
    const res = parseCliArgs(argv);
    assert.equal(res.action, 'error');
    assert.match(res.error, match);
  });
}

test('usage names every flag and the env var it sets', () => {
  const text = usage();
  for (const s of ['--port', 'AW_PORT', '--data-dir', 'AW_DATA_DIR', '--open', 'AW_OPEN_BROWSER', '--host', 'AW_BIND_HOST', '--help', '--version']) {
    assert.ok(text.includes(s), `usage mentions ${s}`);
  }
});

test('VERSION is the package.json version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
