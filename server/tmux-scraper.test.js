import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmuxesForSession, claudeTitle, hasBackgroundShell, prefillPane, sendText, classify, findAgentPid, parsePaneLine } from './tmux-scraper.js';

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
  assert.deepEqual(paste.args, ['paste-buffer', '-b', paste.args[2], '-t', 'cc_x']);
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

test('sendText shares the paste block but DOES submit with a trailing Enter', async () => {
  const cmds = [];
  await sendText('cc_y', 'hello\nworld', 'sockB', (socket, args) => { cmds.push(args); return Promise.resolve(); });
  const verbs = cmds.map((a) => a[0]);
  assert.deepEqual(verbs, ['load-buffer', 'paste-buffer', 'delete-buffer', 'send-keys']);
  // The final send-keys is the submit.
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
