import os from 'node:os';
import crypto from 'node:crypto';
import { execFile as defaultExecFile } from 'node:child_process';
import { cleanClaudeEnv } from './agents/claude.js';

// A tool-less, one-shot `claude -p` for the wrangler's own small classification
// jobs (archive-time memory review, PR comment triage). Returns
// { text, liveSessionId, error }. `liveSessionId` is a fresh uuid rather than
// `--no-session-persistence` so the caller can push it onto a card's
// `priorLiveSessionIds` and the existing cost scanners bill the spend for free
// (and the transcript survives for debugging what the model actually saw).
// `--bare` is NOT an option here: verified against the real binary, it reads
// only ANTHROPIC_API_KEY and fails with api_error under OAuth/keychain auth.
// `execFile` (not shell) with the payload on stdin — no argv limit, no quoting.
export const HEADLESS_DISALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch',
  'WebSearch', 'Task', 'Agent', 'TodoWrite', 'BashOutput', 'KillShell', 'Skill',
  'SlashCommand',
];

export function runHeadlessClaude(prompt, stdin, {
  model = 'haiku',
  execFile = defaultExecFile,
  timeoutMs = 120000,
} = {}) {
  const liveSessionId = crypto.randomUUID();
  const args = [
    '-p', '--model', model,
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disallowed-tools', HEADLESS_DISALLOWED_TOOLS.join(' '),
    '--session-id', liveSessionId,
    '--output-format', 'json',
    prompt,
  ];
  return new Promise((resolve) => {
    const child = execFile('claude', args, {
      cwd: os.tmpdir(),
      env: cleanClaudeEnv(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) { resolve({ text: null, liveSessionId, error: err }); return; }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (e) { resolve({ text: null, liveSessionId, error: e }); return; }
      resolve({ text: typeof parsed.result === 'string' ? parsed.result.trim() : null, liveSessionId, error: null });
    });
    child.stdin.end(stdin);
  });
}
