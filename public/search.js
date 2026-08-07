import { send, setPendingSelect, latestTasks, restoreTaskWithPrompt } from './app.js';
import { toast } from './toast.js';
import { openFork } from './modals.js';
import { timeAgo, truncate, fmtDuration } from './util.js';
import { buildBrowseBuckets, filterTasksByName, rowTitle } from './search-browse.js';

// The Search view: substring search across every conversation on disk, and — for
// an empty (or sub-2-char) query — a browse mode listing recent conversations in
// History-style time buckets. This view supersedes both the find-&-attach modal
// and the History view: every row carries the actions History had (Resume / Fork /
// Delete, task Restore), keyed on the CARD id, never the conversation id.
//
// Everything here is DOM-built, never innerHTML — the titles/paths/snippets are
// agent- and human-written text pulled straight off disk and are as untrusted as
// diff-view's hunk bodies (see CLAUDE.md). The one exception is the static
// empty-state markup this file owns outright.
//
// Rendering only ever touches #search-results; the input and its option controls
// are static markup in index.html, so a re-render can't steal focus or drop a
// keystroke mid-query.

const DEBOUNCE_MS = 90;
const MIN_QUERY = 2; // below this the server answers in browse mode

const HOUR = 3600e3;
const DAY = 24 * HOUR;
// Time facet → elapsed span; 0 means "Any time" (no since bound).
const TIME_RANGES = { any: 0, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

const state = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  role: 'all',     // all | user | assistant
  agent: 'all',    // all | claude | codex
  status: 'all',   // all | board | archived | offboard
  time: 'any',     // any | 24h | 7d | 30d
  requestId: 0,    // monotonic; a reply for an older id is stale and dropped
  building: false,
};

let debounce = null;
let inflightAt = 0;

const el = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
const fmtNum = (n) => (n || 0).toLocaleString();

// ── requests ───────────────────────────────────────────────────────────────

// The since bound is computed at fire() time, not stored, so a facet picked an
// hour ago still means "the last 24h from now" on the next keystroke.
function sinceMs() {
  const range = TIME_RANGES[state.time] || 0;
  return range ? Date.now() - range : 0;
}

// Always sends — a short query is a browse request (the server treats <2 chars
// as browse, filtering rows by whatever metadata the 0–1 chars match), so there
// is no idle short-circuit any more.
function fire() {
  const q = state.query.trim();
  const browse = q.length < MIN_QUERY;
  state.requestId++;
  inflightAt = performance.now();
  send({
    type: 'search',
    requestId: state.requestId,
    query: q,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    roles: state.role === 'all' ? null : [state.role],
    // 'task' isn't a transcript agent the server knows — it's a client-side view
    // that hides conversation rows entirely (see renderBrowse/renderResults), so
    // the server-side agent filter stays unset (same as 'all') to keep the index
    // stats/timing line accurate.
    agents: state.agent === 'all' || state.agent === 'task' ? null : [state.agent],
    status: state.status,
    since: sinceMs(),
    until: null,
    limit: browse ? 100 : 150,
  });
  const results = el('search-results');
  if (results && !results.childElementCount) renderIdle(browse ? 'Loading recent conversations…' : 'Searching…');
}

function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(fire, DEBOUNCE_MS);
}

// ── replies ────────────────────────────────────────────────────────────────

export function onSearchStatus(msg) {
  const wasBuilding = state.building;
  state.building = Boolean(msg.building);
  renderIndexLine(msg);
  if (msg.building && msg.progress) {
    const p = msg.progress;
    renderIdle(p.total ? `Indexing conversations — ${p.done}/${p.total} transcripts, ${fmtNum(p.records || 0)} messages so far…` : 'Building the search index…');
  } else if (wasBuilding) {
    // Only on the building → idle edge. A background top-up also reports status,
    // and re-firing on every one of those would have the view searching itself in
    // a loop for as long as the tab is open. Browse re-fires here too — the
    // indexing progress overwrote its rows above.
    fire();
  }
}

// An adopt that refused (unknown conversation, no codex on PATH, a resume the
// server wouldn't do) — hand the button back rather than leave it saying
// "Starting…" forever. Keyed on the conversation id, so a reply that arrives after
// a re-render still finds the right row, and one for a row that's gone is a no-op.
export function onAdoptFailed(msg) {
  const b = document.querySelector(`#search-results [data-adopt="${CSS.escape(String(msg.sessionId || ''))}"]`);
  if (!b) return;
  b.disabled = false;
  b.textContent = '↪ Start session';
}

// An adopt that landed. The view is on its way to the board, but re-run the
// request (browse or text) so coming back to Search shows the row as "Open on
// board" rather than a spent "Starting…" button — the server replies only after
// its rebuild, so the card is already in the graph enrich() reads.
export function onAdopted() {
  fire();
}

export function onSearchResults(msg) {
  // Out-of-order replies are normal when typing: only paint the newest.
  if (msg.requestId !== state.requestId) return;
  renderTiming(msg);
  if (msg.browse) renderBrowse(msg);
  else renderResults(msg);
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderIndexLine(msg) {
  const line = el('search-index');
  if (!line) return;
  if (msg.building) {
    const p = msg.progress;
    line.textContent = p && p.total ? `indexing ${p.done}/${p.total}…` : 'indexing…';
    return;
  }
  const parts = [];
  if (msg.records) parts.push(`${fmtNum(msg.records)} messages`);
  if (msg.docs) parts.push(`${fmtNum(msg.docs)} conversations`);
  if (msg.corpusBytes) parts.push(`${fmtBytes(msg.corpusBytes)} corpus`);
  if (msg.updatedAt) parts.push(`updated ${timeAgo(msg.updatedAt) || 'just now'}`);
  line.textContent = parts.join(' · ');
}

function renderTiming(msg) {
  const t = el('search-timing');
  if (!t) return;
  if (msg.browse) {
    const shown = (msg.groups || []).length;
    const total = msg.total || shown;
    t.textContent = shown < total
      ? `showing ${fmtNum(shown)} of ${fmtNum(total)} — narrow with a filter or query`
      : `${fmtNum(total)} conversation${total === 1 ? '' : 's'}`;
    return;
  }
  const roundTrip = inflightAt ? Math.round(performance.now() - inflightAt) : 0;
  if (!msg.matches) {
    t.textContent = `no matches · scanned ${fmtBytes(msg.scannedBytes)} in ${msg.ms.toFixed(1)} ms`;
    return;
  }
  // Server scan time and browser round-trip are reported separately: the first is
  // what the design controls, the second is what you actually feel.
  t.textContent =
    `${fmtNum(msg.matches)} match${msg.matches === 1 ? '' : 'es'} · ` +
    `scanned ${fmtBytes(msg.scannedBytes)} in ${msg.ms.toFixed(1)} ms (${msg.mode}${msg.workers ? `, ${msg.workers} workers` : ''}) · ` +
    `${roundTrip} ms round trip`;
}

function renderIdle(message) {
  const host = el('search-results');
  if (!host) return;
  host.textContent = '';
  const p = document.createElement('div');
  p.className = 'search-empty';
  p.textContent = message || 'Every message you and the agents exchanged is searchable — tool output is not.';
  host.appendChild(p);
}

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function whenNode(ts) {
  const when = document.createElement('span');
  when.className = 'search-when';
  when.textContent = ts ? timeAgo(ts) || '' : '';
  if (ts) when.title = new Date(ts).toLocaleString();
  return when;
}

// The action set for one conversation, browse row and hit group alike. A
// conversation is reachable in one of three states: live on the board, mapped
// but off it (archived, or a mapping whose transcript is gone — noTranscript),
// or never mapped at all (an ad-hoc CLI session, or one whose board entry is
// long gone). The third gets adopted — a card is minted for it and the
// conversation resumed into a fresh terminal — so a search hit is never a dead
// end. No card id to pend on until the server has minted one, so the jump to
// the board is deferred to the `adopted` reply (app.js). Everything sent to the
// server here uses g.cardId (the stable card handle), never the conversation id
// — see CLAUDE.md. Server refusals (e.g. a resume it won't do) surface via the
// existing toast path.
function appendActions(head, g) {
  if (g.cardId && g.onBoard) {
    const b = document.createElement('button');
    b.className = 'search-act';
    b.textContent = 'Open on board';
    b.addEventListener('click', () => { setPendingSelect(g.cardId); location.hash = `#session=${encodeURIComponent(g.cardId)}`; });
    head.appendChild(b);
  } else if (g.cardId) {
    const resume = document.createElement('button');
    resume.className = 'search-act';
    resume.textContent = 'Resume';
    resume.addEventListener('click', () => { setPendingSelect(g.cardId); send({ type: 'resume', sessionId: g.cardId }); toast('Resuming…'); });
    head.appendChild(resume);
    const fork = document.createElement('button');
    fork.className = 'search-act search-act--icon';
    fork.textContent = '⑂';
    fork.title = 'Fork into a new session';
    fork.addEventListener('click', () => openFork(g.cardId));
    head.appendChild(fork);
    const remove = document.createElement('button');
    remove.className = 'search-act search-act--icon';
    remove.textContent = '🗑';
    remove.title = 'Delete permanently';
    remove.addEventListener('click', () => {
      if (confirm(`Permanently remove "${truncate(rowTitle(g), 60)}"?\n\nThis deletes its record for good — it can no longer be resumed.`)) {
        send({ type: 'remove', sessionId: g.cardId });
        toast('Removed');
      }
    });
    head.appendChild(remove);
  } else {
    const b = document.createElement('button');
    b.className = 'search-act search-act--adopt';
    b.textContent = '↪ Start session';
    b.title = 'Put this conversation on the board and resume it in a new terminal';
    b.dataset.adopt = g.sessionId;
    b.addEventListener('click', () => {
      // Disabled on click: adopt is a launch, and a second one racing the first
      // would be answered from the same (now stale) result list. Re-enabled by
      // onAdoptFailed; a success navigates away from the view entirely.
      b.disabled = true;
      b.textContent = 'Starting…';
      send({ type: 'adopt-conversation', sessionId: g.sessionId });
      toast('Starting a session from this conversation…');
    });
    head.appendChild(b);
  }
}

// Snippet + highlight, built from text nodes. hitStart/hitChars are UTF-16
// offsets the server computed against the same string, so the right occurrence
// is highlighted even when the snippet contains several.
function snippetNode(hit) {
  const box = document.createElement('div');
  box.className = 'search-snippet';
  const text = hit.snippet || '';
  const start = Math.max(0, Math.min(hit.hitStart || 0, text.length));
  const end = Math.max(start, Math.min(start + (hit.hitChars || 0), text.length));
  if (hit.headTrimmed) box.appendChild(document.createTextNode('…'));
  box.appendChild(document.createTextNode(text.slice(0, start)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(start, end);
  box.appendChild(mark);
  box.appendChild(document.createTextNode(text.slice(end)));
  if (hit.tailTrimmed) box.appendChild(document.createTextNode('…'));
  return box;
}

function groupNode(g) {
  const card = document.createElement('div');
  card.className = 'search-group';

  const head = document.createElement('div');
  head.className = 'search-group-head';

  const title = document.createElement('div');
  title.className = 'search-group-title';
  title.textContent = rowTitle(g);
  head.appendChild(title);

  head.appendChild(chip(g.agent === 'codex' ? 'Codex' : 'Claude', `chip search-agent search-agent--${g.agent}`));
  if (g.task) head.appendChild(chip(g.task, 'chip search-task'));
  head.appendChild(chip(`${fmtNum(g.matches)} match${g.matches === 1 ? '' : 'es'}`, 'chip search-count'));

  const spacer = document.createElement('span');
  spacer.className = 'search-spacer';
  head.appendChild(spacer);

  appendActions(head, g);
  card.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'search-group-sub';
  sub.textContent = `📁 ${g.cwd || '—'}${g.branch ? ` · ${g.branch}` : ''}`;
  card.appendChild(sub);

  for (const h of g.hits) {
    const row = document.createElement('div');
    row.className = `search-hit search-hit--${h.role}`;
    const meta = document.createElement('div');
    meta.className = 'search-hit-meta';
    meta.appendChild(chip(h.role === 'user' ? 'You' : 'Agent', `chip search-role search-role--${h.role}`));
    meta.appendChild(whenNode(h.ts));
    row.appendChild(meta);
    row.appendChild(snippetNode(h));
    card.appendChild(row);
  }
  return card;
}

// A hitless conversation row: browse mode's unit, and text mode's metadata-only
// matches. Same .search-group frame as a hit group, but denser (.search-row) —
// no snippet body, one meta line, and the actions inline on the head.
// `parentTitle` (browse only) is a breadcrumb for a session whose archived
// parent exists but landed in a different time bucket — see search-browse.js —
// so the relationship isn't silently lost just because it couldn't be nested.
// `hideTaskChip` drops the redundant task chip for a row already rendered under
// a task-group heading of the same name (see taskGroupHeadingNode).
function browseRowNode(g, { parentTitle, hideTaskChip } = {}) {
  const card = document.createElement('div');
  card.className = 'search-group search-row';

  const head = document.createElement('div');
  head.className = 'search-group-head';

  const title = document.createElement('div');
  title.className = 'search-group-title';
  title.textContent = rowTitle(g);
  head.appendChild(title);

  head.appendChild(chip(g.agent === 'codex' ? 'Codex' : 'Claude', `chip search-agent search-agent--${g.agent}`));
  if (g.task && !hideTaskChip) head.appendChild(chip(g.task, 'chip search-task'));
  if (g.model) head.appendChild(chip(g.model, 'chip search-model'));
  if (g.isWorkflow) head.appendChild(chip('⚙ workflow', 'chip search-wf'));
  if (g.archived) {
    const dur = fmtDuration(g.archivedAt && g.createdAt ? g.archivedAt - g.createdAt : 0);
    if (dur) head.appendChild(chip(`ran ${dur}`, 'chip search-dur'));
  }

  const spacer = document.createElement('span');
  spacer.className = 'search-spacer';
  head.appendChild(spacer);

  head.appendChild(whenNode(g.lastActivity));
  appendActions(head, g);
  card.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'search-group-sub';
  sub.textContent = `📁 ${g.cwd || '—'}${g.branch ? ` · ${g.branch}` : ''}${parentTitle ? ` · ↳ ${parentTitle}` : ''}`;
  card.appendChild(sub);
  return card;
}

// The archived children (one level deep — see foldSameBucketChildren) nested
// under a parent row: an indented stack, each child independently
// resumable/forkable/deletable like any other row. Nesting reads from the
// indent alone (see styles.css) — no connector line.
function childrenNode(children, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'search-children';
  for (const c of children) wrap.appendChild(browseRowNode(c, opts));
  return wrap;
}

// An archived-task row (the whole task was set aside — taskStore.archiveTask).
// Client-side merge: the server's index knows nothing about tasks, so these come
// straight off latestTasks and are bucketed by their own archivedAt.
function taskRowNode(t) {
  const card = document.createElement('div');
  card.className = 'search-group search-row search-row--task';

  const head = document.createElement('div');
  head.className = 'search-group-head';

  head.appendChild(chip('Task', 'chip search-task-flag'));

  const title = document.createElement('div');
  title.className = 'search-group-title';
  title.textContent = t.name || t.id;
  head.appendChild(title);

  const spacer = document.createElement('span');
  spacer.className = 'search-spacer';
  head.appendChild(spacer);

  head.appendChild(whenNode(t.archivedAt));

  const restore = document.createElement('button');
  restore.className = 'search-act';
  restore.textContent = 'Restore';
  restore.title = 'Restore task to the board';
  restore.addEventListener('click', () => restoreTaskWithPrompt(t.id, t.name));
  head.appendChild(restore);

  card.appendChild(head);
  return card;
}

// The heading over a task's rows within one time bucket — either a cluster of
// ≥2 same-task rows (see foldTaskGroups; a singleton stays headingless, its
// own inline task chip already says which task it's in) or a task-archive
// marker + its nested cascade-archived sessions, which always gets one since
// the marker IS the task. Sticky (see styles.css) so it stays visible while
// its own rows scroll past.
function taskGroupHeadingNode(name, count) {
  const div = document.createElement('div');
  div.className = 'search-task-heading';
  // The pill carries the tint/shape; the outer div stays a plain full-width
  // bar with a solid backdrop, since IT'S what needs to stay opaque while
  // stuck — a translucent pill wouldn't cover the rows scrolling underneath.
  const pill = document.createElement('span');
  pill.className = 'search-task-pill';
  pill.textContent = `▦ ${name}`;
  div.appendChild(pill);
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(count);
  div.appendChild(n);
  return div;
}

// One row (browseRowNode) plus, if it has same-bucket archived children or a
// cross-bucket parent breadcrumb, whatever search-browse.js attached to it.
function sessionEntryNode(entry, opts) {
  const frag = document.createDocumentFragment();
  frag.appendChild(browseRowNode(entry.group, { parentTitle: entry.parentTitle, ...opts }));
  if (entry.children?.length) frag.appendChild(childrenNode(entry.children));
  return frag;
}

// Render one buildBrowseBuckets row: a task-archive marker (+ its nested
// cascade-archived sessions), a task-group cluster (heading + rows), or a lone
// session (+ its own nested children / parent breadcrumb).
function browseRowUnitNode(r) {
  if (r.kind === 'task') {
    const wrap = document.createElement('div');
    wrap.className = 'search-task-cluster';
    wrap.appendChild(taskGroupHeadingNode(r.task.name || r.task.id, 1 + r.nested.length));
    wrap.appendChild(taskRowNode(r.task));
    if (r.nested.length) wrap.appendChild(childrenNode(r.nested));
    return wrap;
  }
  if (r.kind === 'task-group') {
    const wrap = document.createElement('div');
    wrap.className = 'search-task-cluster';
    wrap.appendChild(taskGroupHeadingNode(r.taskName, r.entries.length));
    for (const e of r.entries) wrap.appendChild(sessionEntryNode(e, { hideTaskChip: true }));
    return wrap;
  }
  return sessionEntryNode(r);
}

// Archived tasks that belong in the current result set: only under the All /
// Archived status facets (a task is by definition not "on board" or a bare
// transcript), only under the All / Task agent facets (a task isn't tied to one
// agent — it can hold both Claude and Codex sessions — so a Claude/Codex filter
// must not pull in unrelated task rows), inside the time facet's window, and —
// when there's a query — only when every whitespace token matches the task name
// (same AND semantics History's filter used). The empty browse query passes
// everything through.
function matchingArchivedTasks() {
  if (state.status !== 'all' && state.status !== 'archived') return [];
  if (state.agent !== 'all' && state.agent !== 'task') return [];
  let tasks = (latestTasks.tasks || []).filter((t) => t.archivedAt);
  const since = sinceMs();
  if (since) tasks = tasks.filter((t) => (t.archivedAt || 0) >= since);
  return filterTasksByName(tasks, state.query);
}

function bucketHeadNode(b) {
  const head = document.createElement('div');
  head.className = 'search-bucket';
  const label = document.createElement('span');
  label.textContent = b.label;
  head.appendChild(label);
  const rule = document.createElement('span');
  rule.className = 'rule';
  head.appendChild(rule);
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(b.rows.length);
  head.appendChild(n);
  return head;
}

function renderBrowse(msg) {
  const host = el('search-results');
  if (!host) return;
  host.textContent = '';
  // The Task facet is a client-side view over archived tasks only — conversation
  // rows (and their truncation note, which describes the conversation total) are
  // suppressed entirely rather than filtered, since the server has no notion of
  // a "task" row to filter by.
  const taskOnly = state.agent === 'task';
  const groups = taskOnly ? [] : msg.groups;
  const buckets = buildBrowseBuckets(groups, matchingArchivedTasks(), Date.now());
  if (!buckets.length) {
    renderIdle(taskOnly ? 'No archived tasks match these filters.' : 'No conversations match these filters.');
    return;
  }
  const frag = document.createDocumentFragment();
  for (const b of buckets) {
    frag.appendChild(bucketHeadNode(b));
    for (const r of b.rows) frag.appendChild(browseRowUnitNode(r));
  }
  if (msg.truncated && !taskOnly) {
    const more = document.createElement('div');
    more.className = 'search-truncated';
    more.textContent = `Showing the ${fmtNum((msg.groups || []).length)} most recently active of ${fmtNum(msg.total)} — narrow with a filter or query.`;
    frag.appendChild(more);
  }
  host.appendChild(frag);
}

function dividerNode(text) {
  const div = document.createElement('div');
  div.className = 'search-divider';
  const label = document.createElement('span');
  label.textContent = text;
  div.appendChild(label);
  const rule = document.createElement('span');
  rule.className = 'rule';
  div.appendChild(rule);
  return div;
}

function renderResults(msg) {
  const host = el('search-results');
  if (!host) return;
  host.textContent = '';
  // The Task facet hides every conversation match (text-hit and metadata-only
  // alike) and shows only archived tasks whose name matches the query.
  const taskOnly = state.agent === 'task';
  // Scan groups come first (server order), then the appended metadata-only
  // groups (metaMatch, hits:[]) — rendered browse-style under a slim divider.
  const metaGroups = taskOnly ? [] : msg.groups.filter((g) => g.metaMatch && !(g.hits && g.hits.length));
  const hitGroups = taskOnly ? [] : msg.groups.filter((g) => !metaGroups.includes(g));
  const tasks = matchingArchivedTasks();
  if (!hitGroups.length && !metaGroups.length && !tasks.length) {
    renderIdle(taskOnly ? `No archived task matches "${msg.query}".` : `No conversation contains "${msg.query}".`);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const g of hitGroups) frag.appendChild(groupNode(g));
  if (msg.truncated && !taskOnly) {
    const more = document.createElement('div');
    more.className = 'search-truncated';
    more.textContent = `Showing the ${fmtNum(msg.shownHits)} most recent of ${fmtNum(msg.matches)} matches — narrow the query to see the rest.`;
    frag.appendChild(more);
  }
  if (metaGroups.length || tasks.length) {
    if (!taskOnly) frag.appendChild(dividerNode('Matched by title, path, or label'));
    for (const g of metaGroups) frag.appendChild(browseRowNode(g));
    for (const t of tasks) frag.appendChild(taskRowNode(t));
  }
  host.appendChild(frag);
}

// ── wiring ─────────────────────────────────────────────────────────────────

function segGroup(attr, onPick) {
  document.querySelectorAll(`#search .search-seg [data-${attr}]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.parentElement;
      group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      onPick(btn.dataset[attr]);
      fire();
    });
  });
}

export function initSearchView() {
  const input = el('search-input');
  if (!input) return;
  input.addEventListener('input', (e) => { state.query = e.target.value; schedule(); });
  input.addEventListener('keydown', (e) => {
    // Escape clears the query but keeps the view useful: an empty query is
    // browse mode, so re-fire rather than blanking the results.
    if (e.key === 'Escape') { e.preventDefault(); input.value = ''; state.query = ''; clearTimeout(debounce); fire(); }
    if (e.key === 'Enter') { clearTimeout(debounce); fire(); }
  });
  el('search-case').addEventListener('change', (e) => { state.caseSensitive = e.target.checked; fire(); });
  el('search-word').addEventListener('change', (e) => { state.wholeWord = e.target.checked; fire(); });
  segGroup('role', (v) => { state.role = v; });
  segGroup('agent', (v) => { state.agent = v; });
  segGroup('status', (v) => { state.status = v; });
  segGroup('time', (v) => { state.time = v; });
  el('search-reindex').addEventListener('click', () => {
    if (state.building) return;
    state.building = true;
    send({ type: 'search-reindex', rebuild: true });
    toast('Rebuilding the search index…');
  });
  renderIdle();
}

// Called by setView when the tab is opened: refresh the index line (and kick off
// the first build if this is a cold install), load the browse list (or re-run
// the current query), and put the cursor in the box.
export function onEnterSearchView() {
  send({ type: 'search-status' });
  fire();
  const input = el('search-input');
  if (input) { input.focus(); input.select(); }
}
