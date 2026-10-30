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
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const questions = [
    'Enable Settings → Manage agy integration. Confirm the plugin exists and Antigravity is offered for dispatch.',
    'Keep the existing dev server on this reported PR head. Dispatch in ~/aw-agy-probe/wt, Gemini 3.8 Flash Medium. Intent: Use native Wrangler tools to name this card agy startup check and read_mail, then say ready. Verify one startup get_session_info read before one task turn, auto in the footer, native rename_session/read_mail, and zero config searches or shell repair approvals. A ready sentence alone does not pass.',
    'Exercise delayed sign-in and loading plugin tools. Before native get_session_info succeeds the task and mail must stay held. If loading was skipped, inspect /mcp and use only controls actually offered there. No assumed /mcp reload command. Record whether that recovers this launch; if it does not, report the failure on this same PR.',
    'Inspect the native PreToolUse details locally: toolCall.name must be call_mcp_tool, args.ServerName agent-wrangler_agent-wrangler, and args.ToolName the exact registered tool. Confirm read_mail and one installed extension tool have no approval prompt. A different server or a shell command mentioning Wrangler must keep normal approval. Save only those sanitised fields, never raw payloads.',
    'Inspect the installed stdio process ancestry locally: its parent must be this pane agy process or that process\'s native language-server child. A shell-created bridge, old pane, hook event, tools/list or unrelated MCP traffic must not release task/mail. Report unexpected ancestry; do not weaken the gate.',
    'Using only visible native /mcp manager controls, disconnect and reconnect the Wrangler server. Mail must remain held until another native get_session_info succeeds, then notify once without repeating earlier task or tool writes. Record the exact available recovery control; if none exists, report that native gap.',
    'Suspend/resume with wake text, then Fork with a distinct child prompt. Verify fresh native readiness on each, one wake/child turn, saved model/Medium/auto/grants, distinct child identity and unchanged parent. Type a terminal draft and trigger a permission screen: no automated text or Enter may alter either. Inspect uncertain submissions before manually retrying.',
    'Verify cwd, workspace writes, git in the linked worktree, network and localhost via the normal reviewer. Stop if auto is unavailable for this account; never enable broader shell permissions to repair startup.',
    'Confirm all six root hooks bind the pane PID; native children and nested agy -p do not replace the root. Two simultaneous cards must keep distinct conversations.',
    'Check instructions and skill catalog after resume and compaction. Check wake text after MCP readiness. Fork, advance and rewind the parent, and verify the child retains the exact saved prefix.',
    'With the plugin installed, start plain agy without AW_SESSION_ID. Confirm zero Wrangler tools, injected instructions, status callbacks and approval effects.',
    'Leave the human-managed dev server running. Outage, stale-install and no-identity effects are covered by isolated automated tests; record any native isolation behavior that remains unverified without changing that server\'s lifecycle.',
    'Disable Manage agy integration. Confirm the owned plugin is removed and dispatch excludes agy. Restore your original setting without stopping the dev server.',
    'Confirm native plugin refresh only on version changes. Do not publish raw payloads, account identifiers or emails.',
  ];
  console.log('Human-only native acceptance. Workers must use --dry-run. No automatic install, settings or service changes.');
  console.log('Tested head: ' + head);
  console.log('Worktree: ' + worktree.replaceAll(os.homedir(), '~'));
  console.log('Build → human trials → manual merge approval. Failed trials return to this same open PR.');
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
      fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), head, worktree: clean(worktree), validation, checks }, null, 2), { mode: 0o600 });
      console.log('Sanitised result: ' + clean(output));
      if (checks.some((c) => !c.passed)) process.exitCode = 1;
    } catch (err) { console.error(err.message); process.exitCode = 1; }
    finally { rl.close(); }
  }
}
