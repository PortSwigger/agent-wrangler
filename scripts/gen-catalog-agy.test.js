import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('scheduled gen:catalog refreshes Gemini and retains last-good rows without invoking agy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gen-catalog-'));
  try {
    const fixture = path.join(dir, 'feed.json');
    const output = path.join(dir, 'output'); fs.mkdirSync(output);
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\necho invoked > "$HOME/agy-invoked"\nexit 97\n', { mode: 0o755 });
    const raw = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['gpt-fixture-' + i, { mode: 'chat', litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }]));
    raw['gemini/gemini-3.8-flash'] = { mode: 'chat', litellm_provider: 'gemini', input_cost_per_token: 3e-6, output_cost_per_token: 4e-6, cache_read_input_token_cost: 0.3e-6 };
    const prior = { anthropic: {}, openai: {}, gemini: { 'gemini-retired': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 } } };
    fs.writeFileSync(path.join(output, 'price-catalog.snapshot.json'), JSON.stringify(prior));
    const run = () => execFileSync('npm', ['run', 'gen:catalog', '--', '--litellm', fixture, '--output-dir', output], { env: { ...process.env, HOME: dir, PATH: bin + ':' + process.env.PATH, npm_config_cache: path.join(dir, 'npm') }, encoding: 'utf8' });
    fs.writeFileSync(fixture, JSON.stringify(raw));
    assert.match(run(), /12 openai, 2 gemini/);
    const next = JSON.parse(fs.readFileSync(path.join(output, 'price-catalog.snapshot.json'), 'utf8'));
    assert.equal(next.gemini['gemini-3.8-flash'].input, 3);
    assert.deepEqual(next.gemini['gemini-retired'], prior.gemini['gemini-retired']);
    raw['gemini/gemini-3.8-flash'].input_cost_per_token = 'malformed';
    fs.writeFileSync(fixture, JSON.stringify(raw)); run();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'price-catalog.snapshot.json'), 'utf8')).gemini, next.gemini);
    assert.equal(fs.existsSync(path.join(dir, 'agy-invoked')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
