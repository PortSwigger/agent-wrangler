import { COPY_ICON, CHECK_ICON, PROMOTE_ICON, RESTART_ICON, GITHUB_ICON, STAR_ICON } from './icons.js';

// The Extensions settings tab and the install/update consent modal. Pure DOM
// builders with no app state, like toast.js and system-banner.js: settings.js
// mounts what these return.
//
// LIST + DETAIL. The left pane lists every extension, builtin under "Core" and
// external under "Installed" (by `entry.external`), each with an enabled dot;
// the right pane shows the selected one's toggle, source and settings inline.
// The detail header is a `.setting-row` carrying `data-id="ext:<id>"` and a
// `.setting-toggle`, which is exactly what settings.js's own delegated click
// handler already drives, so there is no second flip path and no second flip note.
//
// EVERY third-party string here — label, description, origin, capability names,
// dependency names, quarantine reasons — goes in via textContent, never
// innerHTML. Same rule as diff-dom.js and checklist-dom.js, and for a sharper
// reason: this content came off a git URL a colleague pasted. That is also why
// these rows are built here rather than by settings.js's innerHTML+esc() rowHtml.
//
// The trust statement is the FIRST thing the consent modal renders, and its
// wording is deliberate and must not be softened: an extension runs in-process
// with full access to the machine. `requires` is disclosure and
// accident-containment, not a security boundary; the browser half is trusted
// exactly as much as the server half; `npm ci --ignore-scripts` is a mitigation,
// not a sandbox. Nothing in this file may imply otherwise.

export const TRUST_STATEMENT = 'An extension runs inside the wrangler with full access to this machine — your files, your repositories and your agent sessions. The capability list below is disclosure, not a sandbox: it says what the extension asked the wrangler for, and nothing prevents its code (or any of its dependencies) from doing more. Install this only if you trust whoever wrote it, exactly as you would trust a package you npm install into the server.';

// The two things a live registry still cannot do in process. An UNINSTALL
// deregisters the extension but cannot reclaim the module Node has already
// cached, so the code stays resident until the next start; an UPDATE of an
// already-registered id keeps restart semantics on purpose, because two
// versions of one extension must never run at once. Everything else — install,
// enable, disable — lands immediately and never reaches this note. Where the
// server says it can restart itself (`canRestart`, only under a supervisor) the
// note is accompanied by the button that does it — an uninstall that visibly
// changes nothing until some unexplained later restart is the single worst
// thing this panel did.
// The server's textarea cap (server/extensions/setting-constraints.js),
// mirrored so the field stops at it rather than the write failing.
export const MAX_TEXTAREA_LENGTH = 20000;

export const RESTART_NOTE = 'Restart the wrangler to finish.';

// An uninstall gets its OWN note, because "to finish" would be a lie there: the
// row, tools, handlers, stores, sweeps and client asset are all gone already and
// the reader can see that. The only thing left is the module Node cannot unload
// and whatever its top-level code started, so the note says exactly that rather
// than implying the uninstall is half-done.
export const UNINSTALL_RESTART_NOTE = 'Its code stays in memory until the wrangler restarts.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Plain-language descriptions for capabilities a name alone does not explain,
// shown as the chip's tooltip, and as a line under the chips in the consent dialog.
export const CAPABILITY_DESCRIPTIONS = {
  'cards:hideChips': 'Hide chips in the session cards\' meta row (presentation only; nothing is removed).',
};

function chipsEl(items, className) {
  const wrap = el('div', 'ext-chips');
  for (const item of items) {
    const chip = el('span', className, item);
    if (CAPABILITY_DESCRIPTIONS[item]) chip.title = CAPABILITY_DESCRIPTIONS[item];
    wrap.append(chip);
  }
  return wrap;
}

// The requested chips plus, below them, a plain sentence for each capability
// with a description.
function capabilitiesEl(caps) {
  const box = el('div');
  box.append(chipsEl(caps, 'ext-chip'));
  for (const c of caps) if (CAPABILITY_DESCRIPTIONS[c]) box.append(el('div', 'ext-consent-note', `${c}: ${CAPABILITY_DESCRIPTIONS[c]}`));
  return box;
}

function section(parent, title, body) {
  parent.append(el('div', 'ext-section-title', title));
  if (body) parent.append(body);
}

function noteEl(className, text) {
  const note = el('div', className, text);
  note.setAttribute('role', 'status');
  return note;
}

// An origin is displayed as a link only when it is https://. A third-party
// supplied href is not worth the navigation surface for a decoration, and ssh://
// is not navigable at all.
function originNode(origin) {
  if (!origin) return null;
  if (!/^https:\/\//.test(origin)) return el('span', 'ext-row-origin', origin);
  const a = el('a', 'ext-row-origin', origin);
  a.href = origin;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  return a;
}

// The restart affordance, drawn ONCE at the top of the detail pane rather than
// per extension: a restart is a whole-wrangler action, and several pending
// extensions would otherwise each draw a button that does exactly the same thing.
//
// Absent when the server did not say it can restart itself: under `npm start`
// an exit is a shutdown with nothing to bring the board back, so there is
// nothing honest to offer.
function restartButtonEl({ restarting, onRestart } = {}) {
  const btn = el('button', 'ext-btn ext-btn-warn', restarting ? 'Restarting…' : 'Restart now');
  btn.type = 'button';
  btn.disabled = Boolean(restarting);
  btn.addEventListener('click', () => onRestart?.());
  return btn;
}

function iconButtonEl(className, icon, label, onClick) {
  const btn = el('button', className);
  btn.type = 'button';
  btn.innerHTML = icon;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', onClick);
  return btn;
}

const nameOf = (entry) => entry.label || entry.id;

// Only an extension whose last check found a newer commit, and that is still
// here to update.
const hasUpdate = (entry, status, removing) => Boolean(entry.external && entry.origin && status?.behind && !removing);

// One entry in the left pane: a status dot (filled = enabled, hollow =
// disabled) and the name, plus — when the last check found a newer commit — a
// one-click update button beside it. The two are siblings, not nested, because
// a button inside a button is not a thing a browser will click reliably.
export function extensionListItemEl(entry, { selected, status, pendingRemoval, onSelect, onUpdate } = {}) {
  const on = entry.enabled && !entry.quarantine && !pendingRemoval;
  const row = el('div', `ext-list-row${selected ? ' selected' : ''}${on ? '' : ' off'}`);
  row.dataset.extId = entry.id;
  const pick = el('button', 'ext-list-item');
  pick.type = 'button';
  pick.setAttribute('aria-current', selected ? 'true' : 'false');
  pick.append(el('span', `ext-dot${on ? ' on' : ''}`));
  pick.append(el('span', 'ext-list-name', nameOf(entry)));
  pick.addEventListener('click', () => onSelect?.(entry.id));
  row.append(pick);
  if (hasUpdate(entry, status, pendingRemoval)) {
    row.append(iconButtonEl('ext-btn ext-btn-dark ext-btn-square', PROMOTE_ICON, `Update ${nameOf(entry)}`, () => onUpdate?.(entry)));
  }
  return row;
}

function kvRow(list, key, value) {
  const row = el('div', 'ext-kv-row');
  row.append(el('div', 'ext-kv-key', key));
  const v = el('div', 'ext-kv-value');
  v.append(value);
  row.append(v);
  list.append(row);
}

// Where it came from. The origin is a link only when it is https:// — a
// third-party href is not worth the navigation surface otherwise, and ssh:// is
// not navigable at all.
function sourceEl(entry) {
  const list = el('div', 'ext-kv');
  kvRow(list, 'Type', document.createTextNode(entry.external ? 'Installed from git' : 'Core'));
  if (entry.origin) {
    const repo = el('span', 'ext-kv-repo');
    repo.append(el('span', 'ext-mono', entry.origin));
    if (/^https:\/\//.test(entry.origin)) {
      const a = el('a', 'ext-kv-open', 'Open ↗');
      a.href = entry.origin;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      repo.append(a);
    }
    kvRow(list, 'Repository', repo);
  }
  if (entry.sha) kvRow(list, 'Commit', el('span', 'ext-mono', entry.sha.slice(0, 8)));
  return list;
}

// The right pane for one extension. The header row is a `.setting-row` with
// `data-id="ext:<id>"` around a `.setting-toggle`, which is exactly what
// settings.js's delegated click handler already drives (and where it puts its
// flip note), so the enable switch has no second flip path.
export function extensionDetailEl(entry, {
  status, pendingRemoval, settings, onUninstall,
} = {}) {
  const pane = el('div', 'ext-detail-body');
  const head = el('div', 'setting-row ext-detail-head');
  head.dataset.id = `ext:${entry.id}`;
  const copy = el('div', 'setting-copy');
  copy.append(el('div', 'ext-detail-name', nameOf(entry)));
  const blurb = entry.description || entry.help;
  if (blurb) copy.append(el('div', 'setting-help', blurb));
  head.append(copy);
  if (!pendingRemoval) {
    const actions = el('div', 'ext-row-actions');
    actions.append(el('span', 'ext-detail-enabled', 'Enabled'));
    const toggle = el('button', `setting-toggle${entry.enabled ? ' on' : ''}`);
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', entry.enabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', nameOf(entry));
    toggle.append(el('span', 'setting-knob'));
    actions.append(toggle);
    if (entry.external) {
      const remove = el('button', 'ext-btn ext-btn-danger', 'Uninstall…');
      remove.type = 'button';
      remove.addEventListener('click', () => onUninstall?.(entry));
      actions.append(remove);
    }
    head.append(actions);
  }
  pane.append(head);

  if (entry.quarantine && !pendingRemoval) {
    const note = noteEl('ext-row-quarantine', '');
    note.append(el('strong', null, 'Quarantined: '));
    note.append(document.createTextNode(entry.quarantine));
    note.append(el('div', 'ext-row-quarantine-help', 'It is not running. Fix or reinstall it; a builtin needs a restart.'));
    pane.append(note);
  }
  // Only ever the transitional frame: an uninstall deregisters the extension, so
  // this survives just the gap until the graph drops it from `entries`.
  if (pendingRemoval) pane.append(noteEl('ext-row-note', `Uninstalled. ${UNINSTALL_RESTART_NOTE}`));
  else if (status) pane.append(noteEl('ext-row-note', updateStatusText(status)));

  section(pane, 'Source', sourceEl(entry));
  if (settings && !pendingRemoval) section(pane, 'Settings', settings);
  return pane;
}

// "+ Add extension" in the detail pane: the paste-a-git-URL form, then the
// GitHub browser — public repositories carrying the extension topic, as cards.
// A card's Install… sends its clone URL down the same `onInstall` as the form,
// so it gets the same clone, disclosure and consent modal; nothing is skipped
// for having been found here.
function addExtensionEl({ busy, onInstall, browse, installedOrigins, onBrowse }) {
  const pane = el('div', 'ext-detail-body');
  const head = el('div', 'ext-detail-head');
  const copy = el('div', 'setting-copy');
  copy.append(el('div', 'ext-detail-name', 'Add extension'));
  copy.append(el('div', 'setting-help', 'Paste an https:// or ssh:// git URL, or pick one from GitHub below. The wrangler fetches it and shows you what it asks for before anything is installed.'));
  head.append(copy);
  pane.append(head);
  const form = el('div', 'ext-install-form');
  const input = el('input', 'ext-install-url');
  input.type = 'text';
  input.placeholder = 'https://github.com/…';
  input.setAttribute('aria-label', 'Extension git URL');
  const go = el('button', 'ext-btn ext-btn-primary', 'Install…');
  go.type = 'button';
  go.disabled = busy;
  const submit = () => {
    const url = input.value.trim();
    if (url) onInstall?.(url);
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  form.append(input, go);
  pane.append(form);
  if (browse) pane.append(githubBrowserEl({ browse, busy, installedOrigins, onInstall, onBrowse }));
  return pane;
}

export const EXTENSION_TOPIC = 'agent-wrangler-extension';

// The browser's own warning, and like TRUST_STATEMENT not to be softened: a
// topic is something any repository owner sets on their own repository, so
// being listed here says nothing about who wrote it or what it does.
export const BROWSE_NOTICE = 'Anyone can tag a public repository with this topic, so nothing listed here has been reviewed or endorsed. Read the code and check who wrote it before installing — making sure an extension is safe is up to you.';

// One comparable form for a git remote, so a card can tell it is already
// installed whether the origin was recorded as https, with .git, or as git@.
export function normalizeRepoUrl(url) {
  return String(url || '').trim().toLowerCase()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

const RELATIVE_UNITS = [['year', 365 * 86400], ['month', 30 * 86400], ['week', 7 * 86400], ['day', 86400], ['hour', 3600], ['minute', 60]];

// "Updated 3 days ago" — how alive a repository is matters more than when.
export function updatedAgoText(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, (now - then) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    const n = Math.floor(secs / size);
    if (n >= 1) return `Updated ${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'Updated just now';
}

function compactCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
}

function avatarEl(repo) {
  // The initial is underneath the image, so a blocked or failed avatar still
  // leaves something in the circle rather than a broken-image glyph.
  const box = el('div', 'ext-gh-avatar');
  box.append(el('span', 'ext-gh-avatar-initial', (repo.owner || repo.name || '?').slice(0, 1).toUpperCase()));
  if (repo.avatarUrl) {
    const img = el('img');
    img.src = `${repo.avatarUrl}${repo.avatarUrl.includes('?') ? '&' : '?'}s=80`;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

function repoCardEl(repo, { busy, installed, onInstall }) {
  const card = el('div', `ext-gh-card${installed ? ' installed' : ''}`);
  card.append(avatarEl(repo));
  const body = el('div', 'ext-gh-body');
  const title = el('a', 'ext-gh-title');
  title.href = repo.htmlUrl;
  title.target = '_blank';
  title.rel = 'noreferrer noopener';
  title.title = `Open ${repo.fullName} on GitHub`;
  if (repo.owner) title.append(el('span', 'ext-gh-owner', `${repo.owner} / `));
  title.append(el('span', 'ext-gh-name', repo.name || repo.fullName));
  body.append(title);
  body.append(el('div', `ext-gh-desc${repo.description ? '' : ' empty'}`, repo.description || 'No description.'));
  const meta = el('div', 'ext-gh-meta');
  const stars = el('span', 'ext-gh-stars');
  stars.innerHTML = STAR_ICON;
  stars.append(el('span', null, compactCount(repo.stars)));
  stars.title = `${repo.stars} star${repo.stars === 1 ? '' : 's'}`;
  meta.append(stars);
  if (repo.language) {
    const lang = el('span', 'ext-gh-lang');
    const dot = el('span', 'ext-gh-lang-dot');
    dot.dataset.lang = repo.language;
    lang.append(dot, el('span', null, repo.language));
    meta.append(lang);
  }
  const ago = updatedAgoText(repo.pushedAt);
  if (ago) meta.append(el('span', 'ext-gh-updated', ago));
  body.append(meta);
  card.append(body);

  const action = el('div', 'ext-gh-action');
  if (installed) {
    const badge = el('span', 'ext-gh-installed');
    badge.innerHTML = CHECK_ICON;
    badge.append(el('span', null, 'Installed'));
    action.append(badge);
  } else {
    const btn = el('button', 'ext-btn ext-btn-primary', 'Install…');
    btn.type = 'button';
    btn.disabled = busy;
    btn.setAttribute('aria-label', `Install ${repo.fullName}`);
    btn.addEventListener('click', () => onInstall?.(repo.cloneUrl));
    action.append(btn);
  }
  card.append(action);
  return card;
}

function skeletonCardEl() {
  const card = el('div', 'ext-gh-card ext-gh-skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.append(el('div', 'ext-gh-avatar'));
  const body = el('div', 'ext-gh-body');
  body.append(el('div', 'ext-gh-bar wide'), el('div', 'ext-gh-bar'), el('div', 'ext-gh-bar short'));
  card.append(body);
  return card;
}

// `browse` is `{ loading, error, repos }`, owned by app.js so a remount keeps
// it. Installed repositories sink below the rest: the point of the list is
// what you could add.
function githubBrowserEl({ browse, busy, installedOrigins = [], onInstall, onBrowse }) {
  const wrap = el('div', 'ext-gh');
  const head = el('div', 'ext-gh-head');
  const heading = el('div', 'ext-gh-heading');
  heading.innerHTML = GITHUB_ICON;
  heading.append(el('span', null, 'Browse GitHub'));
  const repos = browse.repos || [];
  if (!browse.loading && repos.length) heading.append(el('span', 'ext-gh-count', String(repos.length)));
  head.append(heading);
  const topic = el('a', 'ext-gh-topic', EXTENSION_TOPIC);
  topic.href = `https://github.com/topics/${EXTENSION_TOPIC}`;
  topic.target = '_blank';
  topic.rel = 'noreferrer noopener';
  topic.title = 'The GitHub topic this list is built from';
  head.append(topic);
  const refresh = el('button', 'ext-btn ext-btn-sm ext-gh-refresh');
  refresh.type = 'button';
  refresh.innerHTML = RESTART_ICON;
  refresh.append(el('span', null, browse.loading ? 'Searching…' : 'Refresh'));
  refresh.setAttribute('aria-label', 'Search GitHub again');
  refresh.disabled = Boolean(browse.loading);
  refresh.addEventListener('click', () => onBrowse?.());
  head.append(refresh);
  wrap.append(head);

  const notice = el('div', 'ext-gh-notice');
  notice.setAttribute('role', 'note');
  notice.append(el('span', 'ext-gh-notice-lead', 'Community extensions are unvetted.'), document.createTextNode(` ${BROWSE_NOTICE}`));
  wrap.append(notice);

  const list = el('div', 'ext-gh-list');
  list.setAttribute('aria-busy', browse.loading ? 'true' : 'false');
  if (browse.loading) {
    for (let i = 0; i < 3; i += 1) list.append(skeletonCardEl());
  } else if (browse.error) {
    list.append(el('div', 'ext-gh-empty ext-gh-error', `Could not search GitHub: ${browse.error}`));
  } else if (!repos.length) {
    const empty = el('div', 'ext-gh-empty');
    empty.append(el('div', 'ext-gh-empty-lead', 'Nothing tagged yet.'));
    empty.append(el('div', null, `Add the ${EXTENSION_TOPIC} topic to a public extension repository to list it here.`));
    list.append(empty);
  } else {
    const have = new Set(installedOrigins.map(normalizeRepoUrl));
    const isInstalled = (r) => have.has(normalizeRepoUrl(r.htmlUrl));
    const ordered = [...repos.filter((r) => !isInstalled(r)), ...repos.filter(isInstalled)];
    for (const repo of ordered) list.append(repoCardEl(repo, { busy, installed: isInstalled(repo), onInstall }));
  }
  wrap.append(list);
  return wrap;
}

// One row per declared setting, for ONE extension — the Settings section of
// its detail pane.
//
// These rows carry `data-ext`/`data-key` and deliberately NOT `data-id`:
// settings.js's delegated click handler picks up any `.setting-toggle` in the
// modal and looks the row up with `byId.get(row.dataset.id)`. With no `data-id`
// that lookup misses and settings.js bails, which is what keeps a toggle-type
// SETTING from flipping the EXTENSION's enable flag. Putting `ext:<id>` on one
// of these rows would do exactly that.
//
// Disabled only when the extension is QUARANTINED — it is contributing nothing
// and could not read the value back. NOT disabled when it is merely toggled
// off: a value is config, it persists across the toggle and across an
// uninstall/reinstall, and setting a registry URL before switching the thing on
// is the natural order to do the two in.
export function extensionSettingRowsEl(entry, { onSettingChange } = {}) {
  const wrap = el('div', 'ext-settings');
  const values = entry.settingValues || {};
  const frozen = Boolean(entry.quarantine);
  for (const def of entry.settings || []) {
    // Managed by the extension itself (a settings.panel), never a row.
    if (def.hidden) continue;
    const row = el('div', 'ext-setting-row');
    row.dataset.ext = entry.id;
    row.dataset.key = def.key;
    const copy = el('div', 'setting-copy');
    copy.append(el('div', 'setting-label', def.label));
    if (def.help) copy.append(el('div', 'setting-help', def.help));
    const current = values[def.key];
    const commit = (value) => onSettingChange?.({ id: entry.id, key: def.key, value });
    if (def.type === 'list') {
      copy.append(listEditorEl(def, current, { frozen, commit }));
      row.append(copy);
      wrap.append(row);
      continue;
    }
    if (def.type === 'toggle') {
      const actions = el('div', 'ext-row-actions');
      let on = Boolean(current);
      const toggle = el('button', `setting-toggle${on ? ' on' : ''}`);
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', on ? 'true' : 'false');
      toggle.setAttribute('aria-label', def.label);
      toggle.disabled = frozen;
      toggle.append(el('span', 'setting-knob'));
      // Its OWN listener, because settings.js's delegated one deliberately
      // cannot see this row (no data-id) — see the note above.
      //
      // It also has to move the switch ITSELF, exactly as settings.js's
      // delegated handler does after setSetting: these rows are only rebuilt on
      // a remount, and app.js's remount signature excludes settingValues on
      // purpose, so nothing else is coming to redraw it. A text input keeps the
      // typed text because the browser holds it; a switch has no such state of
      // its own, so without this the click reads as having done nothing at all.
      // `on` is the live local value for the same reason — captured once, a
      // second click would re-send the value the first one already stored.
      toggle.addEventListener('click', () => {
        if (toggle.disabled) return;
        on = !on;
        toggle.classList.toggle('on', on);
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
        commit(on);
      });
      actions.append(toggle);
      row.append(copy, actions);
    } else {
      let input;
      if (def.type === 'select') {
        input = el('select', 'ext-setting-input');
        // A leading empty option is the ONLY clearing route a select has —
        // `''` reaches the handler as "cleared" and constraints are skipped for
        // it, exactly as an empty text field is.
        const blank = el('option');
        blank.value = '';
        blank.textContent = '';
        input.append(blank);
        for (const o of def.options || []) {
          const opt = el('option');
          // Property and textContent, never markup: an option's label is
          // third-party prose off a git URL a colleague pasted.
          opt.value = o.value;
          opt.textContent = o.label;
          input.append(opt);
        }
      } else if (def.type === 'textarea') {
        input = el('textarea', 'ext-setting-input ext-setting-textarea');
        input.placeholder = def.placeholder || '';
        input.maxLength = def.maxLength ?? MAX_TEXTAREA_LENGTH;
      } else {
        input = el('input', 'ext-setting-input');
        input.type = def.type === 'number' ? 'number' : 'text';
        input.placeholder = def.placeholder || '';
        // The declared constraints, mirrored onto the native input. An
        // AFFORDANCE only — the server write path is the enforcement — and set
        // only when declared, so an unconstrained setting's markup is unchanged.
        if (def.type === 'number') {
          for (const k of ['min', 'max', 'step']) if (def[k] != null) input.setAttribute(k, String(def[k]));
        } else {
          if (def.maxLength != null) input.maxLength = def.maxLength;
          if (def.pattern != null) input.setAttribute('pattern', def.pattern);
        }
      }
      // Property assignment, never markup: this is third-party prose and a
      // human's own text, and neither goes anywhere near innerHTML.
      input.value = current == null ? '' : String(current);
      input.setAttribute('aria-label', def.label);
      input.disabled = frozen;
      // Empty text means invisible, so this reserves no space until the
      // browser has something to say about the value.
      const error = el('div', 'setting-error');
      // Committed on `change` (blur or Enter) and on Enter, never per
      // keystroke: a control frame and a config.json write per character is not
      // a thing to ship. An empty field commits as `''` (text) or `null`
      // (number), which is how a value is cleared. `last` is what keeps Enter
      // from sending twice — the browser fires `change` for it too — and keeps
      // a blur that changed nothing from writing at all.
      let last = input.value;
      const send = () => {
        if (input.value === last) return;
        // Native validity, not a second copy of the server's rule engine: the
        // message a human reads is the browser's own wording, which is the
        // price of not keeping two sets of strings in step. Optional-called
        // because the panel's tests drive a hand-rolled DOM — a stub without
        // the method reads as valid rather than throwing.
        if (input.checkValidity?.() === false) {
          error.textContent = input.validationMessage || '';
          // `last` deliberately NOT moved: leaving it on the rejected text
          // would make the corrected value look unchanged and swallow the fix.
          return;
        }
        error.textContent = '';
        last = input.value;
        commit(def.type === 'number' ? (last === '' ? null : Number(last)) : last);
      };
      input.addEventListener('change', send);
      // A textarea commits on `change` alone: Enter is a newline there.
      if (def.type !== 'textarea') {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); send(); } });
      }
      // Beneath the label rather than out in the actions column, exactly like
      // the install field: a URL is long and a 38px-wide switch's slot is not
      // where one goes.
      if (def.type === 'textarea' && def.placeholder) {
        const box = el('div', 'ext-setting-copybox');
        const btn = el('button', 'ext-setting-copy');
        btn.type = 'button';
        btn.innerHTML = COPY_ICON;
        btn.setAttribute('aria-label', 'Copy default text');
        btn.title = 'Copy the default text to the clipboard';
        btn.addEventListener('click', () => {
          const done = () => {
            btn.innerHTML = CHECK_ICON;
            setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1500);
          };
          navigator.clipboard?.writeText(def.placeholder).then(done, () => {});
        });
        const sync = () => { btn.hidden = input.value !== ''; };
        input.addEventListener('input', sync);
        sync();
        box.append(input, btn);
        copy.append(box, error);
      } else {
        copy.append(input, error);
      }
      row.append(copy);
    }
    wrap.append(row);
  }
  return wrap;
}

// A `list` setting's editor: one field per item with a remove button, then an
// add field. Every edit commits the WHOLE array. Like the toggle, it keeps its
// own `items` and redraws itself, because nothing remounts these rows after a
// value edit. Items are trimmed, a blanked item is removed, and a duplicate, an
// item past maxItems, or one failing the def's pattern/maxLength is refused
// here with a message. The server still
// enforces all of this; checking here only lets the editor say why.
function listEditorEl(def, current, { frozen, commit }) {
  const box = el('div', 'ext-setting-list');
  const itemsEl = el('div', 'ext-setting-list-items');
  const error = el('div', 'setting-error');
  let items = Array.isArray(current) ? current.filter((v) => typeof v === 'string') : [];
  const max = def.maxItems ?? Infinity;

  const save = (next) => {
    error.textContent = '';
    items = next;
    commit([...items]);
    draw();
  };
  const refuse = (msg) => { error.textContent = msg; };
  // maxLength and pattern apply to EACH item, mirrored onto every field and
  // checked with the browser's own validity, as the text input does.
  const constrain = (input) => {
    if (def.maxLength != null) input.maxLength = def.maxLength;
    if (def.pattern != null) input.setAttribute('pattern', def.pattern);
  };
  const invalid = (input) => {
    if (input.checkValidity?.() !== false) return false;
    refuse(input.validationMessage || 'Not a valid item');
    return true;
  };

  const draw = () => {
    itemsEl.textContent = '';
    items.forEach((item, i) => {
      const line = el('div', 'ext-setting-list-item');
      const input = el('input', 'ext-setting-input');
      input.type = 'text';
      input.value = item;
      input.disabled = frozen;
      input.setAttribute('aria-label', `${def.label} item ${i + 1}`);
      constrain(input);
      const edit = () => {
        const v = input.value.trim();
        if (v === items[i]) return;
        if (!v) { save(items.filter((_, j) => j !== i)); return; }
        if (invalid(input)) return;
        if (items.some((x, j) => j !== i && x === v)) { refuse(`"${v}" is already in the list`); return; }
        save(items.map((x, j) => (j === i ? v : x)));
      };
      input.addEventListener('change', edit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); edit(); } });
      const remove = el('button', 'ext-btn ext-setting-list-remove', '×');
      remove.type = 'button';
      remove.disabled = frozen;
      remove.setAttribute('aria-label', `Remove ${def.label} item ${i + 1}`);
      remove.addEventListener('click', () => save(items.filter((_, j) => j !== i)));
      line.append(input, remove);
      itemsEl.append(line);
    });
  };

  const addLine = el('div', 'ext-setting-list-item');
  const addInput = el('input', 'ext-setting-input');
  addInput.type = 'text';
  addInput.placeholder = def.placeholder || 'Add an item';
  addInput.disabled = frozen;
  addInput.setAttribute('aria-label', `Add to ${def.label}`);
  constrain(addInput);
  const addBtn = el('button', 'ext-btn', 'Add');
  addBtn.type = 'button';
  addBtn.disabled = frozen;
  const add = () => {
    const v = addInput.value.trim();
    if (!v) return;
    if (invalid(addInput)) return;
    if (items.includes(v)) { refuse(`"${v}" is already in the list`); return; }
    if (items.length >= max) { refuse(`At most ${max} items`); return; }
    addInput.value = '';
    save([...items, v]);
  };
  addBtn.addEventListener('click', add);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); add(); } });
  addLine.append(addInput, addBtn);

  draw();
  box.append(itemsEl, addLine, error);
  return box;
}

// Run before the detail pane is torn down (a remount, a different selection):
// a textarea commits on blur only, and removing it does not reliably blur it
// first, so an edit would otherwise be lost.
export function commitFocusedField(container, doc = document) {
  const active = doc.activeElement;
  if (active && container.contains(active)) active.blur();
}

// The settings an extension declares, drawn inline in its detail pane: the
// manifest rows, or nothing when every def is hidden or there are none.
function defaultSettingsEl(entry, onSettingChange) {
  if (!(entry.settings || []).some((d) => !d.hidden)) return null;
  return extensionSettingRowsEl(entry, { onSettingChange });
}

// The whole Extensions tab: a list pane (filter, Core and Installed groups,
// "+ Add extension") beside a detail pane for the selected extension. Built as
// one element per mount (settings.js's `extensionsBridge.mount`, and app.js on
// every state change) rather than patched in place. Selection, the filter text
// and the add form are the caller's state, passed back in, so a remount keeps
// them.
//
// `settingsEl(entry)` lets the caller supply the Settings section (app.js adds
// the extension's own settings.panel contributions); without it the manifest
// rows are drawn with `onSettingChange`.
export function extensionsPanelEl({
  entries = [], statuses = {}, checking = false, progress = '', busy = false,
  pendingRemoval = [], pendingInstall = '', canRestart = false, restarting = false,
  selectedId = '', filter = '', adding = false, browse = null,
  onSelect, onFilter, onAdd, onInstall, onBrowse, onUninstall, onUpdate, onUpdateAll,
  onCheckUpdates, onRestart, onSettingChange, settingsEl,
} = {}) {
  const wrap = el('div', 'ext-split');
  const removing = new Set(pendingRemoval);
  const statusOf = (entry) => (checking && entry.external && entry.origin ? { checking: true } : statuses[entry.id]);
  const core = entries.filter((e) => !e.external);
  const installed = entries.filter((e) => e.external);
  const selected = adding ? null : (entries.find((e) => e.id === selectedId) || entries[0] || null);

  // ── List pane ──
  const list = el('div', 'ext-list');
  const search = el('input', 'ext-filter');
  search.type = 'text';
  search.placeholder = 'Filter';
  search.setAttribute('aria-label', 'Filter extensions');
  search.value = filter;
  list.append(search);
  const scroll = el('div', 'ext-list-scroll');
  const rows = [];
  const item = (entry) => {
    const row = extensionListItemEl(entry, {
      selected: selected?.id === entry.id,
      status: statusOf(entry),
      pendingRemoval: removing.has(entry.id),
      onSelect,
      onUpdate,
    });
    rows.push({ row, name: nameOf(entry).toLowerCase() });
    return row;
  };

  if (core.length > 0) {
    const head = el('div', 'ext-group-head');
    head.append(el('div', 'ext-group-title', 'Core'));
    scroll.append(head);
    for (const entry of core) scroll.append(item(entry));
  }

  const head = el('div', 'ext-group-head');
  head.append(el('div', 'ext-group-title', 'Installed'));
  const updatable = installed.filter((e) => hasUpdate(e, statuses[e.id], removing.has(e.id)));
  if (updatable.length) {
    const all = el('button', 'ext-btn ext-btn-dark ext-btn-sm', 'Update all');
    all.type = 'button';
    all.disabled = busy;
    all.addEventListener('click', () => onUpdateAll?.(updatable));
    head.append(all);
  }
  if (installed.some((e) => e.origin)) {
    // Feedback while the ls-remote round trip runs: without it the button looks
    // inert until a result lands some seconds later.
    const check = el('button', 'ext-btn ext-btn-sm');
    check.type = 'button';
    check.innerHTML = RESTART_ICON;
    check.append(el('span', null, checking ? 'Checking…' : 'Check all'));
    check.setAttribute('aria-label', 'Check all for updates');
    check.disabled = checking;
    check.addEventListener('click', () => onCheckUpdates?.());
    head.append(check);
  }
  scroll.append(head);
  if (installed.length === 0) scroll.append(el('div', 'setting-help ext-group-empty', 'No extensions installed yet.'));
  for (const entry of installed) scroll.append(item(entry));
  list.append(scroll);

  // Filtered in place, never by a remount, so typing keeps focus.
  const applyFilter = (text) => {
    const q = text.trim().toLowerCase();
    for (const { row, name } of rows) row.hidden = Boolean(q) && !name.includes(q);
  };
  applyFilter(filter);
  search.addEventListener('input', () => { applyFilter(search.value); onFilter?.(search.value); });

  const add = el('button', `ext-btn ext-add-btn${adding ? ' selected' : ''}`, '+ Add extension');
  add.type = 'button';
  add.addEventListener('click', () => onAdd?.());
  list.append(add);
  wrap.append(list);

  // ── Detail pane ──
  const detail = el('div', 'ext-detail');
  // Whole-wrangler notices, above whichever extension is shown. An update of an
  // already-registered id sets `pendingInstall`, and its entry shows the version
  // still running rather than the one on disk, so its "restart to finish" line
  // lives here rather than on the entry.
  const notices = el('div', 'ext-notices');
  if (pendingInstall) notices.append(noteEl('ext-row-note', progress || `Installed ${pendingInstall}. ${RESTART_NOTE}`));
  else if (progress) notices.append(noteEl('ext-install-progress', progress));
  if (canRestart && (pendingRemoval.length || pendingInstall)) notices.append(restartButtonEl({ restarting, onRestart }));
  if (notices.childNodes.length) detail.append(notices);

  if (adding || !selected) {
    const installedOrigins = installed.map((e) => e.origin).filter(Boolean);
    detail.append(addExtensionEl({ busy, onInstall, browse, installedOrigins, onBrowse }));
  } else {
    const settings = settingsEl ? settingsEl(selected) : defaultSettingsEl(selected, onSettingChange);
    detail.append(extensionDetailEl(selected, {
      status: statusOf(selected),
      pendingRemoval: removing.has(selected.id),
      settings,
      onUninstall,
    }));
  }
  wrap.append(detail);
  return wrap;
}

// The line an ext-check-updates reply (or the wait for one) adds to a row.
// Nothing is fetched on a schedule, so this only ever appears around a press of
// the button — which is why it is a per-row note rather than a badge the row is
// built with, and why app.js clears the settled ones again after a few seconds:
// "Up to date." describes a check that happened, not a standing property.
export function updateStatusText(status) {
  if (!status) return '';
  if (status.checking) return 'Checking…';
  if (!status.updatable) return 'No origin recorded — this one was placed here by hand, so there is nothing to check.';
  if (status.error) return `Could not reach the origin: ${status.error}`;
  if (!status.sha) return 'No installed commit recorded.';
  return status.behind ? `A newer commit is available (${status.remoteSha.slice(0, 8)}).` : 'Up to date.';
}

// What the consent modal shows, in this order: the trust statement, then the
// capability list (or its diff), then the dependency list (or its diff), then
// the caller's Approve/Cancel. An UPDATE shows CHANGES only — the decision on
// an update is what changed, and the full list is noise that hides it.
export function consentBodyEl(payload) {
  const wrap = el('div', 'ext-consent');
  const trust = el('div', 'ext-consent-trust');
  trust.setAttribute('role', 'note');
  trust.append(el('div', 'ext-consent-trust-lead', payload.update
    ? `Update ${payload.label || payload.id}?`
    : `Install ${payload.label || payload.id}?`));
  trust.append(el('div', 'ext-consent-trust-body', TRUST_STATEMENT));
  wrap.append(trust);

  // The commit and author are dropped from the installed row but kept HERE: on
  // the row they were unactionable clutter, while this is the one screen where
  // "which code exactly, and whose" is the decision being made.
  const id = el('div', 'ext-consent-meta');
  if (payload.author) id.append(el('span', 'ext-row-author', payload.author));
  if (payload.sha) id.append(el('span', 'ext-row-sha', payload.sha.slice(0, 8)));
  if (payload.update && payload.priorSha) id.append(el('span', 'ext-row-sha', `was ${payload.priorSha.slice(0, 8)}`));
  const home = originNode(payload.homepage);
  if (home) id.append(home);
  if (id.childNodes.length) wrap.append(id);
  if (payload.description) wrap.append(el('div', 'ext-row-desc', payload.description));

  if (payload.update) {
    const added = payload.addedCapabilities || [];
    const removed = payload.removedCapabilities || [];
    if (added.length || removed.length) {
      section(wrap, 'Capabilities changed');
      if (added.length) wrap.append(chipsEl(added.map((c) => `+ ${c}`), 'ext-chip ext-chip-add'));
      if (removed.length) wrap.append(chipsEl(removed.map((c) => `− ${c}`), 'ext-chip ext-chip-remove'));
    } else {
      section(wrap, 'Capabilities unchanged', el('div', 'ext-consent-none', 'It asks for nothing it was not already granted.'));
    }
    section(wrap, 'Dependencies changed', dependencyDiffEl(payload));
  } else {
    section(wrap, 'Capabilities requested', (payload.capabilities || []).length
      ? capabilitiesEl(payload.capabilities)
      : el('div', 'ext-consent-none', 'None — it asks the wrangler for nothing.'));
    const deps = el('div');
    if ((payload.dependencies || []).length) deps.append(chipsEl(payload.dependencies, 'ext-chip ext-chip-dep'));
    deps.append(el('div', 'ext-consent-note', dependencyCountText(payload)));
    section(wrap, 'Dependencies', deps);
  }
  wrap.append(el('div', 'ext-consent-note', 'Dependencies are installed with npm install scripts disabled. That stops install-time hooks only — every dependency\'s code still runs inside the wrangler once the extension loads.'));
  return wrap;
}

// Direct dependencies are listed; the transitive tail is a count. A real
// transitive tree runs to hundreds of entries, and a human cannot read that as
// a diff — the direct set is the part the manifest actually chose.
function dependencyCountText(payload) {
  const listed = (payload.dependencies || []).length;
  const total = payload.dependencyCount ?? listed;
  const transitive = Math.max(0, total - listed);
  if (!total) return 'It has no dependencies.';
  if (!transitive) return `${total} package${total === 1 ? '' : 's'}, all listed above.`;
  return `${listed} direct, plus ${transitive} further package${transitive === 1 ? '' : 's'} pulled in underneath them.`;
}

function dependencyDiffEl(payload) {
  const wrap = el('div');
  const added = payload.addedDependencies || [];
  const removed = payload.removedDependencies || [];
  const addedCount = payload.addedCount ?? added.length;
  const removedCount = payload.removedCount ?? removed.length;
  if (!addedCount && !removedCount) {
    wrap.append(el('div', 'ext-consent-none', 'Nothing changed.'));
    return wrap;
  }
  if (added.length) wrap.append(chipsEl(added.map((d) => `+ ${d}`), 'ext-chip ext-chip-add'));
  if (removed.length) wrap.append(chipsEl(removed.map((d) => `− ${d}`), 'ext-chip ext-chip-remove'));
  const hidden = (addedCount - added.length) + (removedCount - removed.length);
  wrap.append(el('div', 'ext-consent-note', hidden
    ? `${addedCount} added and ${removedCount} removed in all; the ${hidden} not listed are transitive.`
    : `${addedCount} added, ${removedCount} removed.`));
  return wrap;
}

// What an uninstall actually does, as the confirm dialog says it. It no longer
// advertises data retention as a feature: the wrangler removes the extension's
// own directory and its provenance record, and cannot remove whatever the
// extension itself wrote elsewhere because only the extension knows where that
// is (a store's file is chosen by its own factory). An explicit purge is
// deferred; until it exists this sentence must describe the gap, not dress it up.
export function uninstallBodyText(entry) {
  const live = entry.enabled && !entry.quarantine;
  return [
    'Its files are removed from the extensions folder.',
    'Anything it saved elsewhere in the wrangler\'s data folder stays — the wrangler does not know where an extension keeps its own data.',
    live
      ? 'Its code keeps running until the wrangler restarts; you can restart from here once it is gone.'
      : 'It is not running, so nothing changes on the board.',
  ].join(' ');
}

// The install progress line. Short, phase-keyed, and it never claims anything is
// installed before ext-consent has run — `cloning` and `resolving` happen before
// any decision has been made.
export function progressText(phase, extra = {}) {
  switch (phase) {
    case 'cloning': return 'Fetching the repository…';
    case 'resolving': return 'Reading its manifest and lockfile…';
    case 'disclosed': return '';
    case 'installing': return 'Installing its dependencies…';
    case 'done': return extra.restartRequired
      ? `Installed ${extra.id || ''}. ${RESTART_NOTE}`.trim()
      : `Installed ${extra.id || ''} and live. Running sessions pick up its tools when they next resume.`.trim();
    case 'cancelled': return 'Cancelled. Nothing was installed.';
    case 'failed': return extra.message ? `Failed: ${extra.message}` : 'Failed.';
    default: return '';
  }
}

// Which progress lines are a REPORT of something that has finished and must fade,
// rather than state the reader still has to act on. "Cancelled. Nothing was
// installed." sat there forever describing a decision made minutes ago. A
// finished install is now a report in BOTH paths: a live one has nothing left to
// do, and the update path's restart affordance rides `pendingInstall` — the form
// falls back to `Installed <id>. ${RESTART_NOTE}` for as long as that is set —
// rather than the progress phase, so fading this line takes the button with it.
export const TRANSIENT_PROGRESS_PHASES = new Set(['cancelled', 'failed', 'done']);
