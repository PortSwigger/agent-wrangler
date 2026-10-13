// The chat view controller: mounts into the #chat-wrap slot beside #term-wrap,
// owns the poll loop, scroll anchoring and the composer.
//
// APPEND, NEVER RE-RENDER. renderPanel (app.js) already documents why
// reassigning innerHTML is a trap — it restarts the CSS throb mid-cycle and
// resets scroll. At a 2s cadence a full re-render would fight the reader
// continuously, so each reply appends nodes for its new events only.

import { groupChatEvents } from './chat-group.js';
import { createChatDom } from './chat-dom.js';
import { createRenderer } from './markdown-preview.js';
import { imageSources, imageMimeOf, sourceToFrame, MAX_IMAGES_PER_PASTE } from './clipboard-images.js';

export const POLL_MS = 2000;
// Send → "my own message is on screen" waits on two things: the TUI writing the
// turn to the transcript, and the next poll happening to fall after that write.
// The write is irreducible — measured ~330ms median for BOTH agents (Claude
// 316-424ms, Codex 231-829ms), and the same while the session is mid-turn, since
// a queued prompt is persisted immediately. The scheduling wait is not, and it
// dominated: worse than POLL_MS suggests, because a tick landing inside the write
// window finds nothing and costs a FULL further period, which is what put the
// measured end-to-end at ~2.3s rather than 2s.
//
// So a send brings these extra polls forward. The first is deliberately BELOW the
// median write: a poll that finds nothing costs one incremental read (15-34ms
// even against a 32MB transcript, since the window read is bounded) while one
// that lands early saves a whole period — so "too early" is the cheap direction
// to be wrong in. The last stays inside one period, so a burst can never outlive
// the interval it front-runs. Exported for the test that pins those invariants.
export const SEND_BURST_MS = [220, 440, 700, 1050, 1450];
const BOTTOM_SLACK_PX = 40;

// Mail delivery and PR/merge nudges are pasted into the pane as an ordinary
// prompt (mail-notification.js, notifier.js) and deliberately render on
// screen as a normal user bubble — CLAUDE.md's mailbox bullet is explicit
// that `[Agent Wrangler] …` content really was delivered into the session and
// belongs there. But none of it is something the human actually typed, so the
// jump pill must skip it rather than treating a mail ping as "your last
// message". Exported for the unit test.
export const AGENT_WRANGLER_NOTICE_PREFIX = '[Agent Wrangler]';
export function isHumanTypedUserItem(item) {
  return !String(item.event?.text || '').startsWith(AGENT_WRANGLER_NOTICE_PREFIX);
}

const LEADING_IMAGE_MARKER = /^\[Image #\d+\]\s*/;

// Whether a transcript user event is the recording of a locally echoed prompt.
export function echoMatchesEvent(echo, event) {
  // Mounting reads a window of history, which may hold an older prompt with the
  // same words ("yes", "continue") — only one recorded after the send is ours.
  if (Number.isFinite(event.ts) && event.ts < echo.sentAt - 2000) return false;
  let text = String(event.text || '').trim();
  if (text === echo.text) return Boolean(text) || echo.images.length === 0 || (Array.isArray(event.images) && event.images.length > 0);
  // The TUI prepends one `[Image #N]` marker per attachment, so at most that many
  // leading markers are dropped; any the human typed themselves stay in the prose.
  for (let i = 0; i < echo.images.length && LEADING_IMAGE_MARKER.test(text); i += 1) {
    text = text.replace(LEADING_IMAGE_MARKER, '').trim();
    if (text === echo.text) return true;
  }
  return false;
}

export function initChatView({ send, onSubagentClick, onOpenDiff, onGoTerminal, onPickModel, onOpenFile, cwdFor } = {}) {
  const wrap = document.getElementById('chat-wrap');
  const stream = document.getElementById('chat-stream');
  // The base directory a relative `.md` path linkifies against — read through
  // app.js rather than held here, so it is always the cwd of the session on
  // screen right now and there is no per-session field to keep in step. The same
  // getter serves both halves of the view, because the human's plain-text bubble
  // and the agent's rendered markdown must linkify identically.
  const baseDir = () => (sessionId ? cwdFor?.(sessionId) : null) || null;
  const dom = createChatDom({
    renderMarkdown: createRenderer(window.markdownit, { mdPathBase: baseDir }),
    baseDir,
  });

  // One delegated pair of handlers for every markdown-file control in the stream:
  // the user bubble's controls are built by chat-dom, but the ones inside
  // assistant prose come from a renderer rule and never pass through
  // appendItems, so per-node wiring could not reach them. The keydown half is
  // not optional — the control is a href-less anchor, so nothing activates it
  // from the keyboard on its own.
  const openMdPath = (e) => {
    const hit = e.target?.closest?.('[data-md-path]');
    if (!hit) return;
    e.preventDefault();
    onOpenFile?.(hit.dataset.mdPath);
  };
  stream.addEventListener('click', openMdPath);
  stream.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') openMdPath(e);
  });

  let sessionId = null;
  let offset = null;
  let timer = null;
  // The pending burst, cancelled by anything that puts `offset` back to null —
  // mount, unmount and a rewind rebuild all re-read the window from the top, and
  // a burst poll landing in that gap would ask for a second full window instead
  // of the increment it was scheduled for.
  let burst = [];
  // The server's branch epoch for the conversation on screen (see chat.js). A
  // Claude transcript is a tree: a rewind in the pane retroactively turns turns
  // already appended here into a dead branch, and an append-only stream has no
  // way to express that. So the server moves this counter instead and the stream
  // is rebuilt from a fresh window read. null until the first reply, so the
  // opening value is adopted rather than read as a change.
  let epoch = null;
  // Bumped on every mount/unmount so an in-flight reply from a closed-then-reopened
  // session (same session id, different era) can be told apart from one belonging
  // to what's on screen now — the session-id check alone can't see this, since
  // reopening the same session leaves the id unchanged. Sent as `token` on every
  // request and echoed back verbatim by chat.js, so onChatReply can compare it
  // against the CURRENT generation directly — no arrival-order assumption needed
  // (concurrent `chat` requests aren't serialized server-side and can complete
  // out of order; an earlier design queued generations by send order and got
  // this exact case backwards under reordering).
  let generation = 0;

  // The sibling of `generation`, and the era for ANY in-flight client→server round
  // trip — an image upload and the interrupt's restore today. Lives here beside
  // generation rather than next to either of its users, because the whole point is
  // that it is NOT generation and a reader comparing the two should see them
  // together.
  //
  // Bumped only on mount/unmount. generation ALSO moves when a rewind rebuilds the
  // stream (rebuildStream), and a request in flight at that moment still belongs to
  // the reader, whose composer the rebuild deliberately leaves alone — sharing
  // generation would silently drop the image they had just pasted. Anything else
  // added later must stamp itself with THIS counter, which is why it is named for
  // the round trip and not for pastes.
  let requestEra = 0;

  // Declared here (factory scope), not inside submit() — setStatus and a later
  // task both need to reach `input` to drive its placeholder/disabled state.
  const input = document.getElementById('chat-input');
  const isMac = /Mac/i.test(window.navigator?.userAgentData?.platform || window.navigator?.platform || '');
  document.addEventListener('keydown', (e) => {
    if (!isMac || !sessionId || wrap.hidden || e.defaultPrevented || e.isComposing || e.repeat) return;
    if (e.key.toLowerCase() !== 'c' || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const active = document.activeElement;
    if (active !== document.body && !wrap.contains(active)) return;
    if (active === input && input.selectionStart !== input.selectionEnd) return;
    const selection = window.getSelection?.();
    if (!selection || !stream.contains(selection.anchorNode) || !stream.contains(selection.focusNode)) return;
    if (!selection.toString()) return;
    if (document.execCommand('copy')) e.preventDefault();
  });
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');
  const hint = document.getElementById('chat-hint');
  const suggestionBtn = document.getElementById('chat-suggestion');
  const modelEl = document.getElementById('chat-current-model');
  const attachEl = document.getElementById('chat-attachments');
  const jumpNav = document.getElementById('chat-jump-nav');
  const jumpPrevBtn = document.getElementById('chat-jump-prev');
  const jumpNextBtn = document.getElementById('chat-jump-next');
  const exitNoticeEl = document.getElementById('chat-exit-notice');

  // s.exitOutput (state-reader.js) off the graph node — the one thing this view
  // shows that is neither transcript-sourced nor pane-scraped, because a dead
  // pane can't be scraped and the transcript never records why the process
  // exited. Mirrors the terminal panel's own exitOutput block (renderSidebar,
  // app.js), which is the ONLY other place this text was ever shown — a Codex
  // self-update quitting the process was invisible from here otherwise, with
  // nothing to explain a session that just stopped responding.
  function renderExitNotice(text) {
    exitNoticeEl.hidden = !text;
    exitNoticeEl.textContent = ''; // rebuild rather than accumulate children.
    if (!text) return;
    const head = document.createElement('p');
    head.className = 'chat-exit-notice-head';
    // Same trailing label the terminal panel uses (renderSidebar, app.js) —
    // kept as one literal string in both places (not a shared helper, since
    // the two build their DOM completely differently: innerHTML there,
    // createElement/textContent here) so the two views can't quietly drift
    // apart on what is otherwise identical data. The leading sentence is
    // chat-only: the terminal panel already frames this ("its previous
    // terminal exited") in a paragraph above its own block, which the chat
    // view has no equivalent of.
    // Neutral, not "unexpectedly" — a clean `/exit` produces the same
    // exitOutput a crash does (state-reader.js doesn't distinguish them), and
    // the terminal panel's own wording ("its previous terminal exited") is
    // equally neutral for the same reason.
    head.textContent = "This session's terminal exited. Last output from the exited terminal:";
    exitNoticeEl.appendChild(head);
    const body = document.createElement('pre');
    body.className = 'term-exit';
    body.textContent = text;
    exitNoticeEl.appendChild(body);
  }

  // Every human-typed `chat-user` node, oldest first, so the jump buttons can
  // step between them. Reset wherever the stream itself is cleared (mount,
  // unmount, rebuildStream) — otherwise it would dangle at nodes no longer in
  // the document.
  let userEls = [];

  // Wider than .chat-user's scroll-margin-top (20px): a message the last jump
  // landed on sits that far below the top edge and must not count as "next".
  const NAV_SLACK_PX = 28;

  // getBoundingClientRect rather than offsetTop/scrollTop math: the stream is
  // position:absolute inside .chat-stream-wrap (see styles.css) so this stays
  // correct regardless of that positioning, and it degrades safely (guarded
  // below) against the test suite's DOM stub, which has neither.
  function navTargets() {
    const none = { prev: null, next: null };
    if (!userEls.length || typeof stream.getBoundingClientRect !== 'function') return none;
    const sr = stream.getBoundingClientRect();
    let prev = null;
    let next = null;
    for (const el of userEls) {
      if (typeof el.getBoundingClientRect !== 'function') return none;
      const top = el.getBoundingClientRect().top - sr.top;
      if (top < -NAV_SLACK_PX) prev = el;
      else if (top > NAV_SLACK_PX && !next) next = el;
    }
    // Scrolling is clamped at the bottom, so stepping "down" there would
    // leave the view where it is and the button would look dead.
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 1) return { prev, next: null };
    // Past the last user message, down means the end of the conversation.
    return { prev, next: next || 'bottom' };
  }

  function updateJumpVisibility() {
    const { prev, next } = navTargets();
    jumpPrevBtn.disabled = !prev;
    jumpNextBtn.disabled = !next;
    jumpNav.hidden = !prev && !next;
  }
  stream.addEventListener('scroll', updateJumpVisibility);

  function jumpTo(target) {
    if (!target) return;
    if (target === 'bottom') {
      // Instant, not smooth: a poll landing mid-animation would see us not
      // yet at the bottom and stop auto-following, stranding the view short.
      stream.scrollTop = stream.scrollHeight;
      updateJumpVisibility();
      return;
    }
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    target.classList?.remove('chat-jump-target');
    void target.offsetWidth; // restart the animation if pressed again mid-pulse
    target.classList?.add('chat-jump-target');
    // `target` is captured so a later press only ever clears the bubble it
    // pulsed, not whichever one is current when the timeout fires.
    setTimeout(() => target.classList?.remove('chat-jump-target'), 950);
    updateJumpVisibility();
  }
  jumpPrevBtn.addEventListener('click', () => jumpTo(navTargets().prev));
  jumpNextBtn.addEventListener('click', () => jumpTo(navTargets().next));

  wrap.addEventListener('click', (e) => {
    if (input.contains(e.target)) return;
    if (e.target.closest('a, button, input, textarea, select, [role="button"], [tabindex]')) return;
    if (e.target.closest('.chat-subagent')) return;
    if (window.getSelection?.()?.toString()) return;
    input.focus();
  });

  // Attachments are held as SERVER-MINTED NAMES, never paths, and never in the
  // textarea. Two independent reasons, both load-bearing:
  //  - the path has to reach the pane as its own isolated paste (a path inside
  //    multi-line prose stays literal text the model cannot see), so it must not
  //    be mixed into the prose here;
  //  - the name is all the server will accept back, so a value from this page can
  //    never be turned into an arbitrary path for the agent to read.
  let attachments = [];

  // The composer is ONE textarea shared by every session, so its value has to be
  // swapped explicitly on mount/unmount — resetting the state variables around it
  // is not enough. Without this, a draft (typed, or restored by Esc) stayed on
  // screen when the reader switched cards and could be SENT to the wrong session:
  // reproduced on a real board, where a prompt entered against one session was
  // still in the box, with Send enabled, after opening a sibling session. It also
  // produced the reported Esc symptom, because interruptAndRestore declines to
  // overwrite a non-empty box — so the carried-over draft masked the prompt the
  // reader was actually trying to recover.
  //
  // Held per card id rather than simply cleared, so switching away does not throw
  // away work in progress. Mirrored to localStorage so a reload (e.g. the UI
  // restarting for an update) does not lose a long message either.
  //
  // Attachments travel WITH the text, because a pasted image's filename is only
  // meaningful inside the session whose pastes folder holds it — restoring the
  // prose without them would silently drop the images it refers to, and carrying
  // them to a DIFFERENT session is the leak this whole store exists to stop.
  const DRAFTS_KEY = 'aw.chatDrafts';
  const DRAFTS_MAX = 50;
  function parseStoredDrafts(raw) {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1]?.text === 'string' && Array.isArray(e[1].attachments)) : [];
    } catch { return []; }
  }
  // Every read and write goes through storage rather than a private snapshot, so a
  // second board tab never overwrites this one's drafts (or resurrects a sent one)
  // from a stale copy. After a storage write fails, the in-memory map takes over
  // so drafts still survive card switches.
  class PersistedDrafts {
    constructor() { this.memory = null; }
    read() {
      if (this.memory) return this.memory;
      try { return new Map(parseStoredDrafts(localStorage.getItem(DRAFTS_KEY))); } catch { return new Map(); }
    }
    write(map) {
      while (map.size > DRAFTS_MAX) map.delete(map.keys().next().value);
      try { localStorage.setItem(DRAFTS_KEY, JSON.stringify([...map])); } catch { this.memory = map; }
    }
    get(k) { return this.read().get(k); }
    set(k, v) {
      const map = this.read();
      map.delete(k);
      map.set(k, v);
      this.write(map);
      return this;
    }
    delete(k) {
      const map = this.read();
      if (map.delete(k)) this.write(map);
    }
  }
  const drafts = new PersistedDrafts();

  // Set when THIS view interrupted a turn: the interrupt is what may leave a
  // restored prompt in the PANE's composer, so the next send must clear it. Armed
  // rather than inferred from a non-empty pane, because a draft the human typed
  // straight into the terminal is theirs and wiping it would be its own bug.
  let paneRestoreArmed = false;
  // The in-flight interrupt's token, and whether the composer already held
  // something when it was sent.
  let restoreToken = null;
  let restoreSeq = 0;
  let restoreOverDraft = false;
  let messageSeq = 0;
  const pendingMessages = new Map();
  // Local echoes of sent prompts, per session, newest last. Each is drawn the
  // moment Send is pressed (dashed) and stays until the transcript records the
  // prompt, which then replaces it. Held by session rather than by the DOM so
  // leaving the view (to the terminal, or another card) and coming back redraws
  // them; `node` is null whenever the stream they were drawn in has been cleared.
  const echoStore = new Map();
  const ECHO_MAX_AGE_MS = 60 * 60 * 1000;
  const echoList = () => echoStore.get(sessionId) || [];

  function detachEchoNodes() {
    for (const list of echoStore.values()) {
      for (const e of list) {
        e.node?.remove();
        e.node = null;
      }
    }
  }

  function removeEcho(echo) {
    echo.node?.remove();
    const list = (echoStore.get(echo.sessionId) || []).filter((e) => e !== echo);
    if (list.length) echoStore.set(echo.sessionId, list);
    else echoStore.delete(echo.sessionId);
    if (echo.sessionId === sessionId) pinTail();
  }

  function pruneEchoes() {
    const cutoff = Date.now() - ECHO_MAX_AGE_MS;
    for (const list of [...echoStore.values()]) for (const e of list) if (e.sentAt < cutoff) removeEcho(e);
  }

  // One tray holds every prompt sent but not yet recorded, so several queued
  // prompts read as a single waiting group rather than a run of separate messages.
  const queueTray = document.createElement('div');
  queueTray.className = 'chat-queue';
  const queueHead = document.createElement('div');
  queueHead.className = 'chat-queue-head';
  queueTray.appendChild(queueHead);

  // The tail of the stream is always the working row, then the tray. Queued
  // prompts belong after everything the agent is still producing, whatever order
  // the nodes were appended in.
  function pinTail() {
    if (live) stream.appendChild(live);
    const list = echoList();
    if (!list.length) {
      queueTray.remove();
      return;
    }
    for (const e of list) {
      if (!e.node) {
        e.node = dom.itemNode({
          type: 'user',
          event: { text: e.text, images: e.images.map((name) => ({ label: 'Image', name })) },
        });
        e.node.dataset.pending = e.state;
      }
      queueTray.appendChild(e.node);
    }
    const queued = list.filter((e) => e.state === 'queued').length;
    queueHead.textContent = queued
      ? `Queued · ${queued} waiting for the agent`
      : 'Sending…';
    stream.appendChild(queueTray);
  }

  const eventKey = (event) => `${event.ts}|${event.text}`;
  // Events that have already acknowledged a send, per session, so history replayed
  // by a remount cannot acknowledge a newer identical prompt.
  const ackedEvents = new Map();
  const ACKED_MAX = 200;

  function echoMatches(echo, item) {
    if (ackedEvents.get(echo.sessionId)?.has(eventKey(item.event || {}))) return false;
    return echoMatchesEvent(echo, item.event || {});
  }

  function noteAcked(sessionId, event) {
    const set = ackedEvents.get(sessionId) || new Set();
    set.add(eventKey(event));
    if (set.size > ACKED_MAX) set.delete(set.values().next().value);
    ackedEvents.set(sessionId, set);
  }

  function saveDraft(id) {
    if (!id) return;
    const text = input.value;
    if (text.trim() || attachments.length) drafts.set(id, { text, attachments: attachments.slice() });
    else drafts.delete(id);
  }

  function loadDraft(id) {
    const d = (id && drafts.get(id)) || null;
    input.value = d?.text ?? '';
    attachments = d?.attachments ? d.attachments.slice() : [];
    // Same reason loadComposer dispatches it: the auto-grow listener is what sizes
    // the box, and a programmatic value set does not fire input.
    input.dispatchEvent(new Event('input'));
  }

  // The live row's three inputs — the last reply's pending tool call, the
  // timestamp of the newest transcript line, and the last known session status
  // — arrive on separate asynchronous paths (onChatReply and setStatus), so all
  // three are held here and consulted together by renderLive() rather than
  // either call site deciding on its own partial view.
  let lastStatus = null;
  let lastWaitingReason = null;
  let lastPending = null;
  let lastTs = null;
  // Claude Code's suggested next prompt, scraped off the pane server-side (see
  // ghost-suggestion.js). Held like pending/lastTs because it too describes the
  // reply's own moment rather than any event.
  let lastSuggestion = null;
  // Two sources, deliberately kept apart. `graphModel` is the board's pill,
  // derived from the transcript's last assistant message — correct for a dormant
  // session but STALE right after a `/model` switch, which the transcript does
  // not record. `liveModel` is the label the pane's own status bar shows, which
  // is the only live source. The pane wins whenever it has an answer.
  let graphModel = null;
  let graphSwitchable = false;
  let liveModel = null;
  // Context-window occupancy has NO transcript-derived fallback (unlike the
  // model) — see server/control/handlers/chat.js. So there is only ever one
  // source, and it is null (chip hidden) whenever it cannot be read: a dormant
  // Claude card, a Claude statusline without a context component, or (for
  // Codex, whose value comes from the rollout+its own cached model metadata,
  // never a pane) a model missing from that cache.
  let liveContextPercent = null;
  // Built here rather than as static markup in index.html, same reasoning as
  // the live row in chat-dom.js: only the outer container needs a stable id,
  // and building the track/fill/label once means the render function only
  // ever touches a width, a text node and one data attribute.
  const contextBarEl = document.getElementById('chat-context-bar');
  const contextBarTrack = document.createElement('span');
  contextBarTrack.className = 'chat-context-bar-track';
  const contextBarFill = document.createElement('span');
  contextBarFill.className = 'chat-context-bar-fill';
  contextBarTrack.appendChild(contextBarFill);
  const contextBarLabel = document.createElement('span');
  contextBarLabel.className = 'chat-context-bar-label';
  contextBarEl.appendChild(contextBarTrack);
  contextBarEl.appendChild(contextBarLabel);

  function renderContextBar() {
    const pct = liveContextPercent;
    contextBarEl.hidden = pct == null;
    if (pct == null) return;
    contextBarFill.style.width = `${pct}%`;
    contextBarLabel.textContent = `${pct}%`;
    // Same 50%/70% thresholds as the terminal statusline bar this mirrors, so
    // the two surfaces never disagree about what "getting full" means.
    contextBarEl.dataset.level = pct < 50 ? 'ok' : pct < 70 ? 'warn' : 'danger';
    contextBarEl.setAttribute('title', `Context window ~${pct}% used`);
  }

  function renderModel() {
    const label = liveModel || graphModel?.label;
    modelEl.hidden = !label;
    if (!label) return;
    modelEl.textContent = label;
    // Only pressable when the switch would actually work — the server refuses a
    // non-idle, dormant or Codex session anyway, so offering the menu there
    // would just produce an error the user could have been spared. The reason
    // goes in the tooltip instead of leaving a dead-looking control.
    modelEl.disabled = !graphSwitchable;
    modelEl.dataset.switchable = graphSwitchable ? '1' : '0';
    // The board pill's `title` is the raw model id; the live label has no id of
    // its own, so it falls back to naming itself.
    const full = graphModel?.title || label;
    modelEl.setAttribute('title', graphSwitchable
      ? `${full} — click to switch model`
      : `${full} — switching needs an idle Claude session with a live terminal`);
  }
  // Created lazily and kept as the stream's last child while the session works.
  // It lives IN the stream, not above the composer where the old status line
  // sat: the complaint this answers is that the stream looks dead during a long
  // turn, and a line outside the stream does not fix a dead-looking stream. The
  // transcript records whole messages only — there is no partial line to read —
  // so this is the only liveness the view can honestly show between turns.
  let live = null;
  let tick = null;

  const plural = (n, unit) => `${n}${unit}`;
  // Mirrors the terminal's own elapsed format ("2s", "3m 23s") so the two
  // surfaces agree about the same session.
  function elapsedText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const total = Math.floor(ms / 1000);
    if (total < 60) return plural(total, 's');
    return `${plural(Math.floor(total / 60), 'm')} ${plural(total % 60, 's')}`;
  }

  // A pending entry alone is not enough to claim a tool is running: the
  // scanner's pending map is deliberately persistent across polls (so a
  // tool_use pairs with a tool_result arriving in a later window), which means
  // an ORPHANED entry — result never arriving because the pane was killed or
  // suspended mid-tool, or the call was interrupted by this view's own Stop
  // button — survives and would otherwise be reported forever. So the row's
  // PRESENCE is gated on the session's real status (the same signal that drives
  // stopBtn.hidden below), keeping it consistent with the Stop button instead of
  // contradicting it; a pending entry only ever decorates a row that status has
  // already justified.
  function liveLabel(pending) {
    if (!pending) return 'Working';
    return `${pending.name}${pending.target ? `: ${pending.target}` : ''}`;
  }

  // Every other needs-you reason (a permission prompt, OAuth, a Codex update
  // banner, a devcontainer failure) is a genuine terminal matter: Send is
  // disabled because a prompt typed here would land nowhere. An api-error
  // needs-you is different — the turn already ended cleanly and the pane is
  // idle, so a normal send is how you retry. Single source of truth for that
  // exception, shared by setStatus/renderSuggestion/renderSendability so they
  // can't drift on which needs-you reasons still block.
  function blockedByNeedsYou() {
    return lastStatus === 'needs-you' && lastWaitingReason !== 'api-error';
  }

  function renderLive() {
    if (lastStatus !== 'working') {
      clearInterval(tick);
      tick = null;
      live?.remove();
      live = null;
      return;
    }
    const stick = atBottom();
    if (!live) {
      live = dom.liveRow();
      // A 1s tick redraws the elapsed clock between the 2s polls. Started only
      // alongside the row so an idle session holds no timer at all.
      tick = setInterval(paintLive, 1000);
    }
    // Re-appended every render so it stays last even when this call follows an
    // appendItems that added nodes after it.
    pinTail();
    paintLive();
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function paintLive() {
    if (!live) return;
    live.querySelector('.chat-live-label').textContent = liveLabel(lastPending);
    // Measured from the newest transcript line, not from when this view
    // mounted — see the scanner's lastTs(). Blank rather than "0s" when the
    // server had no timestamp to give (an empty or unreadable transcript).
    live.querySelector('.chat-live-elapsed').textContent = lastTs ? elapsedText(Date.now() - lastTs) : '';
  }

  // Shared by the recap's next step and the pane suggestion: both are proposals,
  // so both LOAD the composer and neither sends. The human always gets the last
  // word on a prompt they did not write.
  function loadComposer(text) {
    input.value = text;
    input.disabled = false;
    input.focus();
    // Caret at the end, not a selection over the whole value: the point of
    // restoring a prompt is to amend it, and a full selection means the next
    // keystroke deletes it.
    try { input.setSelectionRange(text.length, text.length); } catch { /* not all inputs support it */ }
    // The composer auto-grows on `input`, which a programmatic value set does not
    // fire, so a multi-line suggestion would land in a one-row box that hides
    // most of itself.
    input.dispatchEvent(new Event('input'));
    scheduleDraftSave();
  }

  function renderSuggestion() {
    // Withheld while the composer holds anything, so pressing it can never
    // discard something the human was in the middle of writing — and while
    // blocked, when the composer is disabled and the only useful action is
    // answering the prompt in the pane.
    const show = Boolean(lastSuggestion) && !input.value.trim() && !blockedByNeedsYou() && !echoList().length;
    suggestionBtn.hidden = !show;
    if (show) suggestionBtn.textContent = lastSuggestion;
  }

  // An attached image is a complete prompt on its own (the TUI submits the bare
  // `[Image #1]`), so Send has to stay live for an empty box that holds one.
  let refocusInput = false;

  function renderSendability() {
    if (sessionId && pendingMessages.has(sessionId)) {
      // Disabling a focused field blurs it for good, so note it to hand focus back.
      if (document.activeElement === input) refocusInput = true;
      input.disabled = true;
      sendBtn.disabled = true;
      return;
    }
    if (blockedByNeedsYou()) return; // setStatus owns the button while blocked
    input.disabled = false;
    if (refocusInput) {
      refocusInput = false;
      // Only when focus is still nowhere: a click elsewhere meanwhile is the user's call.
      if (!document.activeElement || document.activeElement === document.body) input.focus();
    }
    sendBtn.disabled = !input.value.trim() && !attachments.length;
  }

  function submit() {
    const text = input.value.trim();
    if (!sessionId || pendingMessages.has(sessionId) || (!text && !attachments.length)) return;
    // The EXISTING human message path: live → paste into the pane, dormant →
    // wake and deliver, archived → refuse. Deliberately not the mailbox, which
    // is peer-only. Only NAMES go over the wire — the server resolves them back
    // to paths inside this session's own pastes folder.
    const requestId = `${requestEra}#${++messageSeq}`;
    const pending = { requestId, sessionId, clearComposer: paneRestoreArmed, draft: { text: input.value, attachments: attachments.slice() } };
    pendingMessages.set(sessionId, pending);
    if (pending.clearComposer) {
      paneRestoreArmed = false;
      restoreToken = null;
    }
    const sentAttachments = attachments;
    const accepted = send({
      type: 'message', sessionId, text,
      requestId,
      ...(attachments.length ? { imageNames: attachments.map((a) => a.name) } : {}),
      ...(pending.clearComposer ? { clearComposer: true } : {}),
    });
    if (!accepted) {
      pendingMessages.delete(sessionId);
      if (pending.clearComposer) paneRestoreArmed = true;
      setPasteNote('Not sent: connection unavailable.');
    } else {
      setPasteNote('Sending…');
      echoSent(pending, text, sentAttachments);
      input.value = '';
      input.style.height = 'auto';
      attachments = [];
      renderAttachments();
    }
    renderSendability();
  }

  function echoSent(pending, text, sentAttachments) {
    const echo = { sessionId: pending.sessionId, requestId: pending.requestId, text, images: sentAttachments.map((a) => a.name), sentAt: Date.now(), state: '1', node: null };
    pending.echo = echo;
    echoStore.set(echo.sessionId, [...echoList(), echo]);
    pinTail();
    stream.scrollTop = stream.scrollHeight;
    updateJumpVisibility();
    renderSuggestion();
  }

  sendBtn.addEventListener('click', submit);
  // Mimics pressing Esc in the pane: stop the turn, then hand the prompt back for
  // editing. The prompt is now RESOLVED BY THE SERVER and arrives as
  // `interrupt-restore`; this view no longer replays its own last-polled user
  // event, which is what made it hand back the PREVIOUS prompt whenever Esc beat
  // the 2s poll.
  //
  // Nothing is loaded here, only requested — the reply takes a moment, because the
  // server gives Claude Code a short window to restore the prompt into the pane,
  // which is the one source that can reflect an edit made in the terminal.
  function interruptAndRestore() {
    if (!sessionId) return;
    // Interrupting is what makes Claude Code restore the prompt into the PANE's
    // composer, and every send is a paste at the pane's cursor — so the next send
    // has to clear it first or the edited prompt fuses onto the original.
    paneRestoreArmed = true;
    // Stamped with requestEra for the same reason an upload is (see its
    // declaration). What actually drops a reply from a session this view has left
    // is restoreToken being nulled on mount/unmount; the prefix only keeps
    // successive tokens distinct.
    restoreToken = `${requestEra}#${++restoreSeq}`;
    // Whether a draft was already in the box is decided HERE, not when the reply
    // lands: by then the human may have started typing in response to the stop,
    // and a prompt they are part-way through must not be overwritten by a restore
    // they asked for a moment earlier.
    restoreOverDraft = Boolean(input.value.trim());
    send({ type: 'interrupt', sessionId, token: restoreToken });
    renderSuggestion();
  }

  stopBtn.addEventListener('click', interruptAndRestore);
  input.addEventListener('keydown', (e) => {
    // isComposing: an IME user (Japanese/Chinese/Korean) presses Enter to confirm
    // a composition, not to submit — without this guard that Enter fires submit()
    // before the composed text even lands in the field.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    // Escape only while the session is actually working, which is what the pane
    // does — and what keeps this from swallowing the key the rest of the app
    // uses to dismiss things. Scoped to the composer rather than the document
    // for the same reason.
    if (e.key === 'Escape' && !e.isComposing && lastStatus === 'working') {
      e.preventDefault();
      interruptAndRestore();
    }
  });
  let draftTimer = null;
  // Explicit rather than driven by every input event: mount's loadDraft dispatches
  // a synthetic input, and treating that hydration as an edit would file one
  // card's draft under another.
  function scheduleDraftSave() {
    if (!sessionId) return;
    clearTimeout(draftTimer);
    const id = sessionId;
    const era = requestEra;
    draftTimer = setTimeout(() => { if (sessionId === id && requestEra === era && !pendingMessages.has(id)) saveDraft(id); }, 400);
  }
  input.addEventListener('input', (e) => {
    if (e.isTrusted) scheduleDraftSave();
    input.style.height = 'auto';
    // An unrendered element (display:none somewhere above — the sidebar hidden by
    // the diff view's fullscreen, the pane hidden on unmount) reports scrollHeight
    // 0, and this listener runs in exactly those states via loadDraft/loadComposer.
    // Pinning 0px then outlives the hide: nothing re-measures when the pane comes
    // back unless a mount happens to, so the reader found an empty, unfocusable
    // strip where the box should be. Left at `auto`, rows="1" draws a real row.
    const measured = input.scrollHeight;
    if (measured) input.style.height = `${Math.min(measured, 140)}px`;
    // Typing withdraws the suggestion, and clearing the box brings it back.
    renderSuggestion();
    renderSendability();
  });

  // --- pasted images ---------------------------------------------------------
  // Cmd+V of an image in the pane works because Claude Code reads the HOST
  // clipboard itself, which a browser cannot reach: the bytes are in this page,
  // on possibly another machine. So the round trip is upload → the server writes
  // the file inside the session's own --add-dir → the path goes in the prompt →
  // the agent auto-attaches it. Verified against a live pane: a path inside
  // pasted prompt text becomes a real inline image, not a Read tool call.
  //
  // Tokens are era-stamped so a reply that lands after the view moved to another
  // session is dropped rather than typing a stale path into someone else's
  // composer. Same reasoning as the poll's token, different reply type, so
  // deliberately its own counter.
  let pasteSeq = 0;
  const pendingPastes = new Set();
  // Shown on the hint line instead of a toast: chat-view.js has no toast seam,
  // and the hint is already the place this view explains what the composer is
  // doing. Held rather than written directly because renderHint() rebuilds the
  // line from scratch on every status change and would otherwise erase it.
  let pasteNote = null;
  function setPasteNote(text) {
    pasteNote = text || null;
    renderHint();
  }

  function renderAttachments() {
    attachEl.hidden = !attachments.length;
    attachEl.textContent = ''; // rebuilt each time rather than accumulating children
    attachments.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'chat-attachment';
      const label = document.createElement('span');
      label.className = 'chat-attachment-label';
      // Numbered to match what the TUI will call it once pasted, so the chip and
      // the sent message agree.
      label.textContent = `Image #${i + 1}`;
      chip.appendChild(label);
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'chat-attachment-drop';
      // A mis-paste is easy and a screenshot is easy to confuse, so removing one
      // has to be possible without clearing the whole prompt.
      drop.setAttribute('aria-label', `Remove ${a.name}`);
      drop.setAttribute('title', 'Remove');
      drop.addEventListener('click', () => {
        attachments = attachments.filter((x) => x !== a);
        renderAttachments();
        renderSendability();
        scheduleDraftSave();
      });
      chip.appendChild(drop);
      attachEl.appendChild(chip);
    });
  }

  // Paste and drop share one path: both hand over a DataTransfer, and what a
  // source puts in it (see clipboard-images.js) does not depend on which gesture
  // delivered it.
  function attachFrom(e, dt) {
    if (!sessionId) return;
    const { sources, text } = imageSources(dt);
    // No image means an ordinary text paste or drop, which must fall through
    // untouched — preventDefault here would break pasting text.
    if (!sources.length) return;
    e.preventDefault();
    // Markup with an image in it (a copied selection) still carries words the
    // human meant to paste, and preventDefault just swallowed them.
    // setRangeText fires no input event, so raise one for the resize and Send.
    if (text) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
      scheduleDraftSave();
    }
    attachSources(sources);
  }

  function attachSources(sources) {
    const take = sources.slice(0, MAX_IMAGES_PER_PASTE);
    const skipped = sources.length - take.length;
    setPasteNote(take.length > 1 ? `Attaching ${take.length} images…` : 'Attaching image…');
    for (const source of take) {
      const token = `${requestEra}#${++pasteSeq}`;
      pendingPastes.add(token);
      sourceToFrame(source).then(
        (frame) => {
          // Gone stale while the image was being read or converted.
          if (!pendingPastes.has(token)) return;
          send({ type: 'paste-image', sessionId, token, ...frame });
        },
        (err) => {
          if (!pendingPastes.delete(token)) return;
          setPasteNote(err?.message || 'Could not read that image.');
        },
      );
    }
    if (skipped > 0) setPasteNote(`Attaching ${take.length} images — ${skipped} more were skipped.`);
  }

  // Ctrl+V is the terminal's paste key, and on macOS the browser fires no paste
  // event for it, so muscle memory from the terminal pasted nothing here.
  input.addEventListener('keydown', (e) => {
    if (!isMac || !sessionId || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v') return;
    if (!navigator.clipboard?.read) return;
    e.preventDefault();
    const id = sessionId;
    const era = requestEra;
    const current = () => sessionId === id && requestEra === era && !pendingMessages.has(id);
    navigator.clipboard.read().then(async (clipItems) => {
      if (!current()) return;
      const files = [];
      let text = '';
      for (const item of clipItems) {
        const imgType = item.types.find((t) => t.startsWith('image/'));
        if (imgType) files.push(new File([await item.getType(imgType)], 'paste', { type: imgType }));
        else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
      }
      if (!current()) return;
      if (files.length) attachSources(files.map((file) => ({ kind: 'file', file, mime: imageMimeOf(file) })));
      else if (text) {
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        scheduleDraftSave();
      }
    }).catch(() => setPasteNote('Clipboard access was blocked — use Cmd+V to paste.'));
  });

  input.addEventListener('paste', (e) => attachFrom(e, e.clipboardData));
  // The whole view is the drop target rather than just the composer, which is a
  // thin strip that is easy to miss with a file in hand. dragover has to cancel
  // for the drop to fire at all, but only when files are coming, so dragging
  // text around the composer keeps its native behaviour.
  wrap.addEventListener('dragover', (e) => {
    if (sessionId && Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  });
  wrap.addEventListener('drop', (e) => attachFrom(e, e.dataTransfer));

  modelEl.addEventListener('click', () => {
    if (!sessionId || modelEl.disabled) return;
    // The menu is app.js's business (it owns mountMenu and the agent registry);
    // this module only says where to put it, the same way the sub-agent and diff
    // hooks hand off rather than reach out.
    onPickModel?.(sessionId, modelEl.getBoundingClientRect());
  });
  suggestionBtn.addEventListener('click', () => {
    if (lastSuggestion) loadComposer(lastSuggestion);
    renderSuggestion();
  });
  // Status-driven, because Esc only does anything while a turn is running —
  // advertising it permanently would promise a key that mostly does nothing.
  function renderHint() {
    const base = 'Enter sends · Shift+Enter newline';
    const text = lastStatus === 'working' ? `${base} · Esc stops` : base;
    // The paste note replaces the hint rather than appending to it: it is
    // transient and specific, and two sentences competing on one narrow line is
    // how the keyboard hint stopped being readable.
    hint.textContent = pasteNote || text;
    hint.dataset.note = pasteNote ? '1' : '0';
  }
  renderHint();

  function wireDisclosure(node, chipSel, bodySel) {
    const chip = node.querySelector(chipSel);
    const body = node.querySelector(bodySel);
    if (!chip || !body) return;
    chip.addEventListener('click', () => {
      const open = body.dataset.collapsed === '1';
      body.dataset.collapsed = open ? '0' : '1';
      chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  const atBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < BOTTOM_SLACK_PX;

  function appendItems(items) {
    const stick = atBottom();
    for (const item of items) {
      const node = dom.itemNode(item);
      // A mail/PR-nudge item still leaves the PREVIOUS tracked node in place —
      // it must not overwrite a genuine human message with one that only
      // looks like one, even though it renders in the same bubble style.
      if (item.type === 'user' && isHumanTypedUserItem(item)) {
        userEls.push(node);
        const hit = echoList().find((e) => echoMatches(e, item));
        noteAcked(sessionId, item.event);
        if (hit) {
          removeEcho(hit);
          renderSuggestion();
        }
      }
      if (item.type === 'subagent') {
        node.addEventListener('click', () => onSubagentClick?.(sessionId, item.event.id));
      }
      if (item.type === 'activity' && item.adds + item.dels > 0) {
        node.querySelector('.chat-activity-chip')?.addEventListener('dblclick', () => onOpenDiff?.(sessionId));
      }
      // Activity and thinking are the same disclosure control, so they are wired
      // by the same code — a thinking body with text was previously rendered
      // collapsed with nothing anywhere able to open it, making Codex/Claude
      // reasoning text permanently unreachable in this view.
      wireDisclosure(node, '.chat-activity-chip', '.chat-activity-body');
      wireDisclosure(node, '.chat-thinking-chip', '.chat-thinking-body');
      // A recap's next step LOADS the composer rather than sending it. The
      // recap is Claude's guess at what comes next, so the human has to get the
      // chance to edit or discard it — auto-sending would turn a suggestion
      // into an instruction.
      if (item.type === 'recap' && item.event.next) {
        node.querySelector('.chat-recap-next')?.addEventListener('click', () => {
          loadComposer(item.event.next);
          renderSuggestion();
        });
      }
      stream.appendChild(node);
    }
    pinTail();
    if (stick) stream.scrollTop = stream.scrollHeight;
    updateJumpVisibility();
  }

  function poll() {
    if (!sessionId) return;
    send({ type: 'chat', sessionId, token: generation, ...(offset == null ? {} : { sinceOffset: offset }) });
  }

  function clearBurst() {
    for (const t of burst) clearTimeout(t);
    burst = [];
  }

  // Called on send only. Each step is the ordinary poll, so this adds no reply
  // path and needs nothing new echoed back — the token gate and the
  // forward-progress offset check already drop a stale or duplicate reply.
  function kickBurst() {
    clearBurst();
    burst = SEND_BURST_MS.map((ms) => setTimeout(poll, ms));
    // Re-phased from the send, so an interval tick cannot fire a few ms after a
    // burst step and re-ask for the same increment.
    if (timer) {
      clearInterval(timer);
      timer = setInterval(poll, POLL_MS);
    }
  }

  // Throws away what is on screen and re-reads the window from the top, which is
  // the only honest answer to a rewind: the server can prune the abandoned branch
  // out of a fresh read, but it cannot un-append the events this view already
  // drew. Bumping the generation is load-bearing — a reply that was already in
  // flight carries the old token and would otherwise be applied on top of the
  // cleared stream (offset is back to null, so nothing else would reject it),
  // re-drawing the branch that just died.
  //
  // Deliberately narrow: the composer, its draft, any in-flight image upload and
  // the live row's status all survive. The conversation changed underneath the
  // reader; what they were typing did not.
  function rebuildStream() {
    generation += 1;
    offset = null;
    clearBurst();
    stream.textContent = '';
    detachEchoNodes();
    // Same dangling-reference reasoning as `live` below: the node this pointed
    // at was just cleared out of the document.
    userEls = [];
    jumpNav.hidden = true;
    // The row was a child of the stream just cleared, so the handle is dangling —
    // dropped here so the next render appends a fresh one instead of a detached
    // node with a live timer against it.
    live = null;
    clearInterval(tick);
    tick = null;
    renderLive();
    pinTail();
    poll();
  }

  return {
    onMessageResult(msg) {
      const pending = pendingMessages.get(msg.sessionId);
      if (!pending || msg.requestId !== pending.requestId) return;
      const current = sessionId === msg.sessionId;
      pendingMessages.delete(msg.sessionId);
      if (!msg.ok) {
        if (pending.echo) {
          removeEcho(pending.echo);
          renderSuggestion();
        }
        if (current && pending.clearComposer) paneRestoreArmed = true;
        if (current) {
          input.value = pending.draft.text;
          attachments = pending.draft.attachments.slice();
          input.dispatchEvent(new Event('input'));
          renderAttachments();
          saveDraft(msg.sessionId);
          const prefix = msg.outcome === 'unknown' ? 'Delivery status unknown' : 'Not sent';
          setPasteNote(`${prefix}: ${msg.error || 'check the terminal before sending again'}`);
          renderSendability();
        } else drafts.set(msg.sessionId, pending.draft);
        return;
      }
      if (pending.echo) {
        pending.echo.state = 'queued';
        if (pending.echo.node) pending.echo.node.dataset.pending = 'queued';
        if (current) pinTail();
      }
      if (current) {
        drafts.delete(msg.sessionId);
        setPasteNote(null);
        renderSendability();
        kickBurst();
      } else drafts.delete(msg.sessionId);
    },
    onConnectionClosed() {
      for (const pending of [...pendingMessages.values()]) {
        this.onMessageResult({
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          ok: false,
          outcome: 'unknown',
          error: 'connection closed; check the terminal before sending again',
        });
      }
    },
    // The answer to an interrupt: what to put back in the composer, resolved
    // server-side from the pane (authoritative when Claude Code restored the
    // prompt there) or else from a fresh transcript read. `source` is carried so
    // this view never has to guess which it got.
    onInterruptRestore(msg) {
      // Exactly one in-flight interrupt per view, so an unmatched token means the
      // reply belongs to a superseded request or another session's era.
      if (!restoreToken || msg.token !== restoreToken) return;
      restoreToken = null;
      if (!msg.text) return;
      // The draft check is the one made when Esc was pressed, not now: anything
      // typed since is newer than the prompt being recovered and must survive.
      if (restoreOverDraft) return;
      loadComposer(msg.text);
      renderSuggestion();
      renderSendability();
    },
    // The upload half of an image paste. Correlated by the era-stamped token the
    // request carried, so a reply for a session the view has since left is
    // discarded instead of pasting a path into the wrong composer.
    onPasteImageResult(msg) {
      const token = msg.token;
      if (!pendingPastes.delete(token)) return;
      if (!String(token).startsWith(`${requestEra}#`)) return;
      if (!msg.ok) { setPasteNote(msg.error || 'Could not attach that image.'); return; }
      attachments.push({ name: msg.name });
      renderAttachments();
      renderSendability();
      scheduleDraftSave();
      input.focus();
      // Cleared only once nothing is still in flight, so a multi-image paste does
      // not flash "done" while the rest are still uploading.
      setPasteNote(pendingPastes.size ? `Attaching ${pendingPastes.size} more…` : null);
    },
    mount(id) {
      if (sessionId === id) return;
      const leaving = sessionId;
      sessionId = id;
      offset = null;
      epoch = null;
      // A burst armed against the card being left would poll this one instead,
      // duplicating mount's own window read.
      clearBurst();
      generation += 1;
      requestEra += 1;
      stream.textContent = '';
      detachEchoNodes();
      pruneEchoes();
      userEls = [];
      jumpNav.hidden = true;
      // A new era starts with no known pending call or status — otherwise the
      // previous session's working line would flash on screen until this
      // session's own setStatus/onChatReply arrives.
      lastPending = null;
      lastStatus = null;
      lastWaitingReason = null;
      lastTs = null;
      lastSuggestion = null;
      // In-flight uploads belong to the era being left: their tokens can never
      // match the bumped generation again, so clearing them just stops the set
      // growing.
      pendingPastes.clear();
      pasteNote = null;
      // A restore in flight belongs to the era being left. Dropping the token is
      // what makes its reply unmatchable, so it can never be typed into the
      // composer of whichever session is open by the time it lands.
      restoreToken = null;
      restoreOverDraft = false;
      paneRestoreArmed = false;
      wrap.hidden = false;
      // The box is shared, so whatever is in it belongs to the card being LEFT.
      // Put that away first, then bring in this card's own draft — in that order,
      // or the incoming draft is what gets filed under the outgoing id.
      saveDraft(leaving);
      loadDraft(id);
      input.focus();
      renderAttachments();
      liveModel = null;
      graphModel = null;
      graphSwitchable = false;
      liveContextPercent = null;
      // The row is a child of the stream that was just cleared, so the handle is
      // dangling — dropping it here (rather than only in renderLive's not-working
      // branch) stops the next render re-appending a detached node and, worse,
      // leaving its 1s timer running against it.
      live = null;
      clearInterval(tick);
      tick = null;
      renderLive();
      pinTail();
      renderSuggestion();
      // Cleared, not carried: the model belongs to the session being left. The
      // caller re-seeds it straight after mount (see renderSidebar in app.js).
      renderModel();
      renderContextBar();
      // Same reasoning as the model: this belongs to the session being left,
      // and the caller re-seeds it right after mount — otherwise a session
      // whose pane never died would flash the PREVIOUS one's exit output.
      renderExitNotice(null);
      poll();
      clearInterval(timer);
      timer = setInterval(poll, POLL_MS);
    },
    unmount() {
      clearInterval(timer);
      timer = null;
      clearBurst();
      const leaving = sessionId;
      sessionId = null;
      epoch = null;
      generation += 1;
      requestEra += 1;
      wrap.hidden = true;
      stream.textContent = '';
      detachEchoNodes();
      userEls = [];
      jumpNav.hidden = true;
      lastPending = null;
      lastStatus = null;
      lastWaitingReason = null;
      lastTs = null;
      lastSuggestion = null;
      // In-flight uploads belong to the era being left: their tokens can never
      // match the bumped generation again, so clearing them just stops the set
      // growing.
      pendingPastes.clear();
      pasteNote = null;
      // A restore in flight belongs to the era being left. Dropping the token is
      // what makes its reply unmatchable, so it can never be typed into the
      // composer of whichever session is open by the time it lands.
      restoreToken = null;
      restoreOverDraft = false;
      paneRestoreArmed = false;
      // Saved against the card being closed so reopening it restores the draft,
      // then the shared box is emptied so nothing is left for the next card.
      saveDraft(leaving);
      loadDraft(null);
      renderAttachments();
      liveModel = null;
      graphModel = null;
      graphSwitchable = false;
      liveContextPercent = null;
      live = null;
      renderLive();
      renderSuggestion();
      renderModel();
      renderContextBar();
      renderExitNotice(null);
    },
    onChatReply(msg) {
      if (!sessionId || msg.sessionId !== sessionId) return;
      // Drop the whole reply if it was sent under an earlier era than the one
      // showing now — a remount already reset offset and the stream locally, so
      // nothing in a stale-era reply (events, offset, or pending) can be trusted.
      // Comparing the echoed token directly against the current generation needs
      // no ordering assumption, unlike a send-order queue would.
      if (msg.token !== generation) return;
      // Checked before anything on this reply is applied. A moved epoch means the
      // events already on screen include a branch the pane has since abandoned,
      // so this reply's own events are worthless too — the rebuild's fresh read
      // is what carries the pruned conversation. `?? 0` because a reply from a
      // server that predates the field must read as a stable value rather than
      // flapping against a real number.
      const replyEpoch = msg.epoch ?? 0;
      if (epoch != null && replyEpoch !== epoch) {
        epoch = replyEpoch;
        rebuildStream();
        return;
      }
      epoch = replyEpoch;
      // Update the working line after the token check above but before the offset
      // gate below: pending describes this reply's OWN moment regardless of
      // whether it carried new events, so a same-offset "nothing new" reply must
      // still refresh it — skipping this would freeze the indicator whenever two
      // same-window polls overlap. A stale-era reply's pending is already excluded
      // by the token check, so it never reaches this line.
      lastPending = msg.pending || null;
      // Same reasoning as pending: this describes the reply's OWN moment, so a
      // same-offset "nothing new" reply must still refresh it or the elapsed
      // clock freezes whenever two same-window polls overlap.
      if (Number.isFinite(msg.lastTs)) lastTs = msg.lastTs;
      lastSuggestion = typeof msg.suggestion === 'string' && msg.suggestion ? msg.suggestion : null;
      liveModel = typeof msg.modelNow === 'string' && msg.modelNow ? msg.modelNow : null;
      liveContextPercent = Number.isFinite(msg.contextPercent) ? msg.contextPercent : null;
      renderModel();
      renderContextBar();
      renderLive();
      renderSuggestion();
      // Apply only forward progress. Two overlapping polls sent before either had
      // replied carry the SAME offset back (neither saw the other's result), so
      // the second is dropped here instead of re-appending the same window; null
      // means this is the first reply since mount and always applies.
      if (offset != null && !(msg.offset > offset)) return;
      offset = msg.offset;
      // Group THIS reply's events only. An earlier design carried the previous
      // reply's trailing tool run, re-grouped it with the new events and appended
      // the difference — which silently dropped events: when a carried run was
      // extended, the merged first item WAS the node already on screen, so slicing
      // it off discarded its new tools too. Per-reply grouping cannot lose an event.
      // The cost is cosmetic and accepted: a tool run straddling a poll boundary
      // draws as two adjacent activity chips rather than one, and self-heals on
      // remount.
      appendItems(groupChatEvents(msg.events));
    },
    // The model the session is on now, as the graph reports it (`s.modelPill`,
    // derived from the transcript's own `message.model`, so it follows a
    // mid-conversation change on its own). Its own entry point rather than a
    // second argument to setStatus: the two come from different parts of the
    // node and change on different cadences.
    setModel(pill, { switchable = false } = {}) {
      graphModel = pill || null;
      graphSwitchable = switchable;
      renderModel();
    },
    // The live label as the pane reports it, for app.js's menu — so the tick
    // matches what the chip says rather than the stale transcript-derived value.
    currentModelLabel() {
      return liveModel || graphModel?.label || null;
    },
    // s.exitOutput off the graph node — null for a live/never-died session.
    // Called wherever setStatus/setModel already are (renderSidebar's initial
    // seed, renderPanel's ~4s refresh), so it tracks the same session those do.
    setExitNotice(text) {
      renderExitNotice(text || null);
    },

    setStatus(status, waitingFor, waitingReason) {
      // A transition AWAY from 'working' must hide the line even with no new
      // reply in flight (e.g. suspend, or the pane dying mid-tool) — otherwise
      // the last reply's pending entry stays displayed after the Stop button
      // (driven by this same status) has already disappeared.
      lastStatus = status;
      lastWaitingReason = waitingReason || null;
      renderLive();
      renderSuggestion();
      renderHint();
      const bar = document.getElementById('chat-notice-bar');
      const box = document.querySelector('.chat-box');
      const needsYou = status === 'needs-you';
      const isApiError = needsYou && waitingReason === 'api-error';
      const blocked = blockedByNeedsYou();
      bar.hidden = !needsYou;
      bar.textContent = ''; // called on every render — rebuild rather than accumulate children.
      if (needsYou) {
        const msg = document.createElement('span');
        // `waitingFor` is s.waitingFor off the graph node — present for a
        // needs-you the server can actually explain (Codex's own update
        // banner, a devcontainer bring-up failure, a dropped-API-connection
        // turn), absent for an ordinary Claude permission prompt (that reason
        // lives only in the pane, which is exactly why this bar exists).
        // Deliberately NOT "this needs the terminal" — that overclaims for a
        // reason like the API-error one, which isn't itself a terminal
        // matter. What's actually true in every needs-you case is narrower:
        // Send is disabled below, so the terminal is the only place left to
        // act at all, whatever the reason. Falls back to the generic line
        // rather than showing nothing.
        //
        // The api-error case gets its own wording and no button at all: the
        // turn already ended cleanly (Send stays live below), so "only
        // actionable from the terminal" would be a straight-up lie here.
        msg.textContent = isApiError
          ? `${waitingFor || 'API error'} — send another message to retry.`
          : (waitingFor
            ? `${waitingFor} — only actionable from the terminal right now.`
            : 'Waiting on you — this prompt only exists in the terminal.');
        bar.appendChild(msg);
        if (!isApiError) {
          const go = document.createElement('button');
          go.type = 'button';
          go.className = 'chat-notice-go';
          go.textContent = 'Terminal →';
          go.addEventListener('click', () => onGoTerminal?.(sessionId));
          bar.appendChild(go);
        }
      }
      // Dim rather than disable-and-hide: a prompt typed while blocked would land in
      // the permission dialog, not the conversation, so the composer must visibly
      // stop inviting input until the dialog is answered — and revert cleanly once
      // it isn't, since this runs on every render in both directions.
      box?.setAttribute('data-blocked', blocked ? '1' : '0');
      input.placeholder = blocked ? 'Answer the prompt in the terminal first…' : 'Send a prompt…';
      input.disabled = blocked;
      // A disabled input still retains its value, so without this a prompt typed
      // before the block started stays sendable via a click — defeating the guard.
      // Unblocking hands the decision back to renderSendability rather than
      // enabling outright, or clearing a needs-you would leave Send live over an
      // empty composer with nothing attached.
      sendBtn.disabled = blocked;
      if (!blocked) renderSendability();
      stopBtn.hidden = status !== 'working';
    },
  };
}
