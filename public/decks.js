import { createDeckClient, stateToGraph } from './deck-client.js';
import { stampDeck, cardKey, parseCardKey } from './card-key.js';

// The decks one board shows. The list lives in the board server
// (server/board-decks.js), so every browser on the board reads the same one;
// the board's own deck is its first entry. Each other deck gets a deck client
// of its own on the deck's URL, and its sessions join the board's cards, named
// by that deck's id. Decks never hear of each other: the board talks to each
// through the deck API alone.
export const OWN_ENTRY = 'own';
const COLOUR = /^#[0-9a-f]{6}$/i;

export function originOfUrl(url) {
  const u = new URL(url);
  return { http: u.origin, ws: `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}` };
}

export const deckColour = (c) => (typeof c === 'string' && COLOUR.test(c) ? c : null);

// What a deck is called on the board: the name given in settings, else the
// name its descriptor gives, else its URL.
export function deckLabel(entry, descriptor = null) {
  if (entry?.name) return entry.name;
  if (typeof descriptor?.name === 'string' && descriptor.name) return descriptor.name;
  return entry?.url ? entry.url.replace(/^https?:\/\//, '') : 'This deck';
}

// The board's whole graph from its own deck's and every other deck's: the own
// deck's graph supplies everything board-wide (settings, tasks, history,
// extensions), and each other deck adds only its sessions. A card's deck name
// and colour ride on it only while the board shows more than one deck; a card
// whose deck is not connected is marked `deckUnreachable` and keeps its last
// state.
export function mergeDeckGraphs(own, remotes = [], { multi = false } = {}) {
  const base = own?.graph || {};
  const mark = (deck) => (r) => {
    if (!r || typeof r.sessionId !== 'string') return r;
    const out = { ...r };
    if (multi) {
      out.deckName = deck.name;
      out.deckColour = deck.colour;
      if (deck.status !== 'ready') out.deckUnreachable = true;
    }
    return out;
  };
  const sessions = (base.sessions || []).map(mark(own || {}));
  const nodes = Array.isArray(base.nodes) ? base.nodes.map((n) => (n?.type === 'session' ? mark(own || {})(n) : n)) : null;
  for (const deck of remotes) {
    if (!deck.graph) continue;
    const m = mark(deck);
    sessions.push(...(deck.graph.sessions || []).map(m));
    if (nodes && Array.isArray(deck.graph.nodes)) nodes.push(...deck.graph.nodes.filter((n) => n?.type === 'session').map(m));
  }
  return { ...base, sessions, ...(nodes ? { nodes } : {}) };
}

// Another deck's tasks and schedules as this board shows them: each id is
// scoped by its deck id (`<deckId>/<id>`, the card key's form; the board's own
// ids never contain '/'), so two decks' ids never meet. `assignments` is keyed
// by card key. Each task and schedule carries its deck's name, colour and
// whether the deck is connected; the order keeps each deck's tasks together,
// in the deck's own order, decks in list order.
export function remoteTaskView(remotes = []) {
  const view = { tasks: [], order: [], assignments: {}, sessionOrder: {}, schedules: [] };
  for (const deck of remotes) {
    if (!deck?.deckId || !deck.graph) continue;
    const scope = (id) => cardKey(deck.deckId, id);
    const mark = { deckId: deck.deckId, deckName: deck.name, deckColour: deck.colour, ...(deck.status !== 'ready' ? { deckUnreachable: true } : {}) };
    const t = deck.graph.tasks || {};
    const tasks = (Array.isArray(t.tasks) ? t.tasks : []).filter((x) => typeof x?.id === 'string' && scope(x.id));
    for (const task of tasks) view.tasks.push({ ...task, ...mark, id: scope(task.id), localId: task.id });
    const ids = new Set(tasks.map((x) => x.id));
    const order = (Array.isArray(t.order) ? t.order : []).filter((id) => ids.has(id));
    for (const task of tasks) if (!order.includes(task.id)) order.push(task.id);
    view.order.push(...order.map(scope));
    for (const [sid, tid] of Object.entries(t.assignments || {})) {
      const key = cardKey(deck.deckId, sid);
      if (key && ids.has(tid)) view.assignments[key] = scope(tid);
    }
    for (const [bucket, list] of Object.entries(t.sessionOrder || {})) if (scope(bucket)) view.sessionOrder[scope(bucket)] = list;
    const schedules = Array.isArray(deck.graph.schedules?.schedules) ? deck.graph.schedules.schedules : [];
    for (const sch of schedules) if (typeof sch?.id === 'string' && scope(sch.id)) view.schedules.push({ ...sch, ...mark, id: scope(sch.id), localId: sch.id });
  }
  return view;
}

// Where a task or schedule call goes, from the ids it names: a scoped id names
// another deck and is sent there bare; any other id is the board's own deck's
// (`deckId: null`). `deckId` is undefined when the call names none, and
// `conflict` is set when it names two decks (a task moved onto another deck's).
export function scopeCall(frame) {
  const type = typeof frame?.type === 'string' ? frame.type : '';
  const fields = type.startsWith('schedule-') ? ['id'] : type.startsWith('task-') ? ['taskId', 'targetId'] : [];
  let deckId;
  const out = { ...frame };
  for (const f of fields) {
    if (typeof frame[f] !== 'string') continue;
    const p = parseCardKey(frame[f]);
    const d = p ? p.deckId : null;
    if (deckId !== undefined && deckId !== d) return { conflict: true, frame };
    deckId = d;
    if (p) out[f] = p.sessionId;
  }
  return { deckId, frame: out };
}

// A reply or event from another deck naming one of its tasks names it scoped,
// as the board shows it.
export function scopeReply(msg, deckId) {
  if (!deckId || !msg || typeof msg.taskId !== 'string' || !String(msg.type).startsWith('task-')) return msg;
  return { ...msg, taskId: cardKey(deckId, msg.taskId) || msg.taskId };
}

// Which deck an outgoing call goes to. `card` names it outright. Otherwise the
// session id picks the one deck holding it; when two decks hold the same id,
// the card being acted on (`hint`) decides, then the deck whose reply is being
// handled (`context`), then the board's own deck.
export function routeDeck({ card = null, sessionId = null, sessions = [], hint = null, context = null, own = null, deckIdOf }) {
  if (card) return deckIdOf(card) || own;
  if (typeof sessionId === 'string' && sessionId) {
    const holders = [...new Set(sessions.filter((s) => s.sessionId === sessionId).map((s) => s.deckId))];
    if (holders.length === 1) return holders[0];
    if (holders.length > 1) {
      const hinted = hint && deckIdOf(hint);
      if (hinted && holders.includes(hinted) && hint.slice(hinted.length + 1) === sessionId) return hinted;
      if (context && holders.includes(context)) return context;
      return holders.includes(own) ? own : holders[0];
    }
  }
  return context || own;
}

// One deck client per remote entry. `onChange()` fires after a deck's state,
// status or descriptor moved; `onEvent(deckId, frame)` for its events. A deck
// whose id is the board's own or another listed deck's (the same deck under a
// second URL) is shown as incompatible and not read twice. `cache` keeps each
// deck's last sessions, tasks and schedules ({ get(entry), set(entry, value),
// drop(entry) }), so a deck that is down when the page loads still shows them,
// unreachable.
export function createRemoteDecks({ makeClient = createDeckClient, ownDeckId = () => null, onChange = () => {}, onEvent = () => {}, cache = null } = {}) {
  const decks = new Map();
  let opened = 0;

  function duplicateOf(d) {
    const id = d.client.descriptor()?.deckId;
    if (!id) return null;
    if (id === ownDeckId()) return OWN_ENTRY;
    for (const other of decks.values()) {
      if (other !== d && other.deckId === id && other.started < d.started) return other.entry.id;
    }
    return null;
  }

  function open(entry) {
    const d = { entry, deckId: null, graph: null, status: 'connecting', duplicate: null, started: ++opened };
    const cached = cache?.get(entry);
    if (cached && typeof cached.deckId === 'string' && Array.isArray(cached.sessions) && cached.url === entry.url) {
      d.deckId = cached.deckId;
      d.graph = stampDeck({ sessions: cached.sessions, tasks: cached.tasks, schedules: cached.schedules }, cached.deckId);
    }
    d.client = makeClient({
      origin: () => originOfUrl(d.entry.url),
      onStatus: (status) => {
        d.status = status;
        const id = d.client.descriptor()?.deckId;
        if (id) d.deckId = id;
        d.duplicate = duplicateOf(d);
        if (d.duplicate) d.client.stop();
        onChange();
      },
      onState: (frame) => {
        if (d.duplicate) return;
        d.deckId = d.client.descriptor()?.deckId || d.deckId;
        if (!d.deckId) return;
        d.graph = stampDeck(stateToGraph(frame), d.deckId);
        cache?.set(d.entry, { url: d.entry.url, deckId: d.deckId, sessions: d.graph.sessions || [], tasks: d.graph.tasks, schedules: d.graph.schedules });
        onChange();
      },
      onEvent: (frame) => { if (d.deckId && !d.duplicate) onEvent(d.deckId, frame); },
    });
    decks.set(entry.id, d);
    d.client.start();
  }

  // Brings the open clients in line with the list: a new entry opens, a
  // removed one stops and its cards leave, a changed URL reopens, and a new
  // name or colour applies as it is.
  function sync(entries) {
    const wanted = new Map(entries.filter((e) => e && !e.own && e.url).map((e) => [e.id, e]));
    let changed = false;
    for (const [id, d] of decks) {
      const next = wanted.get(id);
      if (!next || next.url !== d.entry.url) { d.client.stop(); decks.delete(id); cache?.drop(d.entry); changed = true; }
      else if (next !== d.entry) { d.entry = next; changed = true; }
    }
    for (const [id, entry] of wanted) if (!decks.has(id)) { open(entry); changed = true; }
    if (changed) onChange();
  }

  const shown = (d) => ({
    id: d.entry.id,
    entry: d.entry,
    deckId: d.duplicate ? null : d.deckId,
    graph: d.duplicate ? null : d.graph,
    status: d.duplicate ? 'incompatible' : d.status,
    duplicate: d.duplicate,
    descriptor: d.client.descriptor(),
    name: deckLabel(d.entry, d.client.descriptor()),
    colour: deckColour(d.entry.colour),
  });

  return {
    sync,
    list: () => [...decks.values()].map(shown),
    clientFor: (deckId) => {
      for (const d of decks.values()) if (!d.duplicate && d.deckId === deckId) return d.client;
      return null;
    },
    entryFor: (deckId) => {
      for (const d of decks.values()) if (!d.duplicate && d.deckId === deckId) return shown(d);
      return null;
    },
    originFor: (deckId) => {
      for (const d of decks.values()) if (!d.duplicate && d.deckId === deckId) return originOfUrl(d.entry.url);
      return null;
    },
    stop: () => { for (const d of decks.values()) d.client.stop(); decks.clear(); },
  };
}

// The board server's deck list: read once, then followed on its event stream
// so a change made in any browser shows in every other. `change(op)` resolves
// with the new list or rejects with the server's reason.
export function createDeckList({ fetchImpl = (...a) => fetch(...a), EventSourceImpl = globalThis.EventSource, onList = () => {} } = {}) {
  let rev = 0;
  let source = null;
  const take = (snap) => {
    if (!snap || !Array.isArray(snap.decks) || (typeof snap.rev === 'number' && snap.rev < rev)) return;
    rev = typeof snap.rev === 'number' ? snap.rev : rev;
    onList(snap.decks);
  };
  return {
    start() {
      fetchImpl('/api/decks', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then(take, () => {});
      if (!EventSourceImpl) return;
      source = new EventSourceImpl('/api/decks/stream');
      source.onmessage = (ev) => { try { take(JSON.parse(ev.data)); } catch {} };
    },
    async change(op) {
      const r = await fetchImpl('/api/decks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.error) throw new Error(body.error || `The board answered ${r.status}`);
      take(body);
      return body.decks;
    },
    stop() { source?.close(); },
  };
}
