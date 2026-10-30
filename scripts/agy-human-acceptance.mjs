import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
const args = process.argv.slice(2);
if (args[0] !== 'plugin') {
  console.error('Usage: bash scripts/agy-human-acceptance.sh plugin [--dry-run]');
  process.exitCode = 1;
} else {
  const plugin = path.join(os.homedir(), '.gemini/config/plugins/agent-wrangler');
  const questions = [
    'Enable Settings → Manage agy integration. Confirm the plugin exists and Antigravity is offered for dispatch.',
    'Dispatch in ~/aw-agy-probe/wt. Verify auto in the footer; cwd, workspace writes, git in the linked worktree, network and localhost work via the normal reviewer. Stop if auto is unavailable for this account.',
    'Confirm read_mail and an installed extension tool work. Inspect the native PreToolUse toolCall.name locally: only mcp__agent-wrangler__<registered tool> is approved. Other names must retain normal prompts. Do not add a wildcard rule.',
    'Confirm all six root hooks bind the pane PID; native children and nested agy -p do not replace the root. Two simultaneous cards must keep distinct conversations.',
    'Check instructions and skill catalog after resume and compaction. Check wake text after MCP readiness. Fork, advance and rewind the parent, and verify the child retains the exact saved prefix.',
    'With the plugin installed, start plain agy without AW_SESSION_ID. Confirm zero Wrangler tools, injected instructions, status callbacks and approval effects.',
    'Record your installation-specific stop/start commands. Stop Wrangler using its supervisor (for a foreground install, stop that process); repeat plain-agy isolation. Restart with the same installation and data directory, and repeat with the stale plugin after a temporary unavailable install path. Restore the path.',
    'Disable Manage agy integration. Confirm the owned plugin is removed and dispatch excludes agy. Restart while disabled and confirm ~/.gemini is unchanged. Restore your original setting and service state.',
    'Confirm native plugin refresh only on version changes. Do not publish raw payloads, account identifiers or emails.',
  ];
  console.log('Human-only native acceptance. Workers must use --dry-run. No automatic install, settings or service changes.');
  console.log('Native validation command: agy plugin validate ' + JSON.stringify(plugin));
  questions.forEach((text, i) => console.log(`${i + 1}. ${text}`));
  if (!args.includes('--dry-run')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const clean = (text) => text.replaceAll(os.homedir(), '~').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]');
    try {
      if ((await rl.question('Run native agy plugin validation now? Type validate: ')) !== 'validate') throw new Error('Native validation not authorized.');
      let validation;
      try { validation = clean(execFileSync('agy', ['plugin', 'validate', plugin], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })); }
      catch { throw new Error('Native plugin validation failed. Inspect locally; no raw provider output was saved.'); }
      const checks = [];
      for (const text of questions) checks.push({ text, passed: (await rl.question(`${text}\nType pass or fail: `)) === 'pass' });
      const output = path.resolve(args.find((a) => a.startsWith('--output='))?.slice(9) || path.join(os.tmpdir(), 'agy-human-acceptance.json'));
      fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), validation, checks }, null, 2), { mode: 0o600 });
      console.log('Sanitised result: ' + clean(output));
      if (checks.some((c) => !c.passed)) process.exitCode = 1;
    } catch (err) { console.error(err.message); process.exitCode = 1; }
    finally { rl.close(); }
  }
}
