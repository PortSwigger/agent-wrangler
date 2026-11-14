// The model footer for PRs an agent creates: after a `gh pr create`, the
// session's live model id is appended to the PR body as `Model: <id>`, so PRs
// can be searched by model (`gh search prs '"Model: claude-opus-5-5" in:body'`),
// followed by a `Made with Agent Wrangler` line.
// Shared by every agent's post-tool hook (scripts/pr-model-footer.mjs is the
// Claude one). Dependency-free beyond node builtins: the devcontainer runtime
// copies this file into the container beside the hook scripts.
import { spawn } from 'node:child_process';
import { sessionApiHeaders } from './pr-hook.js';

// A `Model:` line anywhere in the body, ours or one the agent wrote itself.
const MODEL_LINE = /^Model:[ \t]*\S/m;

export function hasModelLine(body) {
  return MODEL_LINE.test(String(body ?? ''));
}

export const ATTRIBUTION = 'Made with Agent Wrangler';

// A line starting with the attribution, ours or a longer variant an extension
// already wrote (e.g. "Made with Agent Wrangler and the acme/widgets extension").
const ATTRIBUTION_LINE = /^Made with Agent Wrangler\b/m;

export function hasAttributionLine(body) {
  return ATTRIBUTION_LINE.test(String(body ?? ''));
}

// The body with whichever footer lines it lacks appended (Model, then the
// attribution), or null when it needs none.
export function withModelFooter(body, model) {
  if (!model) return null;
  const lines = [];
  if (!hasModelLine(body)) lines.push(`Model: ${model}`);
  if (!hasAttributionLine(body)) lines.push(ATTRIBUTION);
  if (!lines.length) return null;
  const text = String(body ?? '').replace(/\s+$/, '');
  return [text, ...lines].filter(Boolean).join('\n\n');
}

// Asks the wrangler which model to tag this session's PRs with. Null when the
// footer setting is off, the session is unknown or the server is unreachable.
export async function fetchFooterModel({ url, headers, fetchImpl = fetch }) {
  if (!url || !headers) return null;
  const res = await fetchImpl(url, { method: 'POST', headers });
  if (!res.ok) return null;
  const model = (await res.json())?.model;
  return typeof model === 'string' && model ? model : null;
}

// `gh <args>` with optional stdin, resolving to its stdout; rejects on a
// non-zero exit.
export function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`gh exited ${code}`))));
    child.stdin.end(input ?? '');
  });
}

// Reads the PR body and appends the footer lines it lacks. Returns 'tagged', 'present' or 'skipped' (no model).
export async function tagPrWithModel({ prUrl, model, gh = runGh }) {
  if (!prUrl || !model) return 'skipped';
  const body = (await gh(['pr', 'view', prUrl, '--json', 'body', '--jq', '.body'])).replace(/\n$/, '');
  const next = withModelFooter(body, model);
  if (next == null) return 'present';
  await gh(['pr', 'edit', prUrl, '--body-file', '-'], next);
  return 'tagged';
}

// The whole footer step for a PR just created: model from the wrangler, then
// the body edit. Env carries the session token (AW_SESSION_TOKEN) and the
// lookup url (AW_PR_MODEL_URL), both set at launch.
export async function runModelFooter({ prUrl, env = process.env, fetchImpl = fetch, gh = runGh }) {
  const model = await fetchFooterModel({ url: env.AW_PR_MODEL_URL, headers: sessionApiHeaders(env), fetchImpl });
  return tagPrWithModel({ prUrl, model, gh });
}
