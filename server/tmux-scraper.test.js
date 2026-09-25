import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmuxesForSession, claudeTitle, hasBackgroundShell, prefillPane, sendText, classify, findAgentPid, parsePaneLine, paneModelLabel, paneContextPercent, trustDialogState } from './tmux-scraper.js';

const ID = '53fa5416-3437-4126-897c-e1c0b3daa2ac';

test('classify: the real OAuth login screens read as needs-you (never idle → never reaped)', () => {
  const methodPick = 'Welcome to Claude Code\n\nSelect login method:\n\n 1. Claude account with subscription · Pro, Max, Team, or Enterprise\n 2. Anthropic Console account · API usage billing';
  const oauthUrl = "Browser didn't open? Use the url below to sign in (c to copy)\n\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc\n\n Paste code here if prompted >";
  assert.equal(classify(methodPick).status, 'needs-you');
  assert.equal(classify(oauthUrl).status, 'needs-you');
});
test('classify: unchanged for working/idle', () => {
  assert.equal(classify('… esc to interrupt …').status, 'working');
  assert.equal(classify('a quiet prompt').status, 'idle');
});

test('classify: Claude Code\'s own workspace-trust dialog reads as needs-you across every A/B copy variant', () => {
  // Verbatim (title/body/CTA) from the installed binary's four live copy
  // variants for this one dialog — only the title and yes-button wording
  // differ between them, so the check can't anchor on either.
  const control = 'Do you trust the files in this folder?\n\n/repo/dir\n\n  Learn more\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel';
  const normalizeAction = "Accessing workspace:\n\n/repo/dir\n\nQuick safety check: is this a project you created or one you trust?\n\n  Security guide\n\n❯ 1. Yes, I trust this folder\n  2. No, exit\n\nEnter to confirm · Esc to cancel";
  const positiveAttitude = 'Ready to code here?\n\n/repo/dir\n\nI\'ll need permission to work with your files.\n\n❯ 1. Yes, continue\n  2. No, exit\n\nEnter to confirm · Esc to cancel';
  const explicit = 'Do you want to work in this folder?\n\n/repo/dir\n\nIn order to work in this folder, we need your permission.\n\n❯ 1. Yes, continue\n  2. No, exit\n\nEnter to confirm · Esc to cancel';
  for (const pane of [control, normalizeAction, positiveAttitude, explicit]) {
    const c = classify(pane);
    assert.equal(c.status, 'needs-you');
    // Generic on purpose: the same menu shape also covers the Bypass
    // Permissions and org-managed-settings dialogs below, and a
    // trust-specific label would misdescribe those. No waitingReason either
    // — this must stay a plain needs-you (bar word 'reply'/"waiting for
    // you"), never a distinct word like 'error' or 'retry'.
    assert.match(c.waitingFor, /terminal/i);
    assert.equal(c.waitingReason, undefined);
  }
});
test('classify: the same menu shape also covers Bypass Permissions mode and org-managed-settings dialogs', () => {
  // Verbatim CTA wording from the installed binary — a different dialog,
  // same numbered Yes/No-exit-plus-footer shape the check anchors on.
  const bypassPermissions = 'Bypass Permissions mode\n\nThis mode should only be used in a sandboxed container/VM.\n\n❯ 1. No, exit\n  2. Yes, I accept\n\nEnter to confirm · Esc to cancel';
  const orgSettings = "Managed settings\n\nOnly accept if you trust your organization's IT administration.\n\n❯ 1. Yes, I trust these settings\n  2. No, exit Claude Code\n\nEnter to confirm · Esc to cancel";
  assert.equal(classify(bypassPermissions).status, 'needs-you');
  assert.equal(classify(orgSettings).status, 'needs-you');
});
test('classify: ordinary conversation mentioning "no" or confirmation prompts does not false-positive on the trust dialog', () => {
  assert.equal(classify('No, that file does not exist yet — let me check again.').status, 'idle');
  assert.equal(classify('Press enter to confirm the commit message looks right.').status, 'idle');
  // Both anchor phrases present, but neither option is an actual numbered
  // menu line — exactly the shape this file's own diff/tests can end up
  // showing in someone's pane (e.g. `cat`-ing this test file, or a failed
  // assertion dump), and the same class of false positive the Codex banner
  // check above already guards against with its own `^`-anchoring.
  assert.equal(
    classify('The options are `Yes, proceed` / `No, exit` — the footer says "press Enter to confirm".').status,
    'idle',
  );
});

test('classify: devcontainer bring-up reads as working (not idle → not reaped) with a hint', () => {
  const pane = 'Resolving Feature dependencies...\nRunning the postCreateCommand from devcontainer.json...\nnpm install';
  const c = classify(pane);
  assert.equal(c.status, 'working');
  assert.equal(c.waitingFor, 'starting container');
});
test('classify: a fatal devcontainer bring-up failure reads as needs-you with a reason', () => {
  const c = classify('error: Failed to build container\ndevcontainer up failed');
  assert.equal(c.status, 'needs-you');
  assert.match(c.waitingFor, /bring-up failed/);
});
test('classify: the real devcontainer-CLI failure line (Group-E capture) reads as needs-you', () => {
  // Verbatim from a live broken-image `devcontainer up` capture (Plan-3 Group E): the CLI
  // prints its canonical failure line before the process exits, so an alive scrape catches it.
  const c = classify('[8431 ms] Command failed: docker pull mcr.microsoft.com/devcontainers/nope:999\n{"outcome":"error","message":"...","description":"An error occurred setting up the container."}');
  assert.equal(c.status, 'needs-you');
  assert.match(c.waitingFor, /bring-up failed/);
});
test('classify: Codex\'s own update-available banner reads as needs-you with a reason', () => {
  // Verbatim (a live, non-destructive capture: `~/.codex/version.json`'s
  // latest_version faked to force the banner, pane captured, tmux session
  // killed WITHOUT ever pressing a key — the real "Update now" default was
  // never triggered). Option 1 is the default on a bare Enter, which is
  // exactly the footgun this branch exists to prevent.
  const pane = '› Ask Codex to do anything\n\n  ? for shortcuts\n\n  ✨ Update available! 0.154.0 -> 9.9.9\n\n  Release notes: https://github.com/openai/codex/releases/latest\n\n› 1. Update now (runs `brew upgrade --cask codex`)\n  2. Skip\n  3. Skip until next version\n\n  Press enter to continue';
  const c = classify(pane);
  assert.equal(c.status, 'needs-you');
  assert.match(c.waitingFor, /update available/i);
});
// Simulates tmux's ordinary word-wrap (`capture-pane -p`, no `-J`): break at
// word boundaries where they fit, hard-break a single token wider than the
// column. Proves the detection survives narrow panes, where enough of the
// banner's earlier content (the release-notes URL especially) can wrap into
// extra lines to push a leading anchor out of classify()'s 12-line window.
function wordWrap(line, width) {
  if (line.length <= width) return [line];
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) { cur = w; continue; }
    if (`${cur} ${w}`.length <= width) cur += ` ${w}`;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.flatMap((l) => {
    if (l.length <= width) return [l];
    const pieces = [];
    for (let i = 0; i < l.length; i += width) pieces.push(l.slice(i, i + width));
    return pieces;
  });
}
const REAL_BANNER_LINES = [
  '› Ask Codex to do anything', '', '  ? for shortcuts', '',
  '  ✨ Update available! 0.154.0 -> 9.9.9', '',
  '  Release notes: https://github.com/openai/codex/releases/latest', '',
  '› 1. Update now (runs `brew upgrade --cask codex`)',
  '  2. Skip', '  3. Skip until next version', '',
  '  Press enter to continue',
];
test('classify: the real banner reads as needs-you at every realistic (and several unrealistic) pane widths', () => {
  // 40 down to 12 columns — well past anything this product would actually
  // render a terminal at, which is the point: the fix must not depend on
  // guessing a "safe enough" minimum width at all.
  for (const width of [40, 30, 24, 20, 16, 12]) {
    const wrapped = REAL_BANNER_LINES.flatMap((l) => (l === '' ? [''] : wordWrap(l, width)));
    const c = classify(wrapped.join('\n'));
    assert.equal(c.status, 'needs-you', `width ${width} should still read as needs-you`);
  }
});
test('classify: ordinary conversation text mentioning an update does not false-positive', () => {
  assert.equal(classify('I ran the update and it looks like everything is now available!').status, 'idle');
  assert.equal(classify('Skipping this file until the next version of the schema lands').status, 'idle');
  // Both anchor phrases present in one ordinary sentence, no menu structure.
  assert.equal(classify('Update available! You can skip until next version').status, 'idle');
  assert.equal(classify('Update available!\nRemember you can always skip until next version if you want').status, 'idle');
  // All four phrases present in order, but never as actual numbered options
  // at the start of their own lines.
  assert.equal(
    classify('Update available! Choose an option:\n1. Update now\nOtherwise you can skip until next version.\nPress Enter to continue.').status,
    'idle',
  );
});
test('classify: unchanged for working/idle/login', () => {
  assert.equal(classify('… esc to interrupt …').status, 'working');
  assert.equal(classify('a quiet prompt').status, 'idle');
  assert.equal(classify('Select login method: 1. Claude account').status, 'needs-you');
});

test('matches the original session tmux launched with --session-id', () => {
  const discovered = [
    { tmuxName: 'cc_c7980336', command: `claude --session-id ${ID} --permission-mode auto do a thing` },
  ];
  assert.deepEqual(tmuxesForSession(discovered, ID), ['cc_c7980336']);
});

test('matches a resume fork tmux launched with --resume <owner> --fork-session', () => {
  const discovered = [
    { tmuxName: 'cc_a1622873', command: `claude --resume ${ID} --fork-session --permission-mode auto` },
  ];
  assert.deepEqual(tmuxesForSession(discovered, ID), ['cc_a1622873']);
});

test('returns BOTH the original and its fork when both are still alive (the leak case)', () => {
  const discovered = [
    { tmuxName: 'cc_c7980336', command: `claude --session-id ${ID} --permission-mode auto` },
    { tmuxName: 'cc_a1622873', command: `claude --resume ${ID} --fork-session --permission-mode auto` },
  ];
  assert.deepEqual(tmuxesForSession(discovered, ID).sort(), ['cc_a1622873', 'cc_c7980336']);
});

test('excludes a deliberate fork tmux that another board id owns (archiving the parent must not kill the fork)', () => {
  // A deliberate fork runs `claude --resume <parent> --fork-session` — its command
  // is indistinguishable from a resume-fork of the parent. The discriminator is that
  // the fork's tmux is the recorded tmux of a *different* board id, so it must survive.
  const discovered = [
    { tmuxName: 'cc_parent', command: `claude --session-id ${ID} --permission-mode auto` },
    { tmuxName: 'cc_fork', command: `claude --resume ${ID} --fork-session --permission-mode auto` },
  ];
  assert.deepEqual(
    tmuxesForSession(discovered, ID, { claimedByOthers: new Set(['cc_fork']) }),
    ['cc_parent'],
  );
});

test('still reaps a drifted resume-fork tmux of the same session even with exclusions', () => {
  // The drifted resume tmux belongs to NO other board id, so it stays a kill target.
  const discovered = [
    { tmuxName: 'cc_c7980336', command: `claude --session-id ${ID} --permission-mode auto` },
    { tmuxName: 'cc_a1622873', command: `claude --resume ${ID} --fork-session --permission-mode auto` },
  ];
  assert.deepEqual(
    tmuxesForSession(discovered, ID, { claimedByOthers: new Set(['cc_someoneelse']) }).sort(),
    ['cc_a1622873', 'cc_c7980336'],
  );
});

test('ignores tmuxes running an unrelated session', () => {
  const discovered = [
    { tmuxName: 'cc_other', command: 'claude --session-id 00000000-0000-0000-0000-000000000000 --permission-mode auto' },
  ];
  assert.deepEqual(tmuxesForSession(discovered, ID), []);
});

test('ignores a foreign (non-cc_) tmux even if it is running our session id', () => {
  const discovered = [
    { tmuxName: 'work', command: `claude --session-id ${ID} --permission-mode auto` },
  ];
  assert.deepEqual(tmuxesForSession(discovered, ID), []);
});

test('does not match when the owner id is only a prefix of a longer id (token boundary)', () => {
  const longer = `${ID}-extra`;
  const discovered = [
    { tmuxName: 'cc_x', command: `claude --session-id ${longer} --permission-mode auto` },
  ];
  assert.deepEqual(tmuxesForSession(discovered, ID), []);
});

test('returns [] for a falsy owner id rather than matching everything', () => {
  const discovered = [{ tmuxName: 'cc_x', command: 'claude --session-id whatever' }];
  assert.deepEqual(tmuxesForSession(discovered, ''), []);
});

test('tmuxesForSession returns owned tmuxes of any agent prefix', () => {
  const discovered = [
    { tmuxName: 'cx_111', command: 'codex resume OWNER' },
    { tmuxName: 'cc_222', command: 'claude --resume OWNER --fork-session' },
    { tmuxName: 'foreign', command: 'codex --resume OWNER' },
  ];
  assert.deepEqual(tmuxesForSession(discovered, 'OWNER').sort(), ['cc_222', 'cx_111']);
});

test('claudeTitle strips the idle ✳ glyph and returns the bare summary', () => {
  assert.equal(claudeTitle('✳ Review shared-workflows PR #96'), 'Review shared-workflows PR #96');
});

test('claudeTitle strips a spinner frame too, so the label is stable while working', () => {
  assert.equal(claudeTitle('⠂ Auto-set agent wrangler session title'), 'Auto-set agent wrangler session title');
});

test('claudeTitle returns null for tmux\'s default hostname (no leading glyph)', () => {
  assert.equal(claudeTitle('alexs-macbook.local'), null);
});

test('claudeTitle returns null for an empty or glyph-only title', () => {
  assert.equal(claudeTitle(''), null);
  assert.equal(claudeTitle('✳ '), null);
  assert.equal(claudeTitle(undefined), null);
});

test('hasBackgroundShell detects the idle footer\'s singular "1 shell"', () => {
  const pane = [
    '❯ ',
    '  ◆ Sonnet 5 | ⎇ main | 📁 repo',
    '  ⏵⏵ auto mode on · 1 shell · ← for agents',
  ].join('\n');
  assert.equal(hasBackgroundShell(pane), true);
});

test('hasBackgroundShell detects the plural footer form "2 shells"', () => {
  const pane = '  ⏵⏵ auto mode on · 2 shells · ← for agents';
  assert.equal(hasBackgroundShell(pane), true);
});

test('hasBackgroundShell is false once the footer has no shell segment', () => {
  const pane = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
  assert.equal(hasBackgroundShell(pane), false);
});

test('hasBackgroundShell ignores an unrelated "Running N shell command" tool line', () => {
  // Same digits + the word "shell", but no middot on either side — this is the
  // tool-call announcement for a normal foreground Bash call, not the footer.
  const pane = [
    '⏺ Running 1 shell command…',
    '  ⎿  $ sleep 60',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  assert.equal(hasBackgroundShell(pane), false);
});

test('hasBackgroundShell is false for empty pane text', () => {
  assert.equal(hasBackgroundShell(''), false);
});

test('hasBackgroundShell detects Codex\'s singular "1 background terminal running"', () => {
  const pane = [
    '• Session id: 95966',
    '',
    '  1 background terminal running · /ps to view · /stop to close',
    '',
    '› ',
  ].join('\n');
  assert.equal(hasBackgroundShell(pane, 'codex'), true);
});

test('hasBackgroundShell detects Codex\'s plural "2 background terminals running"', () => {
  const pane = '  2 background terminals running · /ps to view · /stop to close';
  assert.equal(hasBackgroundShell(pane, 'codex'), true);
});

test('hasBackgroundShell is false for Codex once no background terminal marker is present', () => {
  const pane = '  gpt-5.5 default · ~/vcs/agent-wrangler';
  assert.equal(hasBackgroundShell(pane, 'codex'), false);
});

test('hasBackgroundShell cross-checks agents: a Claude marker does not match as codex and vice versa', () => {
  const claudePane = '  ⏵⏵ auto mode on · 1 shell · ← for agents';
  const codexPane = '  1 background terminal running · /ps to view · /stop to close';
  assert.equal(hasBackgroundShell(claudePane, 'codex'), false);
  assert.equal(hasBackgroundShell(codexPane, 'claude'), false);
});

test('hasBackgroundShell defaults to the claude pattern when no agent is given (back-compat)', () => {
  const pane = '  ⏵⏵ auto mode on · 1 shell · ← for agents';
  assert.equal(hasBackgroundShell(pane), true);
});

test('hasBackgroundShell returns false for an unrecognized agent rather than matching everything', () => {
  const pane = '  ⏵⏵ auto mode on · 1 shell · ← for agents';
  assert.equal(hasBackgroundShell(pane, 'some-future-agent'), false);
});

test('hasBackgroundShell detects Claude\'s footer even when the pane is too narrow for the trailing middot to render (verified against a real truncated capture)', () => {
  const pane = '  ⏵⏵ auto mode on · 1 shell';
  assert.equal(hasBackgroundShell(pane, 'claude'), true);
});

test('prefillPane delivers multi-line text as one paste-buffer block and sends NO Enter (review-first)', async () => {
  const cmds = [];
  let pastedContent = null;
  // Injected low-level tmux runner: records every tmux invocation and, on load-buffer,
  // reads the temp file so we can assert the WHOLE multi-line note is one paste block.
  const run = (socket, args) => {
    cmds.push({ socket, args });
    if (args[0] === 'load-buffer') pastedContent = fs.readFileSync(args[3], 'utf8');
    return Promise.resolve();
  };
  const note = 'line one\nline two\n- a dash-leading line';
  await prefillPane('cc_x', note, 'sockA', run);

  const verbs = cmds.map((c) => c.args[0]);
  // Delivered via the paste buffer as a single block…
  assert.deepEqual(verbs, ['load-buffer', 'paste-buffer', 'delete-buffer']);
  assert.equal(pastedContent, note, 'the entire multi-line note is pasted as one block');
  const paste = cmds.find((c) => c.args[0] === 'paste-buffer');
  // -p is asserted explicitly, not incidentally: without bracketed paste every newline
  // in this note reaches the TUI as a CR and submits it line by line, which is the exact
  // bug this flag exists to prevent (measured against a real Claude pane).
  assert.deepEqual(paste.args, ['paste-buffer', '-p', '-b', paste.args[3], '-t', 'cc_x']);
  assert.equal(paste.socket, 'sockA');
  // …and NOTHING presses a key: no send-keys, and in particular no Enter/submit.
  assert.ok(!verbs.includes('send-keys'), 'prefill must not press any key');
  assert.ok(!cmds.some((c) => c.args.includes('Enter')), 'prefill must never send Enter — no early submit');
});

test('findAgentPid: finds a containerized (devcontainer-exec) claude when there is no host claude executable', () => {
  const tree = { cmd: new Map([[100, "node /x/.bin/devcontainer exec --workspace-folder /r sh -lc env claude '--session-id' '1a0f'"], [101, 'docker exec CID /bin/sh']]), children: new Map([[100, [101]]]) };
  const hit = findAgentPid(100, tree);
  assert.equal(hit.agent, 'claude');
  assert.equal(hit.pid, 100);
});

test('findAgentPid: still matches a plain host claude executable (unchanged)', () => {
  const tree = { cmd: new Map([[200, '/bin/zsh -l'], [201, '/usr/bin/claude --session-id x']]), children: new Map([[200, [201]]]) };
  assert.equal(findAgentPid(200, tree)?.pid, 201);
});

test('findAgentPid: null for a non-agent tree', () => {
  const tree = { cmd: new Map([[300, '/bin/zsh -l']]), children: new Map() };
  assert.equal(findAgentPid(300, tree), null);
});

test('sendText waits for the paste to settle before its trailing Enter', async () => {
  const cmds = [];
  const waits = [];
  await sendText(
    'cc_y',
    'hello\nworld',
    'sockB',
    (socket, args) => { cmds.push(args); return Promise.resolve(); },
    { wait: async (ms) => { waits.push(ms); } },
  );
  const verbs = cmds.map((a) => a[0]);
  assert.deepEqual(verbs, ['load-buffer', 'paste-buffer', 'delete-buffer', 'send-keys']);
  // Bracketed, so the embedded newline stays a newline in ONE message rather than
  // submitting the first line and queueing the second as its own prompt.
  const paste = cmds.find((a) => a[0] === 'paste-buffer');
  assert.deepEqual(paste, ['paste-buffer', '-p', '-b', paste[3], '-t', 'cc_y']);
  // The final send-keys is the submit — and it is the ONLY Enter, so a two-line message
  // is one turn, not two.
  assert.deepEqual(cmds.at(-1), ['send-keys', '-t', 'cc_y', 'Enter']);
  assert.equal(cmds.filter((a) => a.includes('Enter')).length, 1);
  assert.deepEqual(waits, [120]);
});

test('sendText does not press Enter until the settle wait completes', async () => {
  const cmds = [];
  let release;
  const delivery = sendText(
    'cc_y',
    'hello',
    'sockB',
    (socket, args) => { cmds.push(args); return Promise.resolve(); },
    { wait: () => new Promise((resolve) => { release = resolve; }) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cmds.some((args) => args.includes('Enter')), false);
  release();
  await delivery;
  assert.deepEqual(cmds.at(-1), ['send-keys', '-t', 'cc_y', 'Enter']);
});

test('parsePaneLine splits fields with pane_id/window and keeps pane_title (which may contain |) last', () => {
  const p = parsePaneLine('cc_d3059a0b|18544|/Users/x/proj|%1|0|⠂ general-purpose');
  assert.equal(p.name, 'cc_d3059a0b');
  assert.equal(p.panePid, 18544);
  assert.equal(p.cwd, '/Users/x/proj');
  assert.equal(p.paneId, '%1');
  assert.equal(p.windowIndex, '0');
  assert.equal(p.paneTitle, '⠂ general-purpose');
});

test('parsePaneLine rejoins a pane_title containing pipes', () => {
  const p = parsePaneLine('cc_1|100|/p|%0|0|✳ fix a | b | c');
  assert.equal(p.paneId, '%0');
  assert.equal(p.paneTitle, '✳ fix a | b | c');
});

// --- paneModelLabel: the live model, which the transcript never records ---

test('paneModelLabel reads the model out of the status bar', () => {
  const E = '\x1b';
  // Shape taken from a real capture of a live session.
  const pane = [
    `${E}[39m❯ `,
    `${E}[39m  ${E}[38;5;153m◆ Sonnet 5${E}[38;5;246m ${E}[38;5;248m|${E}[38;5;246m ███░░ 7% | 📅 $96 | Σ $977 | 📁 dir`,
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(paneModelLabel(pane), 'Sonnet 5');
});

// The leading glyph varies between models (✦, ◆), so it is stripped structurally
// rather than matched against a list a new glyph would break.
test('paneModelLabel copes with a different leading glyph', () => {
  assert.equal(paneModelLabel('  ✦ Opus 5 | ██░ 22% | 📅 $14'), 'Opus 5');
  assert.equal(paneModelLabel('  ◆ Fable 5 | █░ 13% | 📅 $8'), 'Fable 5');
});

// Identified by the context meter, not by position, so prose cannot masquerade.
test('paneModelLabel ignores lines that are not the status bar', () => {
  assert.equal(paneModelLabel('we discussed a | b and 50 percent of it'), null);
  assert.equal(paneModelLabel('just some output'), null);
  assert.equal(paneModelLabel(''), null);
  assert.equal(paneModelLabel(null), null);
});

test('paneModelLabel takes the last status bar, which is the live one', () => {
  const pane = ['  ✦ Opus 5 | █ 5% | x', 'chatter', '  ◆ Sonnet 5 | █ 7% | x'].join('\n');
  assert.equal(paneModelLabel(pane), 'Sonnet 5');
});

// A wrong label misreports live state, so an unrecognisable one is dropped.
test('paneModelLabel rejects an implausibly long first segment', () => {
  assert.equal(paneModelLabel(`  ◆ ${'x'.repeat(60)} | █ 7% | y`), null);
});

// The statusline-builder plugin lets components be individually selected and
// reordered (skills/setup/SKILL.md), so the model badge is not always first.
test('paneModelLabel finds the model segment wherever it sits on the line', () => {
  assert.equal(paneModelLabel('███░░ 7% | ◆ Sonnet 5 | 📁 dir'), 'Sonnet 5');
  assert.equal(paneModelLabel('📁 dir | ⏱ $1.50 | ✦ Opus 5'), 'Opus 5');
});

// Adversarial review (PR #148): a bare leading-glyph check is not enough — ⚠ is
// also an ordinary warning glyph a tool or the assistant can legitimately print,
// so a real "⚠ Warning: ..." line must NOT be mistaken for a model badge (and
// must not poison the "which line is the status bar" scan either) when there is
// no actual custom statusline anywhere in the captured pane.
test('paneModelLabel does not mistake an ordinary ⚠ warning line for the model badge', () => {
  const pane = [
    'Some earlier assistant text',
    '⚠ Warning: rate limited, retrying in 5s...',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(paneModelLabel(pane), null);
});
test('paneContextPercent also ignores that same warning line', () => {
  const pane = [
    'Some earlier assistant text',
    '⚠ Warning: rate limited, retrying in 5s...',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(paneContextPercent(pane), null);
});
// A short, model-label-shaped ⚠ segment (the real Fable/Mythos "2×opus" alert
// badge) must still be recognised — the fix tightens the SHAPE allowed after
// the glyph, it does not exclude ⚠ altogether.
test('paneModelLabel still recognises the real Fable "2×opus" alert badge', () => {
  assert.equal(paneModelLabel('⚠ Claude Fable 5 2×opus | ███░░ 20% | 📁 dir'), 'Claude Fable 5 2×opus');
});

// --- paneContextPercent: the context-window bar, which has no other source ---

test('paneContextPercent reads the percentage out of the context bar', () => {
  const E = '\x1b';
  const pane = [
    `${E}[39m❯ `,
    `${E}[39m  ${E}[38;5;153m◆ Sonnet 5${E}[38;5;246m ${E}[38;5;248m|${E}[38;5;246m ███░░ 7% | 📅 $96 | Σ $977 | 📁 dir`,
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(paneContextPercent(pane), 7);
});

test('paneContextPercent is position-independent, like paneModelLabel', () => {
  assert.equal(paneContextPercent('◆ Sonnet 5 | ⏱ $1.50 | ███░░░░░░░░░░░░ 20%'), 20);
  assert.equal(paneContextPercent('███░░░░░░░░░░░░ 20% | ◆ Sonnet 5'), 20);
});

test('paneContextPercent works with no other component on the line', () => {
  assert.equal(paneContextPercent('█████░░░░░░░░░░ 35%'), 35);
});

test('paneContextPercent handles the 0% and 100% edges', () => {
  assert.equal(paneContextPercent('░░░░░░░░░░░░░░░ 0%'), 0);
  assert.equal(paneContextPercent('███████████████ 100%'), 100);
});

test('paneContextPercent ignores lines that are not the status bar', () => {
  assert.equal(paneContextPercent('we discussed a | b and 50 percent of it'), null);
  assert.equal(paneContextPercent('just some output'), null);
  assert.equal(paneContextPercent(''), null);
  assert.equal(paneContextPercent(null), null);
});

test('paneContextPercent returns null when the context component is not selected', () => {
  // Model-only statusline, no bar anywhere.
  assert.equal(paneContextPercent('◆ Sonnet 5 | ⎇ main | 📁 dir'), null);
});

test('paneContextPercent takes the last status bar, which is the live one', () => {
  const pane = ['█ 5%', 'chatter', '███ 40%'].join('\n');
  assert.equal(paneContextPercent(pane), 40);
});

// Verbatim capture of Claude Code 2.1.266's first-launch dialog in a linked worktree
// (identical on 2.1.263). The cursor rests on "No, exit" by default.
const TRUST_DIALOG = `
────────────────────────────────────────────────────
 Accessing workspace:
 /Users/me/IdeaProjects/repo-worktree-job-b007f1e5-bulk-import
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from
 your team). If not, take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

test('classify: the trust dialog reads as needs-you with a reason (never idle → never reaped, visible on the board)', () => {
  assert.deepEqual(classify(TRUST_DIALOG), { status: 'needs-you', waitingFor: 'trust dialog' });
  assert.deepEqual(classify(TRUST_DIALOG.replace(' ❯ No, exit\n   Yes', '   No, exit\n ❯ Yes')), { status: 'needs-you', waitingFor: 'trust dialog' });
});

test('trustDialogState: reports which option the cursor is on, and nothing for a quoted "Yes" line', () => {
  assert.deepEqual(trustDialogState(TRUST_DIALOG), { yesSelected: false });
  assert.deepEqual(trustDialogState(TRUST_DIALOG.replace(' ❯ No, exit\n   Yes', '   No, exit\n ❯ Yes')), { yesSelected: true });
  assert.deepEqual(trustDialogState(TRUST_DIALOG.replace(/\x27/g, '\x1b[2m\x27\x1b[22m')), { yesSelected: false }, 'ANSI is stripped first');
  assert.equal(trustDialogState('⏺ I pressed "Yes, I trust this folder" in the other pane and it started fine.\n❯ '), null);
  assert.equal(trustDialogState('❯ Try "fix typecheck errors"'), null);
  assert.equal(trustDialogState(''), null);
});
