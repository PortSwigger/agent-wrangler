import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const base = JSON.parse(readFileSync(new URL('../.claude/skills/evaluate-model/inputs-2026-10-29.json', import.meta.url)));
function compare(fresh) {
  const dir = mkdtempSync(join(tmpdir(), 'front-refresh-'));
  try {
    const files = Object.fromEntries(['BASE_INPUTS', 'FRESH_INPUTS', 'DIFF_REPORT', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'].map((k) => [k, join(dir, k)]));
    writeFileSync(files.BASE_INPUTS, JSON.stringify(base));
    writeFileSync(files.FRESH_INPUTS, JSON.stringify(fresh));
    writeFileSync(files.GITHUB_OUTPUT, '');
    const result = spawnSync('bash', ['scripts/check-front-refresh.sh'], { env: { ...process.env, ...files }, encoding: 'utf8' });
    return { exit: result.status, out: result.stdout + result.stderr, output: readFileSync(files.GITHUB_OUTPUT, 'utf8'), summary: readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('refresh no change: exit 0 and no PR requested', () => {
  const result = compare({ ...base, read: '2026-11-02' });
  assert.equal(result.exit, 0);
  assert.equal(result.output, 'changed=false\n');
  assert.match(result.out, /up to date/);
});
test('refresh changed data: exit 0 and generation/PR requested with diff in summary', () => {
  const fresh = structuredClone(base); fresh.models.claude.opus.price.output += 1;
  const result = compare(fresh);
  assert.equal(result.exit, 0);
  assert.equal(result.output, 'changed=true\n');
  assert.match(result.summary, /CHANGED.*claude opus price/);
});
test('refresh benchmark version change: exit 2, no PR, manual scale reading required', () => {
  const fresh = structuredClone(base); fresh.benchmarks['terminal-bench'].version = '4.1';
  const result = compare(fresh);
  assert.equal(result.exit, 2);
  assert.equal(result.output, '');
  assert.match(result.summary, /version bumped/);
  assert.match(result.out, /manually read every vendor sweep/);
});
test('refresh malformed source data: exit 3, no PR', () => {
  const fresh = structuredClone(base); delete fresh.models.claude.opus.price;
  const result = compare(fresh);
  assert.equal(result.exit, 3);
  assert.equal(result.output, '');
  assert.match(result.out, /price needs/);
});
