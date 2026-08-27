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

export function initChatView({ send, onSubagentClick, onOpenDiff, onGoTerminal, onPickModel } = {}) {
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
  const suggestionBtn = document.getElementById('chat-suggestion');
  const modelEl = document.getElementById('chat-current-model');
  const attachEl = document.getElementById('chat-attachments');

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
  // away work in progress. In memory only, and deliberately not localStorage: an
  // unsent prompt is a thing of the moment, and surviving a reload would put words
  // in the composer the reader has long forgotten writing.
  //
  // Attachments travel WITH the text, because a pasted image's filename is only
  // meaningful inside the session whose pastes folder holds it — restoring the
  // prose without them would silently drop the images it refers to, and carrying
  // them to a DIFFERENT session is the leak this whole store exists to stop.
  const drafts = new Map();

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
  let lastPending = null;
  let lastTs = null;
  // Claude Code's suggested next prompt, scraped off the pane server-side (see
  // ghost-suggestion.js). Held like pending/lastTs because it too describes the
  // reply's own moment rather than any event.
  let lastSuggestion = null;
  // The most recent thing the human sent, kept so Stop can put it back in the
  // composer the way pressing Esc does in the pane. Read off the `user` events
  // as they arrive rather than remembered at submit() time: submit() is not the
  // only way a prompt reaches the session (the card's own message box and a
  // peer's mail both land as user turns), and the transcript is what actually
  // happened.
  let lastUserText = null;
  // Two sources, deliberately kept apart. `graphModel` is the board's pill,
  // derived from the transcript's last assistant message — correct for a dormant
  // session but STALE right after a `/model` switch, which the transcript does
  // not record. `liveModel` is the label the pane's own status bar shows, which
  // is the only live source. The pane wins whenever it has an answer.
  let graphModel = null;
  let graphSwitchable = false;
  let liveModel = null;

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
  }

  function renderSuggestion() {
    // Withheld while the composer holds anything, so pressing it can never
    // discard something the human was in the middle of writing — and while
    // blocked, when the composer is disabled and the only useful action is
    // answering the prompt in the pane.
    const show = Boolean(lastSuggestion) && !input.value.trim() && lastStatus !== 'needs-you';
    suggestionBtn.hidden = !show;
    if (show) suggestionBtn.textContent = lastSuggestion;
  }

  // An attached image is a complete prompt on its own (the TUI submits the bare
  // `[Image #1]`), so Send has to stay live for an empty box that holds one.
  function renderSendability() {
    if (lastStatus === 'needs-you') return; // setStatus owns the button while blocked
    sendBtn.disabled = !input.value.trim() && !attachments.length;
  }

  function submit() {
    const text = input.value.trim();
    if (!sessionId || (!text && !attachments.length)) return;
    // The EXISTING human message path: live → paste into the pane, dormant →
    // wake and deliver, archived → refuse. Deliberately not the mailbox, which
    // is peer-only. Only NAMES go over the wire — the server resolves them back
    // to paths inside this session's own pastes folder.
    send({ type: 'message', sessionId, text, ...(attachments.length ? { imageNames: attachments.map((a) => a.name) } : {}) });
    input.value = '';
    input.style.height = 'auto';
    // Cleared on send, not on reply: they have left with the message, and leaving
    // them on screen would invite sending the same image twice.
    attachments = [];
    renderAttachments();
    renderSendability();
  }

  sendBtn.addEventListener('click', submit);
  // Mimics pressing Esc in the pane: stop the turn, then hand the prompt back
  // for editing. The interrupt goes first so the stop is never delayed by the
  // restore, and it is sent even when there is nothing to restore.
  function interruptAndRestore() {
    if (!sessionId) return;
    send({ type: 'interrupt', sessionId });
    // Never over a draft: if something is already typed, that is newer than the
    // prompt being cancelled and is what the human wants to keep. Stopping still
    // happens — only the restore is skipped.
    if (lastUserText && !input.value.trim()) loadComposer(lastUserText);
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
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
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
  // Bounded per paste. A clipboard can hold a whole screenshot burst, and each
  // one costs a base64 frame plus a file, so a slip is capped rather than
  // unbounded — the human can always paste again.
  const MAX_IMAGES_PER_PASTE = 4;
  // Tokens are era-stamped with the generation so a reply that lands after the
  // view moved to another session is dropped rather than typing a stale path
  // into someone else's composer. Same reasoning as the poll's token, different
  // reply type, so deliberately its own counter.
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
      });
      chip.appendChild(drop);
      attachEl.appendChild(chip);
    });
  }

  input.addEventListener('paste', (e) => {
    if (!sessionId) return;
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((it) => it.kind === 'file' && typeof it.type === 'string' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    // No image on the clipboard means this is an ordinary text paste, which must
    // fall through untouched — preventDefault here would break pasting text.
    if (!files.length) return;
    e.preventDefault();
    const take = files.slice(0, MAX_IMAGES_PER_PASTE);
    const skipped = files.length - take.length;
    setPasteNote(take.length > 1 ? `Attaching ${take.length} images…` : 'Attaching image…');
    for (const file of take) {
      const token = `${generation}#${++pasteSeq}`;
      pendingPastes.add(token);
      const reader = new FileReader();
      reader.onerror = () => {
        pendingPastes.delete(token);
        setPasteNote('Could not read that image from the clipboard.');
      };
      reader.onload = () => {
        // readAsDataURL gives "data:<mime>;base64,<payload>" — split once on the
        // first comma so a payload containing one cannot truncate the split.
        const raw = String(reader.result || '');
        const comma = raw.indexOf(',');
        const mime = /^data:([^;,]+)/.exec(raw)?.[1] || file.type;
        if (comma < 0) {
          pendingPastes.delete(token);
          setPasteNote('Could not read that image from the clipboard.');
          return;
        }
        send({ type: 'paste-image', sessionId, token, mime, dataBase64: raw.slice(comma + 1) });
      };
      reader.readAsDataURL(file);
    }
    if (skipped > 0) setPasteNote(`Attaching ${take.length} images — ${skipped} more were skipped.`);
  });

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
      if (item.type === 'user' && item.event.text) lastUserText = item.event.text;
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
          loadComposer(item.event.next);
          renderSuggestion();
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
    // The upload half of an image paste. Correlated by the era-stamped token the
    // request carried, so a reply for a session the view has since left is
    // discarded instead of pasting a path into the wrong composer.
    onPasteImageResult(msg) {
      const token = msg.token;
      if (!pendingPastes.delete(token)) return;
      if (!String(token).startsWith(`${generation}#`)) return;
      if (!msg.ok) { setPasteNote(msg.error || 'Could not attach that image.'); return; }
      attachments.push({ name: msg.name });
      renderAttachments();
      renderSendability();
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
      generation += 1;
      stream.textContent = '';
      // A new era starts with no known pending call or status — otherwise the
      // previous session's working line would flash on screen until this
      // session's own setStatus/onChatReply arrives.
      lastPending = null;
      lastStatus = null;
      lastTs = null;
      lastSuggestion = null;
      lastUserText = null;
      // In-flight uploads belong to the era being left: their tokens can never
      // match the bumped generation again, so clearing them just stops the set
      // growing.
      pendingPastes.clear();
      pasteNote = null;
      // The box is shared, so whatever is in it belongs to the card being LEFT.
      // Put that away first, then bring in this card's own draft — in that order,
      // or the incoming draft is what gets filed under the outgoing id.
      saveDraft(leaving);
      loadDraft(id);
      renderAttachments();
      liveModel = null;
      graphModel = null;
      graphSwitchable = false;
      // The row is a child of the stream that was just cleared, so the handle is
      // dangling — dropping it here (rather than only in renderLive's not-working
      // branch) stops the next render re-appending a detached node and, worse,
      // leaving its 1s timer running against it.
      live = null;
      clearInterval(tick);
      tick = null;
      renderLive();
      renderSuggestion();
      // Cleared, not carried: the model belongs to the session being left. The
      // caller re-seeds it straight after mount (see renderSidebar in app.js).
      renderModel();
      wrap.hidden = false;
      poll();
      clearInterval(timer);
      timer = setInterval(poll, POLL_MS);
    },
    unmount() {
      clearInterval(timer);
      timer = null;
      const leaving = sessionId;
      sessionId = null;
      generation += 1;
      wrap.hidden = true;
      stream.textContent = '';
      lastPending = null;
      lastStatus = null;
      lastTs = null;
      lastSuggestion = null;
      lastUserText = null;
      // In-flight uploads belong to the era being left: their tokens can never
      // match the bumped generation again, so clearing them just stops the set
      // growing.
      pendingPastes.clear();
      pasteNote = null;
      // Saved against the card being closed so reopening it restores the draft,
      // then the shared box is emptied so nothing is left for the next card.
      saveDraft(leaving);
      loadDraft(null);
      renderAttachments();
      liveModel = null;
      graphModel = null;
      graphSwitchable = false;
      live = null;
      renderLive();
      renderSuggestion();
      renderModel();
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
      lastSuggestion = typeof msg.suggestion === 'string' && msg.suggestion ? msg.suggestion : null;
      liveModel = typeof msg.modelNow === 'string' && msg.modelNow ? msg.modelNow : null;
      renderModel();
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

    setStatus(status) {
      // A transition AWAY from 'working' must hide the line even with no new
      // reply in flight (e.g. suspend, or the pane dying mid-tool) — otherwise
      // the last reply's pending entry stays displayed after the Stop button
      // (driven by this same status) has already disappeared.
      lastStatus = status;
      renderLive();
      renderSuggestion();
      renderHint();
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
      // Unblocking hands the decision back to renderSendability rather than
      // enabling outright, or clearing a needs-you would leave Send live over an
      // empty composer with nothing attached.
      sendBtn.disabled = blocked;
      if (!blocked) renderSendability();
      stopBtn.hidden = status !== 'working';
    },
  };
}
