// Claude Code's timed auto-mode safety check: a permission prompt that denies
// itself when its countdown runs out. Its session file says 'waiting' like any
// other prompt, so the pane is what marks it waitingReason 'auto-block'.
//
// Fixtures (server/fixtures/auto-block/):
// - claude-permission-prompt.txt: an ordinary Bash permission prompt, captured
//   with `tmux capture-pane` from Claude Code 2.1.318 at 80 columns.
// - claude-auto-block-{clock,about}.txt: the same dialog carrying the timed
//   banner. The banner is Claude Code 2.1.318's own string, taken verbatim from
//   its render code ("⚠ Claude Code will automatically block this request in
//   ${countdown}, to avoid holding up an unattended session", countdown `M:SS`,
//   or `about N minutes` / `about N seconds` under reduced motion), word-wrapped
//   at the dialog's 78-column width as the pane shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { autoBlockCountdown } from './tmux-scraper.js';
import { buildGraph, waitingReasonFor } from './state-reader.js';
import { adapterFor } from './agents/index.js';
import { buildHostApi } from './host-api/index.js';
import { waitingStatusWord } from '../public/cards.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/auto-block/${name}.txt`, import.meta.url), 'utf8');
const CLOCK = fixture('claude-auto-block-clock');
const ABOUT = fixture('claude-auto-block-about');
const PERMISSION = fixture('claude-permission-prompt');

test('autoBlockCountdown reads the M:SS countdown from the real banner, wrapped at 80 columns', () => {
  assert.deepEqual(autoBlockCountdown(CLOCK), { secondsLeft: 107 });
});

test('autoBlockCountdown reads the "about N minutes" countdown', () => {
  assert.deepEqual(autoBlockCountdown(ABOUT), { secondsLeft: 120 });
});

test('autoBlockCountdown reads "about N seconds" and a banner wrapped on a narrow pane', () => {
  const narrow = ' ⚠ Claude Code will automatically block\n this request in about 40 seconds, to\n avoid holding up an unattended session\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No';
  assert.deepEqual(autoBlockCountdown(narrow), { secondsLeft: 40 });
  assert.deepEqual(autoBlockCountdown(' ⚠ Claude Code will automatically block this request in about 1 minute, to avoid holding up an unattended session'), { secondsLeft: 60 });
  assert.deepEqual(autoBlockCountdown(' ⚠ Claude Code will automatically block this request in 0:05, to avoid holding up an unattended session'), { secondsLeft: 5 });
});

test('autoBlockCountdown is null for an ordinary permission prompt', () => {
  assert.equal(autoBlockCountdown(PERMISSION), null);
  assert.equal(autoBlockCountdown(''), null);
  assert.equal(autoBlockCountdown(undefined), null);
});

test('autoBlockCountdown ignores the banner once the conversation has moved past it', () => {
  // The banner's words quoted in an earlier reply, then an ordinary prompt: the
  // transcript bullet after it means it is scrollback, not the live dialog.
  const quoted = CLOCK.split('\n').slice(0, -1).join('\n') + '\n\n⏺ That prompt resolved; running the next command.\n' + PERMISSION;
  assert.equal(autoBlockCountdown(quoted), null);
  // Prose that mentions it mid-line is never the banner.
  assert.equal(autoBlockCountdown('  It said Claude Code will automatically block this request in 1:47, to avoid holding up an unattended session.\n' + PERMISSION), null);
});

test("waitingReasonFor: Claude 'waiting' is 'auto-block' with the timed banner, else 'permission'", () => {
  assert.deepEqual(waitingReasonFor(adapterFor('claude'), 'waiting', CLOCK), { waitingReason: 'auto-block', autoBlockSeconds: 107 });
  assert.deepEqual(waitingReasonFor(adapterFor('claude'), 'waiting', ABOUT), { waitingReason: 'auto-block', autoBlockSeconds: 120 });
  assert.deepEqual(waitingReasonFor(adapterFor('claude'), 'waiting', PERMISSION), { waitingReason: 'permission', autoBlockSeconds: null });
  assert.deepEqual(waitingReasonFor(adapterFor('claude'), 'waiting', ''), { waitingReason: 'permission', autoBlockSeconds: null });
  assert.equal(waitingReasonFor(adapterFor('claude'), 'busy', CLOCK), null);
  assert.equal(waitingReasonFor(adapterFor('codex'), 'waiting', CLOCK), null);
});

// The discovered-tmux pass of buildGraph, with the live session file Claude
// 2.1.318 writes for a prompt ({status:'waiting', waitingFor:'permission prompt'}).
function discoveredGraph(paneText) {
  const agent = 'claude';
  const entry = { sessionId: 'ab1', agent, cwd: '/nonexistent/repo', liveSessionId: 'L1' };
  const sessionManager = {
    activeEntries: () => [],
    archivedEntries: () => [],
    entryFor: (id) => (id === entry.sessionId ? entry : undefined),
    entryByTmux: (t) => (t === 'cc_ab1' ? entry : null),
    tmuxOwner: () => null,
    tmuxNameFor: () => null,
    deadTmuxNameFor: () => null,
    isArchived: () => false,
    scanSockets: () => [''],
    socketOf: () => '',
  };
  const discover = async () => [{ tmuxName: 'cc_ab1', socket: '', claudePid: 4242, agent, cwd: entry.cwd, command: agent, paneTitle: '' }];
  const readLive = async () => ({ liveSid: 'L1', status: 'needs-you', rawStatus: 'waiting', waitingFor: 'permission prompt', name: null });
  const runtimeResolver = () => ({ readLive, analyze: async () => null });
  return buildGraph(sessionManager, async () => ({}), { runtimeResolver, discover, capture: async () => paneText });
}

test('buildGraph: a waiting Claude pane with the timed prompt yields waitingReason auto-block', async () => {
  for (const [pane, seconds] of [[CLOCK, 107], [ABOUT, 120]]) {
    const node = (await discoveredGraph(pane)).sessions.find((s) => s.sessionId === 'ab1');
    assert.equal(node.status, 'needs-you');
    assert.equal(node.waitingReason, 'auto-block');
    assert.equal(node.autoBlockSeconds, seconds);
    assert.equal(node.waitingFor, 'permission prompt');
  }
});

test('buildGraph: an ordinary Claude permission prompt still yields waitingReason permission', async () => {
  const node = (await discoveredGraph(PERMISSION)).sessions.find((s) => s.sessionId === 'ab1');
  assert.equal(node.status, 'needs-you');
  assert.equal(node.waitingReason, 'permission');
  assert.equal(node.autoBlockSeconds, null);
});

test('the board keeps auto-block as needs-you, worded as a check', () => {
  assert.equal(waitingStatusWord('auto-block'), 'check');
  assert.equal(waitingStatusWord('permission'), 'reply');
  assert.equal(waitingStatusWord(null), 'reply');
});

test('host API sessions rows carry waitingReason auto-block and the seconds left', async () => {
  const entries = [{ sessionId: 'ab1', agent: 'claude', cwd: '/nonexistent/repo' }];
  const hostFor = (graph) => buildHostApi({
    id: 'x',
    requires: ['sessions:read'],
    core: {
      sessionManager: { activeEntries: () => entries, entryFor: (id) => entries.find((e) => e.sessionId === id) },
      taskStore: { taskFor: () => null },
      graph: () => graph,
    },
  });
  const host = hostFor(await discoveredGraph(CLOCK));
  const row = host.sessions.get('ab1');
  assert.equal(row.status, 'needs-you');
  assert.equal(row.waitingReason, 'auto-block');
  assert.equal(row.autoBlockSeconds, 107);
  assert.deepEqual(host.sessions.list().map((r) => [r.sessionId, r.waitingReason]), [['ab1', 'auto-block']]);

  const ordinary = hostFor(await discoveredGraph(PERMISSION)).sessions.get('ab1');
  assert.equal(ordinary.waitingReason, 'permission');
  assert.equal(ordinary.autoBlockSeconds, null);
});
