import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';

const MAILBOX_FILE = path.join(DATA_DIR, 'mailbox.json');

// Settle window: fixed, not a debounce — it does NOT extend on each new
// message, so a steady trickle from many senders can't starve the recipient.
export const SETTLE_MS = 10_000;
// Mail pill goes amber once unread mail has sat this long since the last
// notification — the point Phase 2's nudge cycle (1+5+20min) would have given up.
export const AMBER_MS = 30 * 60 * 1000;

export const UNREAD_CAP_MESSAGES = 20;
export const UNREAD_CAP_BYTES = 256 * 1024;
export const READ_RETENTION_MESSAGES = 100;
export const READ_RETENTION_BYTES = 1024 * 1024;
export const TOTAL_STORE_CAP_BYTES = 32 * 1024 * 1024;
// Send-time hard reject — 4.4x the largest message ever observed (see the
// spec's size-threshold table). Lives here alongside the other caps even
// though send-message.js is the only caller: it's the same size-policy
// surface, and the tool's own description promises this exact number.
export const SEND_MAX_BYTES = 32 * 1024;

const byteSize = (s) => Buffer.byteLength(s, 'utf8');

// Durable per-recipient mailbox. Mirrors the schedule-store/task-store mould:
// state held in memory, mutation methods are SYNCHRONOUS, persistence is a side
// effect of mutation. `atomic-json.js` gives crash-safe writes, not transactional
// read-modify-write, and four independent writers touch a mailbox (send_message
// appends, read_mail drains, the settle runner marks notified/undeliverable,
// eviction prunes) — a load-mutate-save-per-call-site design would let any two of
// them interleave and clobber each other across an await. Every method here runs
// to completion with no await, so two calls can never interleave within one process.
//
// On disk: { "<cardId>": { messages: [{id,from,fromLabel,at,body,size,state,readAt}],
//   settleDeadline, lastNotifiedAt } }. `state` is the ONE source of truth for a
// message's lifecycle ('unread' | 'undeliverable' | 'read') — no separate `read`
// boolean, so there is nothing to drift out of sync with it.
export class MailboxStore {
  constructor(file = MAILBOX_FILE) {
    this.file = file;
    this.boxes = new Map(); // cardId -> { messages: [...], settleDeadline, lastNotifiedAt }
    this._load();
  }

  _load() {
    const raw = readJsonOrLoud(this.file, 'mailbox.json');
    if (!raw || typeof raw !== 'object') return; // missing/empty = first run
    for (const [to, box] of Object.entries(raw)) {
      if (!box || !Array.isArray(box.messages)) continue;
      this.boxes.set(to, {
        messages: box.messages.map((m) => ({ ...m })),
        settleDeadline: box.settleDeadline ?? null,
        lastNotifiedAt: box.lastNotifiedAt ?? null,
      });
    }
  }

  _save() {
    const out = {};
    for (const [to, box] of this.boxes) out[to] = box;
    writeJsonAtomic(this.file, out);
  }

  _box(to) {
    let box = this.boxes.get(to);
    if (!box) {
      box = { messages: [], settleDeadline: null, lastNotifiedAt: null };
      this.boxes.set(to, box);
    }
    return box;
  }

  // Total bytes retained across every box (unread + undeliverable + read) — the
  // 32MB whole-store cap.
  _totalBytes() {
    let total = 0;
    for (const box of this.boxes.values()) for (const m of box.messages) total += m.size;
    return total;
  }

  // Eviction candidates: read AND undeliverable — never unread (a sender was
  // told its message was queued, so it must never be silently dropped).
  // Undeliverable mail is retained forever otherwise (a card archived mid-
  // window that never gets purged accumulates it without bound), so it must
  // count toward the SAME caps as read mail, not sit outside every cap.
  _isEvictable(m) { return m.state === 'read' || m.state === 'undeliverable'; }

  // Evict the oldest evictable message in `box`. Returns true if something
  // was evicted.
  _evictOldestEvictable(box) {
    const i = box.messages.findIndex((m) => this._isEvictable(m));
    if (i < 0) return false;
    box.messages.splice(i, 1);
    return true;
  }

  // Evict the oldest evictable message across ALL boxes (the whole-store cap
  // has no single owning box). Returns true if something was evicted.
  _evictOldestEvictableAnywhere() {
    let oldest = null;
    for (const box of this.boxes.values()) {
      for (const m of box.messages) {
        if (this._isEvictable(m) && (!oldest || m.at < oldest.m.at)) oldest = { box, m };
      }
    }
    if (!oldest) return false;
    const i = oldest.box.messages.indexOf(oldest.m);
    oldest.box.messages.splice(i, 1);
    return true;
  }

  // Append one message to `to`'s box. Throws a plain Error with an agent-facing
  // message on cap breach (the sender-facing error `send_message` returns
  // verbatim) — checked BEFORE the append, so a refused send never partially
  // lands. First arrival for a recipient with no pending window opens a fresh
  // SETTLE_MS deadline; further mail (from any sender) joins the same batch
  // without extending it — a fixed window, not a debounce.
  append(to, { from, fromLabel = null, body }, now = Date.now()) {
    const box = this._box(to);
    const size = byteSize(body);
    const unread = box.messages.filter((m) => m.state === 'unread');
    const unreadBytes = unread.reduce((n, m) => n + m.size, 0);
    if (unread.length >= UNREAD_CAP_MESSAGES || unreadBytes + size > UNREAD_CAP_BYTES) {
      throw new Error(
        `Recipient ${to} has too much unread mail (max ${UNREAD_CAP_MESSAGES} messages / `
        + `${Math.round(UNREAD_CAP_BYTES / 1024)}KB) — it is backed up and not reading its mail.`,
      );
    }
    const message = {
      id: `mail_${crypto.randomBytes(6).toString('hex')}`,
      from, fromLabel, at: now, body, size, state: 'unread', readAt: null,
    };
    box.messages.push(message);
    if (box.settleDeadline == null) box.settleDeadline = now + SETTLE_MS;
    this._enforceRetentionCaps(box);
    this._save();
    return { id: message.id };
  }

  // Retention caps — read/undeliverable mail only, oldest first. Per-box cap,
  // then the whole-store cap; both operate strictly on evictable messages so
  // this can never evict unread mail. Called after ANY mutation that can grow
  // the evictable set (append — a fresh undeliverable mark, drain, getOne) —
  // the breach happens the moment a message stops being 'unread', not only on
  // append.
  _enforceRetentionCaps(box) {
    while (this._evictableCount(box) > READ_RETENTION_MESSAGES || this._evictableBytes(box) > READ_RETENTION_BYTES) {
      if (!this._evictOldestEvictable(box)) break;
    }
    while (this._totalBytes() > TOTAL_STORE_CAP_BYTES) {
      if (!this._evictOldestEvictableAnywhere()) break;
    }
  }

  _evictableCount(box) { return box.messages.filter((m) => this._isEvictable(m)).length; }
  _evictableBytes(box) { return box.messages.filter((m) => this._isEvictable(m)).reduce((n, m) => n + m.size, 0); }

  // Recipients whose settle window is due (<= now). Clears the deadline
  // SYNCHRONOUSLY at selection (not left for the caller to clear later) — so
  // even a missed in-flight guard can't select and re-notify the same window
  // twice, and a server restart mid-window is recoverable: the deadline is
  // already persisted, so the first sweep after boot selects it exactly once.
  takeDueSettles(now = Date.now()) {
    const due = [];
    for (const [to, box] of this.boxes) {
      if (box.settleDeadline != null && box.settleDeadline <= now) {
        box.settleDeadline = null;
        due.push(to);
      }
    }
    if (due.length) this._save();
    return due;
  }

  markNotified(to, at = Date.now()) {
    const box = this._box(to);
    box.lastNotifiedAt = at;
    this._save();
  }

  // Recipient was archived during its settle window: the mail that was pending
  // (still 'unread') can never be delivered — mark it rather than leaving it
  // looking pending forever, and it is excluded from the unread cap/pill by its
  // state alone. Never re-marked as fresh if the card is later un-archived.
  markUndeliverable(to) {
    const box = this._box(to);
    let changed = false;
    for (const m of box.messages) {
      if (m.state === 'unread') { m.state = 'undeliverable'; changed = true; }
    }
    if (changed) {
      this._enforceRetentionCaps(box);
      this._save();
    }
  }

  // Re-open a fresh settle window for a recipient whose settle-close delivery
  // just failed (mode:'error' — see mail-runner.js). takeDueSettles already
  // cleared the deadline synchronously at selection, and nothing else re-arms
  // it, so without this a failed delivery strands the batch 'unread' forever
  // with the sender already told queued:true. No-op if the box is now empty
  // (e.g. every pending message was concurrently marked undeliverable).
  reopenSettle(to, now = Date.now()) {
    const box = this.boxes.get(to);
    if (!box || !box.messages.some((m) => m.state === 'unread')) return;
    box.settleDeadline = now + SETTLE_MS;
    this._save();
  }

  // Read-only peek at the currently unread messages, oldest-first, WITHOUT
  // marking them read — the settle runner composes the notification from this
  // (count + distinct sender ids) before the recipient has called read_mail.
  unreadMessages(to) {
    const box = this.boxes.get(to);
    if (!box) return [];
    return box.messages.filter((m) => m.state === 'unread').sort((a, b) => a.at - b.at).map((m) => ({ ...m }));
  }

  // Drain every unread message, oldest-first, marking each read. Returns full
  // copies (with body) — this is the ONLY drain path; undeliverable mail is
  // deliberately excluded so it is never delivered "as if it just arrived".
  drain(to, now = Date.now()) {
    const box = this._box(to);
    const out = [];
    for (const m of box.messages) {
      if (m.state !== 'unread') continue;
      m.state = 'read';
      m.readAt = now;
      out.push({ ...m });
    }
    if (out.length) {
      this._enforceRetentionCaps(box);
      this._save();
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // Fetch one message by id regardless of current state, marking it read if it
  // wasn't already (a follow-up read of a truncated excerpt). Returns null if
  // absent. undeliverable mail IS retrievable by id (see the 3-state table) —
  // only the bulk drain() excludes it.
  getOne(to, id, now = Date.now()) {
    const box = this._box(to);
    const m = box.messages.find((x) => x.id === id);
    if (!m) return null;
    if (m.state === 'unread') {
      m.state = 'read'; m.readAt = now;
      this._enforceRetentionCaps(box);
      this._save();
    }
    return { ...m };
  }

  // Metadata only (no bodies), oldest-first — list_mail's whole job.
  list(to) {
    const box = this._box(to);
    return [...box.messages].sort((a, b) => a.at - b.at).map((m) => ({ ...m }));
  }

  // { unread, notifiedAt, amber, senders } for the board's mail pill: the count
  // and amber boolean drive the pill itself, `senders` (deduped, in message
  // order, identity-less senders dropped — see composeMailNotification for why)
  // rides along for the tooltip.
  //
  // `lastNotifiedAt` is a SINGLE scalar per box, not per-message — it means
  // "when we last pasted a notification covering the box's unread set", which
  // is only trustworthy while no settle window is currently pending. A pending
  // window (`box.settleDeadline != null`) means fresh mail has arrived (or a
  // prior delivery failed and reopenSettle re-armed it) that this box's
  // lastNotifiedAt predates — using it here would report brand-new mail as
  // stale for however old the PREVIOUS notification happens to be, permanently
  // so if delivery keeps failing. So: ignore lastNotifiedAt while a window is
  // pending and fall back to the oldest unread message's own timestamp — the
  // same fallback already used for "never notified at all" (a dormant wake
  // whose resume failed — no Phase-1 deliveryFailed tracking, see the spec).
  unreadInfo(to, now = Date.now()) {
    const box = this.boxes.get(to);
    const unread = box ? box.messages.filter((m) => m.state === 'unread') : [];
    if (!unread.length) return { unread: 0, notifiedAt: null, amber: false, senders: [] };
    const notifiedAt = box.settleDeadline == null ? (box.lastNotifiedAt ?? null) : null;
    const oldestAt = Math.min(...unread.map((m) => m.at));
    const age = now - (notifiedAt ?? oldestAt);
    return {
      unread: unread.length,
      notifiedAt,
      amber: age >= AMBER_MS,
      senders: [...new Set(unread.map((m) => m.from).filter(Boolean))],
    };
  }

  // Permanently drop a recipient's whole box — only ever called when the card
  // itself is purged from mappings.json (never on archive; the box is retained
  // in full until then).
  forget(to) {
    if (this.boxes.delete(to)) this._save();
  }
}
