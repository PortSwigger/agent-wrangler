// Pure parsing for the PostToolUse PR-attach hook (scripts/pr-attach-hook.mjs is
// the thin I/O wrapper). No I/O here so it's unit-testable. Given the raw JSON a
// Claude Code PostToolUse hook delivers on stdin, return the url of a PR the
// agent just CREATED, or null.
//
// Gate on `gh pr create` in the Bash command so a `gh pr view`/`gh pr list` that
// merely prints urls doesn't auto-attach. The created PR's url is then pulled
// from anywhere in the payload: we scan the RAW text rather than a specific
// output field because the field name has drifted across CC versions
// (tool_output vs tool_response.stdout) — scanning is robust to both. The
// /pull/<n> shape naturally excludes `git push`'s /compare/ "create a PR" hint.
const GITHUB_PR_URL = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

// When we have the clean parsed command, require `gh pr create` to be an actual
// invocation — the start of the command, or of a &&/||/;/|/newline-chained
// segment (a multi-line Bash call, e.g. `cd repo\ngh pr create`, runs each line
// sequentially exactly like `;`) — not merely a substring anywhere in it. A
// plain substring check false-positived on a
// Bash call that just SEARCHED for that text (e.g. `grep "gh pr create|..." file`):
// the pattern alone satisfied the gate, and the grep's own matched OUTPUT — an
// unrelated PR url from whatever the search happened to surface — then got
// attached as if just created.
const GH_PR_CREATE_INVOKED = /(?:^|&&|\|\||[;|\n])\s*gh\s+pr\s+create\b/;

export function extractCreatedPrUrl(stdinText) {
  const text = typeof stdinText === 'string' ? stdinText : '';
  if (!text) return null;

  // Prefer the structured command field; fall back to a raw-text gate when the
  // payload isn't parseable JSON (defensive — a hook should never throw). The
  // fallback has no clean command boundary to anchor on, so it stays a loose
  // substring check — a known, accepted imprecision for that degraded case only.
  let command = null;
  try {
    command = JSON.parse(text)?.tool_input?.command ?? null;
  } catch {
    command = null;
  }
  const gated = typeof command === 'string'
    ? GH_PR_CREATE_INVOKED.test(command)
    : text.includes('gh pr create');
  if (!gated) return null;

  const m = GITHUB_PR_URL.exec(text);
  return m ? m[0] : null;
}
