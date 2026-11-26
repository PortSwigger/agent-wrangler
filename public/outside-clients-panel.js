import { timeAgo } from './util.js';

// Settings › Automation › Outside MCP clients: the deck's named client tokens
// (server/session-api/clients.js). A program on the deck's machine that is not
// a session calls /mcp with one and is offered only the extension tools its
// scopes list. Minting, listing and revoking are deck actions
// (admin.outside-client*), never MCP tools. A new token is shown once, here,
// until Done or the panel is drawn again; nothing keeps it.
// Built with textContent throughout: client names are typed by people and
// scope labels come from extensions.
//
// `bridge` is { act(action, args) -> Promise<{ ok, data, error }>, copy(text) }.

export const CLIENT_DEFAULT_DAYS = 30;
export const CLIENT_MAX_DAYS = 365;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function expiryText(client, now = Date.now()) {
  if (client.expired || client.expiresAt <= now) return 'Expired';
  const days = Math.ceil((client.expiresAt - now) / DAY_MS);
  return days <= 1 ? 'Expires within a day' : `Expires in ${days} days`;
}

export function lastUseText(client) {
  if (!client.lastUsedAt) return 'Never used';
  const when = timeAgo(client.lastUsedAt) || 'just now';
  return client.lastTool ? `Last used ${when} · ${client.lastTool}` : `Last used ${when}`;
}

export const scopeName = (sc) => `${sc.extension} · ${sc.label}`;

function scopeChips(client, scopes) {
  const byKey = new Map(scopes.map((sc) => [sc.key, sc]));
  return el('span', { className: 'oc-scopes' }, ...client.scopes.map((key) => {
    const sc = byKey.get(key);
    return el('span', { className: `oc-scope${sc ? '' : ' gone'}`, textContent: sc ? scopeName(sc) : key, title: sc ? sc.tools.join(', ') : 'No enabled extension offers this scope now' });
  }));
}

function clientRow(client, view) {
  const revoke = el('button', { type: 'button', className: 'ghost oc-revoke', textContent: 'Revoke', title: `Revoke ${client.name}: its token stops working at once` });
  revoke.addEventListener('click', () => view.revoke(client.id, revoke));
  return el('div', { className: `oc-row${client.expired ? ' expired' : ''}`, dataset: { id: client.id } },
    el('span', { className: 'oc-name', textContent: client.name }),
    scopeChips(client, view.state.scopes),
    revoke,
    el('span', { className: 'oc-meta', textContent: `${expiryText(client)} · ${lastUseText(client)}`, title: client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : '' }));
}

function tokenBox(minted, token, endpoint, view) {
  const input = el('input', { type: 'text', className: 'setting-text-input oc-token-value', value: token, readOnly: true, ariaLabel: `Token for ${minted.name}`, spellcheck: false });
  input.addEventListener('focus', () => input.select());
  const copy = el('button', { type: 'button', className: 'primary', textContent: 'Copy' });
  copy.addEventListener('click', () => {
    Promise.resolve(view.bridge.copy?.(token)).then(() => { copy.textContent = 'Copied'; }, () => { input.select(); });
  });
  const done = el('button', { type: 'button', className: 'ghost', textContent: 'Done' });
  done.addEventListener('click', () => view.render());
  return el('div', { className: 'oc-token', role: 'status' },
    el('div', { className: 'setting-label', textContent: `Token for ${minted.name}` }),
    el('div', { className: 'setting-help', textContent: `Copy it now: it is shown once and cannot be read back. Send it as "Authorization: Bearer <token>"${endpoint?.url ? ` to ${endpoint.url}` : ''}.` }),
    el('div', { className: 'oc-token-row' }, input, copy, done));
}

function addForm(view) {
  const { scopes } = view.state;
  const name = el('input', { type: 'text', className: 'setting-text-input oc-new-name', placeholder: 'Name, e.g. jobs-bot', maxLength: 40, ariaLabel: 'New client name' });
  const days = el('input', { type: 'number', className: 'setting-text-input oc-new-days', value: String(CLIENT_DEFAULT_DAYS), min: '1', max: String(CLIENT_MAX_DAYS), step: '1', ariaLabel: 'Days until the token expires' });
  const boxes = scopes.map((sc) => {
    const box = el('input', { type: 'checkbox', value: sc.key });
    return el('label', { className: 'oc-scope-choice' }, box,
      el('span', { className: 'oc-scope-copy' },
        el('span', { className: 'setting-label', textContent: scopeName(sc) + (sc.exclusive ? ' (one client at a time)' : '') }),
        sc.description ? el('span', { className: 'setting-help', textContent: sc.description }) : null,
        el('span', { className: 'oc-scope-tools', textContent: sc.tools.join(', ') })));
  });
  const mint = el('button', { type: 'button', className: 'primary oc-mint', textContent: 'Mint token', disabled: !scopes.length });
  const error = el('div', { className: 'deck-add-error oc-error', role: 'status' });
  const submit = () => {
    error.textContent = '';
    const picked = boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
    mint.disabled = true;
    view.bridge.act('admin.outside-client-mint', { name: name.value, scopes: picked, days: Number(days.value) })
      .then((r) => {
        if (!r?.ok) { error.textContent = r?.error?.message || 'Minting failed'; mint.disabled = false; return; }
        view.state = r.data;
        view.render({ minted: r.data.minted, token: r.data.token });
      }, (err) => { error.textContent = err?.message || 'Minting failed'; mint.disabled = false; });
  };
  mint.addEventListener('click', submit);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  const choices = scopes.length
    ? el('div', { className: 'oc-scope-choices' }, ...boxes)
    : el('div', { className: 'settings-empty', textContent: 'No enabled extension offers scopes for outside clients yet.' });
  return el('div', { className: 'oc-add' },
    el('div', { className: 'setting-label', textContent: 'New client' }),
    el('div', { className: 'oc-add-fields' }, name, el('label', { className: 'oc-days' }, 'Expires in ', days, ' days')),
    choices,
    el('div', { className: 'oc-add-actions' }, mint),
    error);
}

export function mountOutsideClientsPanel(root, bridge) {
  if (!root) return null;
  const view = { root, bridge, state: null };
  view.render = (reveal = null) => {
    const { clients, scopes, endpoint } = view.state;
    const help = el('div', { className: 'setting-help', textContent: `A program on this machine that is not a session (a bot built on an agent SDK, say) can call this deck's MCP tools${endpoint?.url ? ` at ${endpoint.url}` : ''} with a client token. It is offered only the extension tools its scopes list, never session tools, mail or messages, and only from this machine.` });
    const warn = endpoint && !endpoint.loopback
      ? el('div', { className: 'deck-add-error oc-warning', role: 'status', textContent: `The session API is bound to ${endpoint.host || 'a non-loopback address'}, beyond loopback, so every client token is refused until it is bound to 127.0.0.1.` })
      : null;
    const rows = clients.length
      ? el('div', { className: 'oc-rows' }, ...clients.map((c) => clientRow(c, view)))
      : el('div', { className: 'settings-empty', textContent: 'No outside clients.' });
    root.replaceChildren(...[
      el('div', { className: 'setting-label oc-title', textContent: 'Outside MCP clients' }),
      help, warn,
      reveal ? tokenBox(reveal.minted, reveal.token, endpoint, view) : null,
      rows, addForm(view)].filter(Boolean));
    if (reveal) root.querySelector('.oc-token-value')?.focus();
  };
  view.revoke = (id, button) => {
    button.disabled = true;
    bridge.act('admin.outside-client-revoke', { id }).then((r) => {
      if (r?.ok) { view.state = r.data; view.render(); return; }
      button.disabled = false;
      bridge.toast?.(r?.error?.message || 'Revoking failed', true);
    });
  };
  root.replaceChildren(el('div', { className: 'settings-empty', textContent: 'Loading outside clients…' }));
  bridge.act('admin.outside-clients', {}).then((r) => {
    if (!root.isConnected && root.parentNode == null) return;
    if (!r?.ok) {
      root.replaceChildren(el('div', { className: 'setting-label oc-title', textContent: 'Outside MCP clients' }),
        el('div', { className: 'settings-empty', textContent: r?.error?.code === 'unsupported' ? 'This deck does not offer outside MCP clients.' : (r?.error?.message || 'Could not load outside clients.') }));
      return;
    }
    view.state = r.data;
    view.render();
  });
  return view;
}
