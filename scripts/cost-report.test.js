import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// cost-report.mjs is a one-shot CLI (no exports, runs its whole pipeline at import
// time and calls process.exit for --json), so it isn't unit-testable in-process the
// way usage-report.js is — it's exercised end-to-end instead, with HOME (both
// ~/.claude/projects and ~/.codex/sessions resolve off os.homedir()) and AW_DATA_DIR
// redirected to a throwaway fixture tree.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'cost-report.mjs');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function runReport(month, { dataDir, homeDir }) {
  const out = execFileSync('node', [SCRIPT, month, '--json'], {
    env: { ...process.env, AW_DATA_DIR: dataDir, HOME: homeDir },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('attributes Codex spend when createdAt is epoch ms, as mappings.json stores it', () => {
  const dataDir = tmp('aw-cr-data-');
  const homeDir = tmp('aw-cr-home-');
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  const sessionsDir = path.join(homeDir, '.codex', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const uuid = '77777777-7777-4777-8777-777777777777';
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-2026-07-11T10-00-00-${uuid}.jsonl`),
    [
      { timestamp: '2026-07-11T10:00:00.000Z', payload: { type: 'turn_context', model: 'gpt-5.5-codex' } },
      { timestamp: '2026-07-11T10:05:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 1000 } } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );

  fs.writeFileSync(path.join(dataDir, 'mappings.json'), JSON.stringify({
    sessions: {
      cx: { agent: 'codex', liveSessionId: uuid, cwd: '/work/proj', createdAt: Date.parse('2026-07-11T09:59:00.000Z') },
    },
  }));

  const report = runReport('2026-07', { dataDir, homeDir });

  assert.equal(report.totals.unresolved, 0, 'a numeric createdAt must not be treated as unresolved');
  assert.ok(report.totals.estimatedCostIncluded > 0, 'codex is the only estimated source — 0 means it was skipped');
  assert.equal(report.topSessions.length, 1);
  assert.equal(report.topSessions[0].estimated, true);
});

test('skips a Codex session with no usable createdAt without crashing', () => {
  const dataDir = tmp('aw-cr-data-');
  const homeDir = tmp('aw-cr-home-');
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'sessions'), { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'mappings.json'), JSON.stringify({
    sessions: {
      cx: { agent: 'codex', liveSessionId: '88888888-8888-4888-8888-888888888888', cwd: '/work/proj' },
    },
  }));

  const report = runReport('2026-07', { dataDir, homeDir });

  assert.equal(report.totals.unresolved, 0, 'skipped for lacking a bucketable month, not counted as unresolved');
  assert.equal(report.totals.estimatedCostIncluded, 0);
  assert.equal(report.topSessions.length, 0);
});
