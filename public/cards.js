// Pure HTML builders for the board's cards, tiles, workflow boxes, snoozed rows and
// TODO zones. Every function returns a string and has no side effects — the view
// state each one reads (selection, flash sets, collapse set, the derived status
// helpers, etc.) is passed in as an explicit `ctx` so the module stays testable and
// app.js owns the singletons. `ctx` shape (see app.js `cardCtx()`):
//   { selectedSessionId, selectedNewSlot, flashingPr, collapsedWorkflows,
//     activitySortedTasks, justFinished, cardState, barWord, phaseOf, todosFor, ADHOC_ID,
//     cloudEnvironments }
import {
  CLOCK_ICON, DOLLAR_ICON, WORKFLOW_ICON, MOON_ICON, WAKE_ICON,
  CHECK_ICON, SPAWN_ICON, X_ICON, ROBOT_ICON, KEBAB_ICON,
  PLUS_ICON, MINUS_ICON, MAIL_ICON, MAIL_FILLED_ICON, CPU_ICON,
  agentIcon, JIRA_ICON, PR_ICON, MERGE_ICON,
} from './icons.js';
import {
  esc, timeAgo, throbDelayStyle, locationLabel, isWorktree, branchBadge, safeHttpUrl, displayStatus,
} from './util.js';
import { wakeLabel } from './snooze.js';
import { isWorkflowRun, sessionGroups } from './workflow.js';

export const STATUS_WORDS = { working: 'busy', 'needs-you': 'reply', idle: 'idle', job: 'job' };

// Sub-agents finished within this window still show under the default "Recent" filter
// (a starting point — not tuned against real usage yet).
export const SUBAGENT_RECENT_MS = 5 * 60 * 1000;

// A running sub-agent has no "last update" timestamp of its own (it's still
// updating), so it sorts as the most recent thing there is — ahead of any
// finished entry, however recently that one ended.
function subAgentRecency(a) {
  return a.status === 'running' ? Infinity : (a.endedAt ?? a.startedAt ?? 0);
}

// The default "Recent" filter (not "Active" — it includes sub-agents that already finished, so "Active" would overclaim): still running, or finished within the recent window.
// "Show finished" (showFinished) reveals everything — legacy entries (always
// completed) included, so they only ever appear under "Show finished". Always
// returned in reverse-chronological order (most recently updated first, so an
// active sub-agent naturally rises to the top) — a fresh sorted copy, never the
// caller's own array.
export function visibleSubAgents(subAgents, { showFinished, now }) {
  const list = Array.isArray(subAgents) ? subAgents : [];
  const filtered = showFinished
    ? list
    : list.filter((a) => a.status === 'running' || (a.endedAt != null && now - a.endedAt <= SUBAGENT_RECENT_MS));
  return [...filtered].sort((a, b) => subAgentRecency(b) - subAgentRecency(a));
}

// One sub-agent as a plain flat row (no connector line — see the todo zone, whose
// divider/row visual language this mirrors). NOT a session: carries
// data-subagent-id (+ its owning card id), never data-sid, so a click opens the
// detail modal rather than selecting a session. A robot icon (agentType tooltip)
// leads, then the status dot — widened into a small pill shape rather than a
// plain circle (.subagent-row.running colours it, see styles.css) — carrying its
// own running/completed tooltip since there's no verbal "run"/"done" word.
export function subagentRowHtml(sa, sid) {
  const cost = typeof sa.usd === 'number' && sa.usd > 0 ? `$${sa.usd.toFixed(2)}` : '';
  const costTitle = typeof sa.advisorUsd === 'number' && sa.advisorUsd > 0
    ? ` title="$${sa.advisorUsd.toFixed(2)} on advisor consults"`
    : '';
  // endedAt is bumped on every transcript line while running (see
  // transcript-reader.js scanSubLine), not just at completion, so it already IS
  // "last updated" for both states — startedAt is only a fallback for a legacy
  // running entry, which has no endedAt yet.
  const updated = timeAgo(sa.endedAt ?? sa.startedAt);
  return `<div class="subagent-row ${esc(sa.status)}" data-subagent-id="${esc(sa.id)}" data-owner-sid="${esc(sid)}" title="${esc(sa.label)}" role="button" tabindex="0">
    <span class="subagent-agent-icon" title="${esc(sa.agentType)}">${ROBOT_ICON}</span>
    <span class="subagent-dot" title="${sa.status === 'running' ? 'running' : 'completed'}"></span>
    <span class="subagent-name">${esc(sa.label)}</span>
    ${updated ? `<span class="subagent-updated" title="last updated">${CLOCK_ICON}${esc(updated)}</span>` : ''}
    <span class="subagent-cost"${costTitle}>${esc(cost)}</span>
  </div>`;
}

// The zone's divider, matching .todo-divider's visual language (a faint rule +
// label pill) but with the robot icon in place of the todo zone's plain text pill,
// and an optional extra control (the panel's own Recent/All pill) after it.
export function subagentDividerHtml(extra = '') {
  return `<div class="subagent-divider"><span class="subagent-label">${ROBOT_ICON}sub-agents</span>${extra}</div>`;
}

// The card's own show/hide toggle for the whole zone (distinct from the panel's
// Recent/All filter — see subagentZoneHtml). State lives in ctx.subagentShown (a
// Set of card ids), persisted like collapsedWorkflows. Rendered only when the
// session has any sub-agents at all; disabled (not clickable) when none are
// currently recent — toggling it on would show nothing, since the card's zone
// only ever renders the Recent filter. Label is recent/total so the count itself
// hints at why it may be disabled.
export function subagentPillHtml(s, ctx) {
  const list = Array.isArray(s.subAgents) ? s.subAgents : [];
  if (!list.length) return '';
  const now = ctx.now || Date.now();
  const recentCount = visibleSubAgents(list, { showFinished: false, now }).length;
  const disabled = recentCount === 0;
  const shown = !disabled && ctx.subagentShown?.has(s.sessionId);
  const title = disabled ? 'No recent sub-agents' : `${shown ? 'Hide' : 'Show'} sub-agents`;
  // +/- rather than a rotating chevron — a direction-of-rotation glyph reads as
  // "which way is open?"; a plain +/- doesn't need that interpretation at all.
  const toggleIcon = `<span class="subagent-toggle-icon">${shown ? MINUS_ICON : PLUS_ICON}</span>`;
  // card-tag + subagent-pill, always together: card-tag is the chip look (same
  // as every other card meta chip), subagent-pill only adds the toggle states.
  // aria-disabled, not the native `disabled` attribute: a disabled button
  // suppresses its click event entirely (no bubbling), which would swallow the
  // click instead of letting it fall through to the card's own focus behavior,
  // like clicking any other inert part of the card.
  return `<button class="card-tag subagent-pill${shown ? ' showing' : ''}"${disabled ? ' aria-disabled="true"' : ''} data-sid="${esc(s.sessionId)}" title="${esc(title)}">${ROBOT_ICON}${recentCount}/${list.length}${toggleIcon}</button>`;
}

// The card's sub-agent zone: only rendered once its pill is toggled on (§subagentPillHtml),
// and then only the Recent filter (fixed — the card has no Show-finished control of its
// own, that lives on the panel). Nothing renders when toggled off, or toggled on with
// no currently-active rows — an idle session with no recent activity keeps a clean card.
// No divider/heading here (unlike the panel's zone) — the pill right above it already
// says "sub-agents", so repeating the label on the card would be pure redundancy.
export function subagentZoneHtml(s, ctx) {
  const list = Array.isArray(s.subAgents) ? s.subAgents : [];
  if (!list.length || !ctx.subagentShown?.has(s.sessionId)) return '';
  const rows = visibleSubAgents(list, { showFinished: false, now: ctx.now || Date.now() });
  if (!rows.length) return '';
  // .subagent-zone (not just bare rows) gives this its own top/bottom margins,
  // independent of each row's inter-row gap — see styles.css: extra breathing
  // room above the first row, and a negative bottom margin so the LAST row's
  // bottom edge lines up exactly with .card-bar's bottom edge (both measured
  // from the card's own padding-box bottom, which they'd otherwise miss by the
  // 2px difference between the card's 8px bottom padding and the bar's 6px inset).
  return `<div class="subagent-zone">${rows.map((sa) => subagentRowHtml(sa, s.sessionId)).join('')}</div>`;
}

// Readable dot tooltip per PR readiness status (the raw word reads oddly).
export const PR_DOT_TITLE = {
  passing: 'checks passed — ready to merge',
  failing: 'checks failing',
  pending: 'checks pending',
  'awaiting-review': 'checks passed — awaiting review',
  'changes-requested': 'changes requested',
};

// Read-only link chips for a task tile / session card / panel: jira (key, links
// to the issue) and pr (#number, links to the PR, with a CI status dot the
// server polls). All mutation is via MCP — there's deliberately no add/remove
// affordance here. Reads ctx.flashingPr so the one-shot failure flash survives
// re-renders.
export function linkChipsHtml(links, ctx = {}) {
  if (!Array.isArray(links) || !links.length) return '';
  const flashingPr = ctx.flashingPr || new Set();
  return links.map((l) => {
    const isPr = l.type === 'pr';
    const icon = isPr ? PR_ICON : (l.type === 'jira' ? JIRA_ICON : '');
    const label = esc(isPr ? (l.number != null ? `#${l.number}` : l.url) : (l.key || l.url || 'link'));
    // `dirty` (merge conflicts) takes precedence over checkStatus in the dot: a
    // dirty PR can't be merged regardless of CI, and dirty is orthogonal to
    // checkStatus's own vocabulary (a DIRTY PR often still shows `pending`).
    const dot = isPr && l.dirty
      ? `<span class="pr-dot pr-dirty${flashingPr.has(l.url) ? ' pr-dot--alert' : ''}" title="merge conflicts — needs a rebase"></span>`
      : isPr && l.checkStatus && l.checkStatus !== 'none'
      ? `<span class="pr-dot pr-${esc(l.checkStatus)}${flashingPr.has(l.url) ? ' pr-dot--alert' : ''}" title="${esc(PR_DOT_TITLE[l.checkStatus] || l.checkStatus)}"></span>`
      : '';
    const inner = `${icon}${label}${dot}`;
    const href = l.url ? safeHttpUrl(l.url) : null;
    const cls = `link-chip${l._muted ? ' link-chip--muted' : ''}`;
    return href
      ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`
      : `<span class="${cls}">${inner}</span>`;
  }).join('');
}

// The devcontainer chip doubles as a bring-up indicator. While the container is
// still coming up, classify() (server-side) surfaces a transient hint as
// `waitingFor`: 'starting container' rides a `working` status (a normal working
// session carries no waitingFor, so on a devcontainer node this is unambiguously
// the bring-up hint), and a fatal `devcontainer up` failure rides `needs-you` as
// 'container bring-up failed'. main removed the generic waitingFor card line; this
// is the one place it earns a chip, scoped tightly to the bring-up window so an
// ordinary needs-you prompt on a running container still just reads "⬢ dc".
export function devcontainerChip(s) {
  if (s.status === 'working' && s.waitingFor) {
    return `<span class="card-tag runtime-dc runtime-dc--starting" title="${esc(s.waitingFor)}">⬢ ${esc(s.waitingFor)}</span>`;
  }
  if (s.status === 'needs-you' && s.waitingFor === 'container bring-up failed') {
    return '<span class="card-tag runtime-dc runtime-dc--failed" title="Devcontainer bring-up failed">⬢ bring-up failed</span>';
  }
  return '<span class="card-tag runtime-dc" title="Running inside the repo devcontainer">⬢ dc</span>';
}

// The visible label of the cloud link chip. The ↗ is the same "leaves the board"
// hint the link-overflow menu uses; the host is spelled out because a cloud
// session's only real home is that page.
const CLOUD_LINK_LABEL = 'claude.ai/code ↗';

// A cloud session's URL is scraped out of pane output (parseCloudLaunchLog), so
// it is agent-provided text and gets the same treatment as a PR link's url —
// safeHttpUrl for the protocol — plus a host pin: https on claude.ai is the only
// place a cloud session's page can legitimately live, so anything else (an
// attacker-chosen host that happens to be https, a `javascript:` payload) is
// refused here rather than handed to an <a href>.
const CLOUD_URL_HOSTS = new Set(['claude.ai', 'www.claude.ai']);
function cloudSessionUrl(url) {
  const safe = safeHttpUrl(url);
  if (!safe) return null;
  try {
    const u = new URL(safe);
    return u.protocol === 'https:' && CLOUD_URL_HOSTS.has(u.hostname.toLowerCase()) ? safe : null;
  } catch {
    return null;
  }
}

// Every chip a cloud card carries, as one string for sessionCardHtml's runtime
// slot — beside devcontainerChip because the two answer the same question
// ("where does this session actually run") and a card picks exactly one of them.
//
// The environment registry is a server setting (config.json → the graph), so it
// rides `ctx` exactly as taskMemoryEnabled does rather than a module global —
// cards.js stays a pure builder over the ctx it is handed. Defaulting to []
// means a card still renders correctly on a graph push that predates the
// setting: an unmatched id simply shows raw, which is honest.
export function cloudChips(s, ctx = {}) {
  const cloud = s.cloud;
  if (!cloud) return '';
  const registry = Array.isArray(ctx.cloudEnvironments) ? ctx.cloudEnvironments : [];
  // null/'' is the account default (there is no id to show); a registered id
  // shows its human label with the id on hover; an unregistered one shows the
  // raw id — never silently relabelled, since the id is what picks the launch form.
  const envId = cloud.environmentId || null;
  const envLabel = (envId ? registry.find((e) => e && e.id === envId)?.label : null)
    || envId || 'Account default';
  const url = cloudSessionUrl(cloud.url);
  // A link chip whose href was refused would render as an inert span labelled
  // like a link — worse than nothing — so an unsafe/absent url drops the chip
  // entirely. The safe case goes through linkChipsHtml so it is byte-for-byte
  // the same chip as a Jira/PR link (`type` is unknown to it, which is exactly
  // right: no icon, no CI dot, just the label + href).
  const link = url ? linkChipsHtml([{ type: 'cloud', key: CLOUD_LINK_LABEL, url }], ctx) : '';
  // A teleported card (entry.cloud retained, runtime flipped back to local) is an
  // ordinary local session from that moment on: real transcript, real cost, real
  // diff. So it keeps only the provenance chip and the link, not the env chip —
  // the environment it launched in no longer describes where it's running.
  if (s.runtime !== 'cloud') {
    const wasTitle = `Started as a cloud session in ${envLabel}${envId ? ` (${envId})` : ''}, teleported to this local checkout`;
    return `<span class="card-tag runtime-cloud" title="${esc(wasTitle)}">was ☁</span>${link}`;
  }
  const archived = Boolean(cloud.archivedAt);
  // No `sessionId` yet means the launch pane hasn't been scraped for one — the
  // session may not exist as far as claude.ai is concerned. That's a real,
  // already-known fact (not a guessed working/idle status), so it's worth its
  // own chip: "starting…" rather than the env label, reusing the dc bring-up
  // chip's brightness throb so it reads as in-progress the same way.
  const starting = !cloud.sessionId && !archived;
  const envTitle = starting
    ? `${envLabel}${envId ? ` (${envId})` : ''} — waiting for the cloud session to start`
    : `${envId || 'Account default'}${archived ? ' — this cloud session is archived' : ''}`;
  const env = starting
    ? `<span class="card-tag runtime-cloud runtime-cloud--starting" title="${esc(envTitle)}">☁ starting…</span>`
    : `<span class="card-tag runtime-cloud" title="${esc(envTitle)}">☁ ${esc(envLabel)}</span>`;
  // Archived is said twice on purpose, both cheap: the env chip's title (hover
  // lands on the chip that identifies the session) plus one plain `archived`
  // chip so it is legible without hovering. Deliberately NOT its own colour or
  // card state — an archived cloud session is stale, not an alarm, and
  // cardState()/barWord() (app.js) own a card's actual signal.
  const arch = archived
    ? '<span class="card-tag" title="This cloud session is archived — it can no longer be steered; Teleport it to keep working locally">archived</span>'
    : '';
  return `${env}${link}${arch}`;
}

// The mail-badge pill: `.card-name-row`, immediately left of the agent icon —
// metadata about the card's identity ("this session has mail"), not what it's
// doing (that's `.card-meta`). Call it `mail`/`mail-badge`, NEVER `unread` —
// `public/app.js` already owns an unrelated per-browser `unread` bookmark
// feature that hijacks `barWord()`/`cardState()`; mail must never touch either
// (see CLAUDE.md). Rendered only when there is unread mail (undeliverable/read
// mail never shows a pill — s.mail.unread counts unread only, see
// mailbox-store.js unreadInfo). Stale (>=30min unnotified) switches to the
// FILLED envelope glyph rather than a chip background in either theme — no
// background was the explicit call (a tinted chip read as visual noise); the
// shape change alone carries the signal instead.
export function mailBadgeHtml(s) {
  const mail = s.mail;
  if (!mail || !mail.unread) return '';
  const stale = mail.amber;
  const age = mail.notifiedAt ? timeAgo(mail.notifiedAt) : null;
  const senders = mail.senders?.length ? ` from ${mail.senders.join(', ')}` : '';
  const title = `${mail.unread} unread message${mail.unread > 1 ? 's' : ''}${senders}`
    + (age ? ` — notified ${age}` : '')
    + (stale ? ' — unread a while, may need a nudge' : '');
  const icon = stale ? MAIL_FILLED_ICON : MAIL_ICON;
  return `<span class="mail-badge${stale ? ' stale' : ''}" title="${esc(title)}">${icon}${mail.unread}</span>`;
}

export function modelPillHtml(model) {
  if (!model) return '';
  return `<span class="card-tag model-pill" title="${esc(model.title)}">${CPU_ICON}<span class="model-pill-label">${esc(model.label)}</span></span>`;
}

export function sessionCardHtml(s, ctx, { expanded, wf, nested } = {}) {
  const state = ctx.cardState(s);
  const estimated = s.agent === 'codex';
  // A cloud session has no transcript, so `usd` is null already — the explicit
  // gate is here so that a stray number reaching a cloud card (a mis-scoped
  // scan, a half-finished teleport) can never render as this session's spend;
  // there is simply no cost pill for it. Keyed on the RUNTIME, not on s.cloud: a
  // teleported card is local, has a real transcript, and must keep its ordinary
  // cost pill.
  const cloudRuntime = s.runtime === 'cloud';
  const cost = !cloudRuntime && typeof s.usd === 'number' && s.usd > 0
    ? `${estimated ? '~' : ''}${s.usd.toFixed(2)}`
    : '';
  // Dormant (no live tmux) gets the hollow "resume" bar and a dimmed name; the
  // server reports a frozen `idle` for it, so the bar word/treatment is what
  // tells these apart, not the status class. A restarting card is only briefly
  // unmanaged (tmux down between kill and relaunch) — keep its live skin so it
  // doesn't flicker to the dormant look, and show a small badge instead.
  // A CLOUD card is never dormant either, and for a stronger reason: it has no
  // live pane by design (the create client exits), yet the session is running
  // somewhere we can't see. The dormant skin's whole message is "nothing is
  // running here, click to resume", which for cloud is a lie the styles would
  // otherwise tell on every card (the .dormant rules also out-specify the .cloud
  // bar). cardState() already returns a dedicated 'cloud' state.
  const dormant = (s.managed || s.restarting || s.runtime === 'cloud') ? '' : ' dormant';
  const agentName = s.agent || 'claude';
  const wtTag = isWorktree(s);
  const wt = wtTag
    ? '<span class="card-tag wt" title="Running in a git worktree">⌥ wt</span>'
    : '';
  const automerge = s.autoMergeOnPass
    ? `<span class="card-tag automerge" title="Automatically merges the PR when checks pass">${MERGE_ICON}auto-merge</span>`
    : '';
  const runtimeChip = s.runtime === 'devcontainer' ? devcontainerChip(s) : s.cloud ? cloudChips(s, ctx) : '';
  const restarting = s.restarting
    ? '<span class="card-tag restarting" title="Tmux is being killed and relaunched">restarting</span>'
    : '';
  const age = s.lastActivity
    ? `<span class="card-tag">${CLOCK_ICON}${esc(timeAgo(s.lastActivity))}</span>`
    : '';
  // Advisor consults are folded into `cost` already (they're real spend) — the
  // title just breaks out how much of it was the native advisor tool, not a
  // second number to add up.
  const advisorNote = typeof s.advisorUsd === 'number' && s.advisorUsd > 0
    ? ` ($${s.advisorUsd.toFixed(2)} on advisor consults)`
    : '';
  const costEl = cost
    ? `<span class="card-tag" title="${estimated ? 'estimated cost so far' : 'cost so far'}${advisorNote}">${DOLLAR_ICON}${esc(cost)}</span>`
    : '';
  // Card ring yields to the "new session" slot's ring while the keyboard selection
  // sits on a slot — the terminal stays open underneath, but only one thing is lit.
  const selected = s.sessionId === ctx.selectedSessionId && ctx.selectedNewSlot == null ? ' selected' : '';
  const metaLinks = s.links?.length
    ? `<span class="card-meta-links">${linkChipsHtml(s.links, ctx)}</span>`
    : '';
  const tokenChip = expanded && s.tokens
    ? `<span class="card-tag" title="tokens — output / input">${(s.tokens.output / 1000).toFixed(1)}k out · ${(s.tokens.input / 1000).toFixed(1)}k in</span>`
    : '';
  const modelPill = modelPillHtml(s.modelPill);
  // The show/hide pill; the zone itself renders INSIDE the card (below), not as
  // a sibling after it — otherwise it's unclear which card a zone belongs to
  // once a tile holds more than one. Shown whenever the session has any
  // sub-agents, expanded or not.
  const subAgentPill = subagentPillHtml(s, ctx);
  const subAgentZone = subagentZoneHtml(s, ctx);
  // The bar word is the full status/phase; clip to 6 chars (matching the existing
  // 6-char words like RESUME/UNREAD) with the full label on hover when truncated.
  const bw = ctx.barWord(s);
  const bwShown = bw.length > 6 ? bw.slice(0, 6) : bw;
  const bwTitle = bw.length > 6 ? ` title="${esc(bw)}"` : '';
  // The orchestrator card sits inside a workflow box that owns drag/reorder for the
  // whole run, so the card itself isn't independently draggable; `wf-orchestrator`
  // tints its frame violet to read as the run's lead. `nested` is the plain-parent
  // equivalent: whenever childGroupHtml is about to wrap this card in a
  // `.child-group` (it has children and/or a live team), the GROUP becomes the
  // drag unit instead — same reasoning as `wf`, just without the violet tint.
  const wfCls = wf ? ' wf-orchestrator' : '';
  const draggable = (wf || nested) ? 'false' : 'true';
  return `<div class="session-card ${state}${dormant}${selected}${expanded ? ' expanded' : ''}${wfCls}" data-sid="${esc(s.sessionId)}" draggable="${draggable}" role="button" tabindex="0"${throbDelayStyle(state)}>
    <span class="card-bar"${bwTitle}><span>${esc(bwShown)}</span></span>
    <div class="card-name-row">
      <span class="card-name">${esc(s.label)}</span>
      ${mailBadgeHtml(s)}
      <span class="agent-ico" title="${esc(agentName)}">${agentIcon(s.agent)}</span>
    </div>
    <div class="card-loc"><span class="card-repo" title="${esc(s.cwd)}">${locationLabel(s.cwd)}</span>${branchBadge(s.branch)}</div>
    <div class="card-meta">${age}${costEl}${modelPill}${tokenChip}${subAgentPill}${restarting}${automerge}${runtimeChip}${wt}${metaLinks}</div>
    ${subAgentZone}
  </div>`;
}

// The status word for a worker's spine row — no longer shown as a visible label
// (the dot's colour already carries it, see .worker-dot rules in styles.css); it
// survives only as the dot's tooltip. Same vocabulary as the card bar, plus
// 'done' for a self-finished worker (the cyan just-finished state) and 'resume'
// for a dormant one.
export function workerStatusWord(s, ctx) {
  if (!s.managed && !s.restarting) return 'resume';
  if (s.status === 'needs-you') return STATUS_WORDS['needs-you'];
  if (ctx.justFinished.has(s.sessionId)) return 'done';
  return STATUS_WORDS[displayStatus(s)] || s.status || '';
}

// One worker on its run's spine: a status dot (coloured by state, same vocabulary
// as the card bar, carried as its tooltip), the worker's name, and cost. Carries
// data-sid so a click opens it like any card; not independently draggable — it
// rides with its run, reordered only by dragging the whole workflow box. Mirrors
// sessionCardHtml's `selected` ring so a focused child session reads exactly like
// a focused top-level one — cardState() already supplies the same
// needs-you/just-finished/snooze-alarm vocabulary to both (see styles.css).
export function workerRowHtml(s, ctx) {
  const state = ctx.cardState(s);
  // Same restarting exemption as the top-level card (sessionCardHtml): a worker/child
  // row being restarted is only briefly unmanaged — don't flicker it to the dormant skin.
  const dormant = (s.managed || s.restarting || s.runtime === 'cloud') ? '' : ' dormant';
  const selected = s.sessionId === ctx.selectedSessionId && ctx.selectedNewSlot == null ? ' selected' : '';
  const estimated = s.agent === 'codex';
  // Same cloud gate as the full card (sessionCardHtml) — a collapsed cloud child
  // must not show a $ pill either, or the two renderings of one session would
  // disagree about whether its spend is knowable.
  const cloudRuntime = s.runtime === 'cloud';
  const cost = !cloudRuntime && typeof s.usd === 'number' && s.usd > 0
    ? `${estimated ? '~' : ''}${s.usd.toFixed(2)}`
    : '';
  const advisorNote = typeof s.advisorUsd === 'number' && s.advisorUsd > 0
    ? ` ($${s.advisorUsd.toFixed(2)} on advisor consults)`
    : '';
  // Same card-tag pill as the full session card's cost chip (sessionCardHtml
  // costEl) — composing on .card-tag, not a bespoke row-only style, so the two
  // read as the same chip whether a session is collapsed into a spine or not.
  const costEl = cost
    ? `<span class="card-tag" title="${estimated ? 'estimated cost so far' : 'cost so far'}${advisorNote}">${DOLLAR_ICON}${esc(cost)}</span>`
    : '';
  // Same link chips as the full card's metaLinks, alongside the cost pill —
  // a collapsed child otherwise hides its Jira/PR links entirely.
  const metaLinks = s.links?.length
    ? `<span class="card-meta-links">${linkChipsHtml(s.links, ctx)}</span>`
    : '';
  // A worker/child row has no name row or meta row to hold the full mail-badge
  // pill, so it gets a bare dot instead — amber (stale) only, no count. Normal
  // (fresh) unread mail is not worth a row-level signal here; only the case that
  // wants a human's attention is.
  const mailDot = s.mail?.amber ? '<span class="worker-mail-dot" title="unread mail — a while since notifying"></span>' : '';
  return `<div class="worker-row ${state}${dormant}${selected}" data-sid="${esc(s.sessionId)}" title="${esc(s.label)}" role="button" tabindex="0"${throbDelayStyle(state)}>
    <span class="worker-dot" title="${esc(workerStatusWord(s, ctx))}"></span>
    <span class="worker-name">${esc(s.label)}</span>
    ${mailDot}
    <span class="worker-meta">${costEl}${metaLinks}</span>
    <span class="worker-ring" aria-hidden="true"></span>
  </div>`;
}

// A workflow run as the violet group box: a header (icon + "Workflow" + worker
// count + a collapse chevron), the orchestrator card, then the spine of its worker
// rows. The header toggles collapse (client-only, in ctx.collapsedWorkflows) — folding
// the spine away while the run itself stays visible. A solo run (no workers yet)
// shows no spine and no chevron; there is nothing to collapse. data-sid on the box
// is the orchestrator's, so the box drags/reorders as one unit in its place —
// UNLESS `nested` (the run also has a live team, so renderTileCards wraps this
// box in its own `.child-group`; that outer wrapper becomes the drag unit instead,
// same as a plain parent's card yielding to childGroupHtml — see `nested` there).
// A child (any session absorbed into a parent's spine — a workflow worker or a
// plain nested child) draws as a compact `.worker-row` by default; "Full view"
// (ctx.isChildFullView — a per-child override, or the server-wide new-child
// default) instead draws it as an ordinary top-level card, wrapped in a bare
// `.spine-full-row` div purely so it can carry the same elbow connector a
// `.worker-row` draws (see styles.css) without borrowing that class's own
// background/border/padding. Still non-draggable (`nested: true`) — the
// enclosing `.child-group`/`.workflow-box` wrapper is the actual drag unit.
function childRowHtml(c, ctx, { focusMode } = {}) {
  if (!ctx.isChildFullView(c)) return workerRowHtml(c, ctx);
  return `<div class="spine-full-row">${sessionCardHtml(c, ctx, { expanded: focusMode, nested: true })}</div>`;
}

export function workflowBoxHtml(orch, workers, ctx, { focusMode, nested } = {}) {
  const n = workers.length;
  const collapsed = n > 0 && ctx.collapsedWorkflows.has(orch.sessionId);
  const count = n === 0 ? 'solo' : `${n} worker${n > 1 ? 's' : ''}`;
  const chevron = n > 0 ? `<span class="wf-chevron">${collapsed ? '▸' : '▾'}</span>` : '';
  const head = `<div class="workflow-head"${n > 0 ? ' role="button" tabindex="0"' : ''} title="${n > 0 ? (collapsed ? 'Show workers' : 'Hide workers') : 'Workflow run'}">
      <span class="wf-ico">${WORKFLOW_ICON}</span>
      <span class="wf-title">Workflow</span>
      <span class="wf-spacer"></span>
      <span class="wf-count">${esc(count)}</span>
      ${chevron}
    </div>`;
  const spine = n > 0 && !collapsed
    ? `<div class="workflow-spine">${workers.map((w) => childRowHtml(w, ctx, { focusMode })).join('')}</div>`
    : '';
  return `<div class="workflow-box${collapsed ? ' collapsed' : ''}" data-sid="${esc(orch.sessionId)}" draggable="${nested ? 'false' : 'true'}">
    ${head}
    ${sessionCardHtml(orch, ctx, { expanded: focusMode, wf: true })}
    ${spine}
  </div>`;
}

// A plain (non-workflow) nested child spine: the parent renders as an ordinary
// full card, immediately followed by this always-visible spine of compact rows —
// no wrapping box, no "Workflow" header, no count, no collapse toggle. Reuses
// childRowHtml verbatim (same row markup as a workflow worker's spine, full-view
// override included) — nesting reads from position + the connector line's
// --line-color alone (see styles.css .child-spine), not a distinct accent or class.
function childSpineHtml(children, ctx, { focusMode } = {}) {
  if (!children.length) return '';
  return `<div class="child-spine">${children.map((c) => childRowHtml(c, ctx, { focusMode })).join('')}</div>`;
}

// Claude Code assigns each "agent team" member a colour name (--agent-color).
// Map the ones we have a semantic CSS var for (defined in both themes, see
// styles.css) so the dot carries the member's identity; anything unmapped falls
// back to the neutral border colour — never a hardcoded hex (CLAUDE.md).
const AGENT_COLOR_VARS = {
  blue: '--blue', green: '--green', red: '--red',
  purple: '--purple', magenta: '--purple', pink: '--purple',
  cyan: '--cyan', teal: '--cyan',
};
function agentAccentVar(color) {
  return AGENT_COLOR_VARS[String(color || '').toLowerCase()] || '--border';
}

// One live "agent team" member on the lead's spine. NOT a wrangler session: it
// shares the lead's tmux (its own pane), has no card id, and isn't attachable —
// so it carries data-lead-sid (a click focuses the lead, attaching the shared
// session) rather than data-sid. The dot is tinted by the member's Claude colour
// (identity) and throbs while working; the one-word status reads working/idle
// only (a team member writes no status file, so there's no needs-you signal).
export function teammateRowHtml(t, leadSid, now) {
  const status = t.status || 'unknown';
  const word = STATUS_WORDS[status] || status;
  const typeLabel = t.agentType && t.agentType !== t.name ? t.agentType : '';
  const throb = status === 'working' ? `;--throb-delay:-${now % 1100}ms` : '';
  const title = typeLabel ? `${t.name} · ${typeLabel}` : t.name;
  // Rides on .worker-row for the spine connector + row layout; .team-row marks it
  // as a non-session (own dot colour, no card-menu/attach — see app.js).
  return `<div class="worker-row team-row ${esc(status)}" data-lead-sid="${esc(leadSid)}" style="--agent-accent:var(${agentAccentVar(t.color)})${throb}" title="${esc(title)}" role="button" tabindex="0">
    <span class="team-dot"></span>
    <span class="worker-name">${esc(t.name)}</span>
    ${typeLabel ? `<span class="team-type">${esc(typeLabel)}</span>` : ''}
    <span class="worker-status">${esc(word)}</span>
  </div>`;
}

// The team spine under a lead: an always-visible spine (same connector language
// as .child-spine) of the lead's live team members. Empty when the session runs
// no team. Rendered for any lead, whether or not it is also a workflow.
export function teamSpineHtml(lead, ctx) {
  const team = lead.teammates || [];
  if (!team.length) return '';
  return `<div class="team-spine">${team.map((t) => teammateRowHtml(t, lead.sessionId, ctx.now)).join('')}</div>`;
}

// A parent card + its plain child-spine, wrapped in one element (mirrors
// .workflow-box wrapping the orchestrator + its spine). Without this wrapper
// the two would be independent top-level siblings of .task-body — harmless
// under the normal board's single-column flex layout, but #grid.focus-mode
// .task-body switches to a multi-column CSS grid (auto-fit), where every
// top-level child is its own auto-placed grid item; the card and its spine
// then land in whatever column the grid's row-major placement happens to put
// them, visibly detaching a parent from its children. Wrapping them keeps
// them one grid item regardless of column count. No border/background/padding
// of its own (see .child-spine) — purely a grouping box, invisible in the
// normal flex layout where it changes nothing.
// Carries the parent's own data-sid + draggable="true" — it is now the actual
// drag/reorder unit in app.js (the card inside is rendered non-draggable via
// `nested`, same split as .workflow-box/its orchestrator card). Without this,
// the group has no data-sid at all: app.js's drop-handler DOM walk can't see it
// (dropped from the reordered array entirely) and dragging the inner card alone
// inserts the placeholder into the wrong parent — the two bugs behind a
// parent-with-children silently sinking to the bottom of its task on any drag.
function childGroupHtml(card, s, children, ctx, opts = {}) {
  const spine = childSpineHtml(children, ctx, opts);
  const team = teamSpineHtml(s, ctx);
  return (spine || team) ? `<div class="child-group" data-sid="${esc(s.sessionId)}" draggable="true">${card}${spine}${team}</div>` : card;
}

// Assemble a tile's active cards, folding each parent + its present children
// together. A child is pulled out of the flat flow and drawn on its parent's
// spine; an orphan child (its parent not in this tile) falls back to a plain card
// so it is never lost. An orchestrator parent (isWorkflowRun) keeps today's violet
// workflow box; any other parent gets a plain always-visible child spine. Order
// follows `active` — the parent's slot fixes where its group lands, and children
// keep their order within the spine.
//
// Nesting renders one level deep (a box/card + its own spine of compact rows) —
// a spine row has no room to draw its OWN nested spine. Chaining (a child of a
// child — now possible per the child-sessions design §2) is still handled
// correctly via workflow.js's computeAbsorption (recursive, cycle-safe): a
// session only folds into its parent's spine when that parent itself renders
// top-level. A grandchild whose immediate parent is itself absorbed elsewhere is
// promoted to its own top-level card (with its own spine, if it has children)
// instead of being silently dropped — every session in `active` renders exactly
// once. The same helper feeds layout.js's tile-height weighting (and, via
// sessionGroups, app.js's keyboard-nav order), so the rendered spine and the
// height reserved for it — and where the keyboard thinks a row is — can never
// drift apart.
export function renderTileCards(active, ctx, opts = {}) {
  return sessionGroups(active).map(({ session: s, children }) => {
    // A live agent team hangs off the lead as its own spine, independent of the
    // parentSession child spine (a lead can have both). The workflow box already
    // wraps its own child spine, so a team is appended alongside it in one group.
    const hasTeam = (s.teammates?.length || 0) > 0;
    if (isWorkflowRun(s)) {
      const box = workflowBoxHtml(s, children, ctx, { ...opts, nested: hasTeam });
      const team = teamSpineHtml(s, ctx);
      return team ? `<div class="child-group" data-sid="${esc(s.sessionId)}" draggable="true">${box}${team}</div>` : box;
    }
    const nested = children.length > 0 || hasTeam;
    return childGroupHtml(sessionCardHtml(s, ctx, { expanded: opts.focusMode, nested }), s, children, ctx, opts);
  }).join('');
}

// One asleep session: a greyed, name-only row with an amber wake-time chip.
export function snoozedRowHtml(s) {
  const label = wakeLabel(s.snooze.until, Date.now());
  const wakeBtn = `<button class="snooze-wake" data-sid="${esc(s.sessionId)}" title="Wake now"><span class="wake-moon">${MOON_ICON}</span><span class="wake-sun">${WAKE_ICON}</span></button>`;
  const wakeChip = `<span class="snooze-chip">${CLOCK_ICON}${esc(label)}</span>`;
  return `<div class="snoozed-row" data-sid="${esc(s.sessionId)}" draggable="true">
    ${wakeBtn}
    <span class="snoozed-name">${esc(s.label)}</span>
    ${wakeChip}
  </div>`;
}

export function todoRowHtml(td, key) {
  const spawn = `<button class="todo-spawn" title="Start a session from this TODO"><span class="todo-tick">${CHECK_ICON}</span><span class="todo-play">${SPAWN_ICON}</span></button>`;
  const del = `<button class="todo-del" title="Delete TODO">${X_ICON}</button>`;
  return `<div class="todo-row" data-todoid="${esc(td.id)}" data-todo-key="${esc(key)}" draggable="true">
    ${spawn}<span class="todo-text">${esc(td.text)}</span>${del}
  </div>`;
}

// The todo zone: divider + rows when todos exist, plus an empty anchor div the
// context-menu's inline-add injects into. No visible "+ todo" button.
export function todoZoneHtml(todos, key) {
  if (!todos.length) return `<div class="todo-zone" data-todo-key="${esc(key)}"></div>`;
  const rows = todos.map((td) => todoRowHtml(td, key)).join('');
  return `<div class="todo-divider"><span class="todo-label">todo</span></div>${rows}<div class="todo-zone" data-todo-key="${esc(key)}"></div>`;
}

export function tileHtml(tile, ctx, { focusMode } = {}) {
  const pos = focusMode ? '' : `grid-column:${tile.col + 1}; grid-row:${tile.rowStart + 1} / span ${tile.span};`;
  if (tile.kind === 'placeholder') {
    return `<div class="task-placeholder" style="${pos}"></div>`;
  }
  const active = tile.sessions.filter((s) => ctx.phaseOf(s) !== 'asleep');
  const asleep = tile.sessions.filter((s) => ctx.phaseOf(s) === 'asleep');
  const cards = renderTileCards(active, ctx, { focusMode })
    + (asleep.length ? `<div class="snooze-divider"><span class="snooze-label">snoozed</span></div>${asleep.map((s) => snoozedRowHtml(s)).join('')}` : '');
  const todoKey = tile.kind === 'notask' ? ctx.ADHOC_ID : tile.task.id;
  const todos = ctx.todosFor(todoKey);
  const todoZone = todoZoneHtml(todos, todoKey);
  // Keyboard "new session" slot (Cmd+Shift+arrows lands here past the last card).
  // The lit target must sit where nav lands it — the *end* of the body — so on a
  // truly-empty tile we ring its big empty-state CTA, otherwise we append a compact
  // highlighted row after the cards (the small header button stays a plain mouse
  // affordance: ringing it read as nothing, since it sits at the top, not the end).
  const showEmpty = !cards && !todos.length;
  const slotSel = ctx.selectedNewSlot === todoKey;
  const newSess = `<button class="task-new-sess" title="New session in this task">${ROBOT_ICON}</button>`;
  const emptyBody = (hint) =>
    `<div class="cell-empty-body"><button class="empty-new-sess${slotSel ? ' selected' : ''}">${ROBOT_ICON}<span>New session</span></button><span class="empty-hint">${hint}</span></div>`;
  const slotRow = slotSel && !showEmpty
    ? `<button class="new-sess-row selected" title="New session in this task">${ROBOT_ICON}<span>New session</span></button>`
    : '';
  // Hide the empty-body hint when there are only todos — the tile is not truly empty.
  const body = (hint) => (cards || (todos.length ? '' : emptyBody(hint))) + slotRow + todoZone;
  if (tile.kind === 'notask') {
    return `<div class="task-cell no-task" data-entity="no-task" style="${pos}">
      <div class="task-head" draggable="true">
        <span class="task-name">Unassigned</span>
        ${newSess}
        <button class="task-actions-btn" title="Task actions">${KEBAB_ICON}</button>
      </div>
      <div class="task-body">${body('or drag sessions here to unassign')}</div>
    </div>`;
  }
  const taskLinks = tile.task.links || [];
  const linkBadge = taskLinks.length
    ? linkChipsHtml([taskLinks[0]], ctx)
      + (taskLinks.length > 1
        ? `<button class="link-overflow" data-overflow-links="${esc(JSON.stringify(taskLinks.slice(1)))}">+${taskLinks.length - 1}</button>`
        : '')
    : '';
  const restoredFlash = tile.task.id === ctx.restoredTaskId ? ' task-restored-flash' : '';
  return `<div class="task-cell${restoredFlash}" data-taskid="${esc(tile.task.id)}" style="${pos}">
    <div class="task-head" draggable="true">
      <span class="task-name" title="Double-click to rename">${esc(tile.task.name)}</span>
      ${linkBadge}
      ${newSess}
      <button class="task-actions-btn" title="Task actions">${KEBAB_ICON}</button>
    </div>
    <div class="task-body">${body('or drag a session here')}</div>
  </div>`;
}

export function ghostHtml(g) {
  return `<div class="new-task-drop" style="grid-column:${g.col + 1}; grid-row:${g.row + 1};">＋ new task</div>`;
}
