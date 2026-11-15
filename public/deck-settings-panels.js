import { extensionSettingRowsEl } from './extensions-panel.js';
import { updatePanelEl, restartPanelEl } from './update-panel.js';
import { extensionFlipNote } from './settings.js';

// Settings › Extensions and › Updates for a deck other than the board's own,
// chosen in the Settings deck picker. Everything is read from that deck (its
// graph, its connect `config`, its update events) and every write is sent to it
// through `sendTo(deckId, frame)`, the board's own routing.
//
// `deckOf(deckId)` is the deck as app.js's boardDecks() lists it; `get(id,
// deckId)`/`set(id, value, deckId)` are the Settings server bridge, so an
// extension toggle here reads and writes exactly as a row on the other tabs.

// What a deck's connect frame and update events say about its updates.
const UPDATE_MESSAGES = new Set(['config', 'update-status', 'update-error', 'restart-ack']);

export function nextUpdateState(state, msg) {
  const s = { phase: 'idle', status: null, error: '', canRestart: false, unavailable: null, drift: null, restarting: false, ...state };
  if (msg.type === 'config') {
    return { ...s, canRestart: Boolean(msg.canRestart), unavailable: msg.updateUnavailable || null, drift: msg.installDrift || null, status: msg.update || s.status, restarting: false, phase: msg.update && s.phase === 'idle' ? 'status' : s.phase };
  }
  if (msg.type === 'update-status') {
    const { type: _t, ...status } = msg;
    return { ...s, status, phase: 'status', error: '' };
  }
  if (msg.type === 'update-error') return { ...s, phase: 'error', error: msg.message || '' };
  if (msg.type === 'restart-ack') return { ...s, restarting: true };
  return s;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const extSignature = (graph) => JSON.stringify((graph?.extensions || []).map(({ settingValues: _v, ...rest }) => rest));

export function createDeckSettingsPanels({ deckOf, sendTo, get, set }) {
  const updates = new Map();
  let extHost = null;
  let extDeck = null;
  let extSig = null;
  let updHost = null;
  let updDeck = null;

  function extensionRow(deckId, entry) {
    const id = `ext:${entry.id}`;
    const row = el('div', 'setting-row');
    row.dataset.extDeck = entry.id;
    const copy = el('div', 'setting-copy');
    copy.append(el('div', 'setting-label', String(entry.label || entry.id)));
    if (entry.help) copy.append(el('div', 'setting-help', entry.help));
    if (entry.quarantine) copy.append(el('div', 'setting-help update-error', `Quarantined: ${entry.quarantine}`));
    const toggle = el('button', 'setting-toggle');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', String(entry.label || entry.id));
    toggle.append(el('span', 'setting-knob'));
    const paint = (on) => { toggle.classList.toggle('on', on); toggle.setAttribute('aria-checked', on ? 'true' : 'false'); };
    paint(Boolean(get(id, deckId)));
    toggle.addEventListener('click', () => {
      const next = !get(id, deckId);
      set(id, next, deckId);
      paint(next);
      let note = copy.querySelector('.setting-flip-note');
      if (!note) { note = el('div', 'setting-flip-note'); note.setAttribute('role', 'status'); copy.append(note); }
      note.textContent = extensionFlipNote({ enabled: next });
    });
    row.append(copy, toggle);
    const wrap = el('div', 'deck-ext');
    wrap.append(row);
    if (entry.enabled && (entry.settings || []).some((d) => !d.hidden)) {
      wrap.append(extensionSettingRowsEl(entry, {
        onSettingChange: ({ key, value }) => sendTo(deckId, { type: 'ext-setting-set', id: entry.id, key, value }),
      }));
    }
    return wrap;
  }

  function drawExtensions() {
    if (!extHost?.isConnected) return;
    const d = deckOf(extDeck);
    extHost.textContent = '';
    extSig = extSignature(d?.graph);
    const list = Array.isArray(d?.graph?.extensions) ? d.graph.extensions : [];
    const box = el('div', 'settings-list');
    if (!list.length) box.append(el('div', 'settings-empty', 'This deck has no extensions.'));
    for (const entry of list) if (entry && typeof entry.id === 'string') box.append(extensionRow(extDeck, entry));
    extHost.append(box, el('div', 'setting-help deck-ext-note', 'Install, update and remove extensions from the board on the deck\'s own machine.'));
  }

  function drawUpdates() {
    if (!updHost?.isConnected) return;
    const s = nextUpdateState(updates.get(updDeck), {});
    const deckId = updDeck;
    updHost.textContent = '';
    const restart = restartPanelEl({
      drift: s.drift,
      canRestart: s.canRestart,
      restarting: s.restarting,
      onRestart: () => { updates.set(deckId, { ...s, restarting: true }); sendTo(deckId, { type: 'restart-server' }); drawUpdates(); },
    });
    if (restart) updHost.append(restart);
    updHost.append(updatePanelEl({
      phase: s.phase,
      status: s.status,
      error: s.error,
      unavailable: s.unavailable,
      onCheck: () => { updates.set(deckId, { ...s, phase: 'checking' }); sendTo(deckId, { type: 'update-check' }); drawUpdates(); },
      onApply: () => { updates.set(deckId, { ...s, phase: 'applying' }); sendTo(deckId, { type: 'update-apply' }); drawUpdates(); },
    }));
  }

  return {
    // Takes a deck's own update news; true when it was one, so the caller
    // keeps it off the board's own update state.
    note(deckId, msg) {
      if (!deckId || !msg || !UPDATE_MESSAGES.has(msg.type)) return false;
      updates.set(deckId, nextUpdateState(updates.get(deckId), msg));
      if (deckId === updDeck) drawUpdates();
      return true;
    },
    mountExtensions(host, deckId) {
      extHost = host;
      extDeck = deckId;
      drawExtensions();
    },
    mountUpdates(host, deckId) {
      updHost = host;
      updDeck = deckId;
      drawUpdates();
    },
    unmount() { extHost = null; updHost = null; extDeck = null; updDeck = null; },
    // After any remote deck's state moved: the extension list redraws only
    // when the list itself changed, so a half-typed setting value survives.
    refresh() {
      if (extHost?.isConnected && extSignature(deckOf(extDeck)?.graph) !== extSig) drawExtensions();
    },
  };
}
