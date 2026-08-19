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

export function initChatView({ send, onSubagentClick, onOpenDiff } = {}) {
  const wrap = document.getElementById('chat-wrap');
  const stream = document.getElementById('chat-stream');
  const dom = createChatDom({ renderMarkdown: createRenderer(window.markdownit) });

  let sessionId = null;
  let offset = null;
  let timer = null;
  // Bumped on every mount/unmount so an in-flight reply from a closed-then-reopened
  // session (same session id, different era) can be told apart from one belonging
  // to what's on screen now — the session-id check alone can't see this, since
  // reopening the same session leaves the id unchanged.
  let generation = 0;
  // FIFO: one entry pushed per poll() send, shifted off per onChatReply. A single
  // WS connection preserves send order, so the oldest queued entry always belongs
  // to whichever reply arrives next — this is what lets a stale entry be told
  // apart from a current one without the server echoing anything back for it.
  const pollGenerations = [];

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
      if (item.type === 'activity') {
        const chip = node.querySelector('.chat-activity-chip');
        const body = node.querySelector('.chat-activity-body');
        chip?.addEventListener('click', () => {
          const open = body.dataset.collapsed === '1';
          body.dataset.collapsed = open ? '0' : '1';
          chip.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      }
      stream.appendChild(node);
    }
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function poll() {
    if (!sessionId) return;
    pollGenerations.push(generation);
    send({ type: 'chat', sessionId, ...(offset == null ? {} : { sinceOffset: offset }) });
  }

  return {
    mount(id) {
      if (sessionId === id) return;
      sessionId = id;
      offset = null;
      generation += 1;
      stream.textContent = '';
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
    },
    onChatReply(msg) {
      // Shift unconditionally, before any early return: every reply that reaches
      // here corresponds to exactly one poll() push, whether or not it's about to
      // be dropped below. Returning early without shifting would leave that entry
      // stranded in the queue, permanently offsetting every later shift by one.
      const era = pollGenerations.shift();
      if (!sessionId || msg.sessionId !== sessionId) return;
      // Drop the whole reply if it was sent under an earlier era than the one
      // showing now — a remount already reset offset and the stream locally, so
      // nothing in a stale-era reply (events, offset, or pending) can be trusted.
      if (era !== generation) return;
      // Update the working line before the offset gate below: pending describes
      // this reply's OWN moment regardless of whether it carried new events, so a
      // same-offset "nothing new" reply must still refresh it — skipping this
      // would freeze the indicator whenever two same-window polls overlap.
      const working = document.getElementById('chat-working');
      if (msg.pending) {
        working.textContent = `Working — running ${msg.pending.name}${msg.pending.target ? `: ${msg.pending.target}` : ''}`;
        working.hidden = false;
      } else {
        working.hidden = true;
      }
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
      const bar = document.getElementById('chat-notice-bar');
      const stop = document.getElementById('chat-stop');
      bar.hidden = status !== 'needs-you';
      if (status === 'needs-you') {
        bar.textContent = '';
        const msg = document.createElement('span');
        msg.textContent = 'Waiting on you — answer in the terminal';
        bar.appendChild(msg);
      }
      stop.hidden = status !== 'working';
    },
  };
}
