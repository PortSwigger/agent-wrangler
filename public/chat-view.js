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

const POLL_MS = 2000;
const BOTTOM_SLACK_PX = 40;

export function initChatView({ send, onSubagentClick, onOpenDiff, onGoTerminal } = {}) {
  const wrap = document.getElementById('chat-wrap');
  const stream = document.getElementById('chat-stream');
  const dom = createChatDom({ renderMarkdown: createRenderer(window.markdownit) });

  let sessionId = null;
  let offset = null;
  let timer = null;
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

  // Declared here (factory scope), not inside submit() — setStatus and a later
  // task both need to reach `input` to drive its placeholder/disabled state.
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');
  const hint = document.getElementById('chat-hint');

  // The live row's three inputs — the last reply's pending tool call, the
  // timestamp of the newest transcript line, and the last known session status
  // — arrive on separate asynchronous paths (onChatReply and setStatus), so all
  // three are held here and consulted together by renderLive() rather than
  // either call site deciding on its own partial view.
  let lastStatus = null;
  let lastPending = null;
  let lastTs = null;
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
    stream.appendChild(live);
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

  function submit() {
    const text = input.value.trim();
    if (!text || !sessionId) return;
    // The EXISTING human message path: live → paste into the pane, dormant →
    // wake and deliver, archived → refuse. Deliberately not the mailbox, which
    // is peer-only.
    send({ type: 'message', sessionId, text });
    input.value = '';
    input.style.height = 'auto';
  }

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', () => sessionId && send({ type: 'interrupt', sessionId }));
  input.addEventListener('keydown', (e) => {
    // isComposing: an IME user (Japanese/Chinese/Korean) presses Enter to confirm
    // a composition, not to submit — without this guard that Enter fires submit()
    // before the composed text even lands in the field.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  hint.textContent = 'Enter sends · Shift+Enter newline';

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
          input.value = item.event.next;
          input.disabled = false;
          input.focus();
          // The composer auto-grows on `input`, which a programmatic value set
          // does not fire, so a multi-line suggestion would land in a one-row
          // box that hides most of itself.
          input.dispatchEvent(new Event('input'));
        });
      }
      stream.appendChild(node);
    }
    // Keep the live row last: these nodes were just appended after it.
    if (live) stream.appendChild(live);
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function poll() {
    if (!sessionId) return;
    send({ type: 'chat', sessionId, token: generation, ...(offset == null ? {} : { sinceOffset: offset }) });
  }

  return {
    mount(id) {
      if (sessionId === id) return;
      sessionId = id;
      offset = null;
      generation += 1;
      stream.textContent = '';
      // A new era starts with no known pending call or status — otherwise the
      // previous session's working line would flash on screen until this
      // session's own setStatus/onChatReply arrives.
      lastPending = null;
      lastStatus = null;
      lastTs = null;
      // The row is a child of the stream that was just cleared, so the handle is
      // dangling — dropping it here (rather than only in renderLive's not-working
      // branch) stops the next render re-appending a detached node and, worse,
      // leaving its 1s timer running against it.
      live = null;
      clearInterval(tick);
      tick = null;
      renderLive();
      wrap.hidden = false;
      poll();
      clearInterval(timer);
      timer = setInterval(poll, POLL_MS);
    },
    unmount() {
      clearInterval(timer);
      timer = null;
      sessionId = null;
      generation += 1;
      wrap.hidden = true;
      stream.textContent = '';
      lastPending = null;
      lastStatus = null;
      lastTs = null;
      live = null;
      renderLive();
    },
    onChatReply(msg) {
      if (!sessionId || msg.sessionId !== sessionId) return;
      // Drop the whole reply if it was sent under an earlier era than the one
      // showing now — a remount already reset offset and the stream locally, so
      // nothing in a stale-era reply (events, offset, or pending) can be trusted.
      // Comparing the echoed token directly against the current generation needs
      // no ordering assumption, unlike a send-order queue would.
      if (msg.token !== generation) return;
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
      renderLive();
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
    setStatus(status) {
      // A transition AWAY from 'working' must hide the line even with no new
      // reply in flight (e.g. suspend, or the pane dying mid-tool) — otherwise
      // the last reply's pending entry stays displayed after the Stop button
      // (driven by this same status) has already disappeared.
      lastStatus = status;
      renderLive();
      const bar = document.getElementById('chat-notice-bar');
      const box = document.querySelector('.chat-box');
      const blocked = status === 'needs-you';
      bar.hidden = !blocked;
      bar.textContent = ''; // called on every render — rebuild rather than accumulate children.
      if (blocked) {
        const msg = document.createElement('span');
        msg.textContent = 'Waiting on you — this prompt only exists in the terminal.';
        bar.appendChild(msg);
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'chat-notice-go';
        go.textContent = 'Terminal →';
        go.addEventListener('click', () => onGoTerminal?.(sessionId));
        bar.appendChild(go);
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
      sendBtn.disabled = blocked;
      stopBtn.hidden = status !== 'working';
    },
  };
}
