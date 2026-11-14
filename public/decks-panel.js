// Settings › Decks: the board's deck list (public/decks.js), with each deck's
// connection status. Names and colours save as they change; every browser on
// the board sees the change through the board server's deck list stream.
// Built with textContent throughout: names and URLs are typed by people.
//
// `bridge` is { decks(), change(op), toast(text, isError) }: decks() lists the
// board's decks as app.js's boardDecks() does, change(op) posts to the board
// server and rejects with its reason.
export const DECK_STATUS_TEXT = {
  connecting: 'Connecting',
  ready: 'Ready',
  incompatible: 'Incompatible',
  unreachable: 'Unreachable',
};

export function deckStatusText(d) {
  if (d.duplicate) return 'Already on this board';
  return DECK_STATUS_TEXT[d.status] || d.status || '';
}

function deckStatusTitle(d) {
  if (d.duplicate) return 'This URL reaches a deck the board already shows';
  if (d.status === 'incompatible') return `This deck speaks deck API ${d.descriptor?.api ?? '?'}, which this board does not`;
  if (d.status === 'unreachable') return 'The board cannot reach GET /deck on this URL. Check that the deck runs and lets this board\'s origin in.';
  return '';
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function statusChip(d) {
  return el('span', { className: `deck-status ${d.duplicate ? 'incompatible' : d.status}`, textContent: deckStatusText(d), title: deckStatusTitle(d) });
}

function deckRow(d, bridge) {
  const save = (patch) => bridge.change({ op: 'update', id: d.id, ...patch }).catch((err) => bridge.toast(err.message, true));
  const colour = el('input', { type: 'color', value: d.entry.colour || '#7a8699', title: 'Deck colour', ariaLabel: `Colour for ${d.name}` });
  colour.addEventListener('change', () => save({ colour: colour.value }));
  const name = el('input', { type: 'text', className: 'setting-text-input deck-name-input', value: d.entry.name || '', placeholder: d.descriptor?.name || d.name, maxLength: 40, ariaLabel: 'Deck name' });
  name.addEventListener('change', () => save({ name: name.value.trim() }));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
  const where = el('span', { className: 'deck-url', textContent: d.own ? 'This board\'s own deck' : d.entry.url, title: d.own ? '' : d.entry.url });
  const row = el('div', { className: 'deck-row', dataset: { id: d.id } }, colour, name, where, statusChip(d));
  if (!d.own) {
    const remove = el('button', { type: 'button', className: 'ghost deck-remove', textContent: 'Remove', title: 'Take this deck off the board. Its sessions keep running on it.' });
    remove.addEventListener('click', () => bridge.change({ op: 'remove', id: d.id }).catch((err) => bridge.toast(err.message, true)));
    row.append(remove);
  }
  return row;
}

function addForm(bridge) {
  const url = el('input', { type: 'text', className: 'setting-text-input', placeholder: 'http://127.0.0.1:7890', ariaLabel: 'Deck URL' });
  const name = el('input', { type: 'text', className: 'setting-text-input', placeholder: 'Name (optional)', maxLength: 40, ariaLabel: 'New deck name' });
  const add = el('button', { type: 'button', className: 'primary deck-add-btn', textContent: 'Add deck' });
  const error = el('div', { className: 'deck-add-error', role: 'status' });
  const submit = () => {
    error.textContent = '';
    add.disabled = true;
    bridge.change({ op: 'add', url: url.value.trim(), name: name.value.trim() })
      .then(() => { url.value = ''; name.value = ''; })
      .catch((err) => { error.textContent = err.message; })
      .finally(() => { add.disabled = false; });
  };
  add.addEventListener('click', submit);
  for (const input of [url, name]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  return el('div', {}, el('div', { className: 'deck-add' }, url, name, add), error);
}

// Rebuilds the panel, unless someone is typing in it: then only the status
// chips move, so a half-typed name or URL is never wiped by a status change.
export function mountDecksPanel(root, bridge) {
  if (!root) return;
  const decks = bridge.decks();
  const typing = root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  const rows = [...root.querySelectorAll('.deck-row')];
  if (typing && rows.length === decks.length && rows.every((r, i) => r.dataset.id === decks[i].id)) {
    rows.forEach((r, i) => r.querySelector('.deck-status').replaceWith(statusChip(decks[i])));
    return;
  }
  const help = el('div', { className: 'setting-help', textContent: `Every deck here shows its sessions on this board, and each card\'s actions, terminal and files go to the deck it is on. A deck lets a board in only from an origin it allows: start it with --allowed-origins ${location.origin}.` });
  root.replaceChildren(help, ...decks.map((d) => deckRow(d, bridge)), addForm(bridge));
}
