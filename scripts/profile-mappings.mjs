import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const script = fileURLToPath(import.meta.url);
const worker = process.argv[2] === '--worker';
const size = Number(process.argv[worker ? 3 : 2] || 4932);
assert.ok(Number(process.versions.node.split('.')[0]) >= 26, 'Node >=26 required');
assert.ok(Number.isSafeInteger(size) && size >= 12 && size <= 100000, 'size must be 12..100000');

if (!worker) {
  const output = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'aw-profile-output-')));
  fs.mkdirSync(output, { recursive: true });
  console.log(`Node ${process.version}; ${size} synthetic mappings; output: ${output}`);
  const results = [];
  for (let repeat = 1; repeat <= 2; repeat++) {
    for (const workload of ['paced', 'burst', 'history']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-profile-fixture-'));
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const name = `${repeat}-${workload}`;
      const result = spawnSync(process.execPath, [
        '--cpu-prof', `--cpu-prof-dir=${output}`, `--cpu-prof-name=${name}.cpuprofile`,
        script, '--worker', String(size), workload,
      ], {
        encoding: 'utf8', timeout: 60000,
        env: {
          PATH: process.env.PATH, TMPDIR: os.tmpdir(), HOME: home,
          AW_DATA_DIR: root, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          CODEX_HOME: path.join(home, '.codex'), GEMINI_CLI_HOME: path.join(home, '.gemini'),
          AW_TMUX_SOCKET: path.basename(root), AW_LEGACY_TMUX_SOCKET: path.basename(root),
        },
      });
      fs.writeFileSync(path.join(output, `${name}.log`), result.stdout + result.stderr);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const row = { repeat, ...JSON.parse(result.stdout) };
      results.push(row);
      console.log(JSON.stringify(row));
      fs.rmSync(root, { recursive: true });
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
} else {
  const root = process.env.AW_DATA_DIR;
  assert.ok(root && path.dirname(root) === os.tmpdir().replace(/\/$/, '') && path.basename(root).startsWith('aw-profile-fixture-'));
  assert.equal(process.env.HOME, path.join(root, 'home'));
  const workload = process.argv[4];
  assert.ok(['paced', 'burst', 'history'].includes(workload));
  const { SessionManager } = await import('../server/session-manager.js');
  const { sessionLabel } = await import('../server/state-reader.js');
  const { acquireInstanceLock, InstanceLockError } = await import('../server/instance-lock.js');
  const lock = await acquireInstanceLock({ maxWaitMs: 0 });
  await assert.rejects(() => acquireInstanceLock({ maxWaitMs: 0 }), InstanceLockError);
  try {
    const sm = new SessionManager();
    for (let i = 0; i < size; i++) {
      sm.map.set(`fixture-${i}`, {
        short: String(i).padStart(8, '0'), tmux: null, agent: 'claude', cwd: root,
        name: `Widget ${i}`, intent: 'Investigate generic widget behavior. '.repeat(128),
        createdAt: 1800000000000 - i,
        links: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/1', checkStatus: 'passing', dirty: false }],
        ...(i >= 12 ? { archivedAt: 1800000000000 - (i * 7919) % size, lastLabel: `Widget ${i}` } : {}),
      });
    }
    sm._save();
    const file = path.join(root, 'mappings.json');
    const fixtureBytes = fs.statSync(file).size;
    const projectHistory = () => sm.archivedEntries().map(e => sessionLabel({
      agent: e.agent, names: [e.name, e.lastLabel], intent: e.intent, cwd: e.cwd,
      fallback: e.sessionId.slice(0, 8),
    }));
    for (let i = 0; i < 5; i++) projectHistory();
    let saves = 0, saveMs = 0, historyMs = 0, histories = 0, bytes = 0;
    const save = sm._save.bind(sm);
    sm._save = () => {
      const start = performance.now();
      save();
      saveMs += performance.now() - start;
      saves++;
      bytes += fs.statSync(file).size;
    };
    const start = performance.now(), cpu = process.cpuUsage();
    const cycles = workload === 'history' ? 24 : 4;
    const period = workload === 'history' ? 250 : 1500;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const tick = performance.now();
      if (workload === 'history') {
        const labels = projectHistory();
        historyMs += performance.now() - tick;
        assert.equal(labels.length, size - 12);
        histories++;
      } else {
        for (let i = 0; i < (workload === 'paced' ? 1 : 12); i++) {
          sm.updateLinkStatus(`fixture-${i}`, 'https://github.com/acme/widgets/pull/1', 'passing', false, 1800000000000 + cycle);
          if (workload === 'burst' && i % 4 === 0) sm.rename(`fixture-${i}`, `Widget ${cycle}-${i}`);
          if (workload === 'burst' && i % 6 === 0) sm.setWorkflowPhase(`fixture-${i}`, { label: `Phase ${cycle}`, kind: 'working' });
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, period - (performance.now() - tick))));
    }
    const used = process.cpuUsage(cpu), elapsedMs = performance.now() - start;
    console.log(JSON.stringify({ workload, size, onBoard: 12, livePanes: 0, fixtureBytes,
      elapsedMs, cpuPercent: (used.user + used.system) / elapsedMs / 10,
      saves, savesPerSecond: saves * 1000 / elapsedMs, bytes, saveMs, histories, historyMs,
      duplicateWriterRefused: true }));
  } finally {
    lock.release();
  }
}
