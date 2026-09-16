// The Extensions settings tab's INSTALLED half and the install/update consent
// modal. Pure DOM builders with no app state, like toast.js and
// system-banner.js: settings.js mounts what these return.
//
// EVERY third-party string here — label, description, author, homepage,
// capability names, dependency names, quarantine reasons — goes in via
// textContent, never innerHTML. Same rule as diff-dom.js and checklist-dom.js,
// and for a sharper reason: this content came off a git URL a colleague pasted.
// settings.js's own rows are innerHTML+esc(); this module exists partly so that
// path never has to carry installed-extension data at all.
//
// The trust statement is the FIRST thing the consent modal renders, and its
// wording is deliberate and must not be softened: an extension runs in-process
// with full access to the machine. `requires` is disclosure and
// accident-containment, not a security boundary; the browser half is trusted
// exactly as much as the server half; `npm ci --ignore-scripts` is a mitigation,
// not a sandbox. Nothing in this file may imply otherwise.

export const TRUST_STATEMENT = 'An extension runs inside the wrangler with full access to this machine — your files, your repositories and your agent sessions. The capability list below is disclosure, not a sandbox: it says what the extension asked the wrangler for, and nothing prevents its code (or any of its dependencies) from doing more. Install this only if you trust whoever wrote it, exactly as you would trust a package you npm install into the server.';

// Newly installed or uninstalled code loads (or goes) at the next server start.
// Same vocabulary as settings.js's extensionFlipNote, deliberately: there must
// not be a second way of saying "needs a restart".
export const RESTART_NOTE = 'Restart the wrangler to finish.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function chipsEl(items, className) {
  const wrap = el('div', 'ext-chips');
  for (const item of items) wrap.append(el('span', className, item));
  return wrap;
}

function section(parent, title, body) {
  parent.append(el('div', 'ext-section-title', title));
  if (body) parent.append(body);
}

// A homepage is displayed as TEXT unless it is https://. A third-party-supplied
// href is not worth the navigation surface for a decoration, and http:// buys
// nothing that the plain string does not.
function homepageNode(homepage) {
  if (!homepage) return null;
  if (!/^https:\/\//.test(homepage)) return el('span', 'ext-row-origin', homepage);
  const a = el('a', 'ext-row-origin', homepage);
  a.href = homepage;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  return a;
}

// One row per INSTALLED extension, rendered beneath the enable/disable toggles
// (which settings.js builds for builtins and installed alike). This row carries
// what only an installed one has: where it came from, the pinned SHA, who wrote
// it, and Uninstall — plus the quarantine reason when it has one, which is the
// whole point of the quarantine posture being visible rather than silent.
export function externalRowEl(entry, { onUninstall, onUpdate } = {}) {
  const row = el('div', 'ext-row');
  row.dataset.id = entry.id;
  const copy = el('div', 'ext-row-copy');
  copy.append(el('div', 'ext-row-label', entry.label || entry.id));
  if (entry.description) copy.append(el('div', 'ext-row-desc', entry.description));
  const meta = el('div', 'ext-row-meta');
  if (entry.author) meta.append(el('span', 'ext-row-author', entry.author));
  if (entry.origin) meta.append(el('span', 'ext-row-origin', entry.origin));
  // Short SHA: the full 40 characters say nothing extra to a human and crowd
  // out the origin, which is the field that actually identifies the code.
  if (entry.sha) meta.append(el('span', 'ext-row-sha', entry.sha.slice(0, 8)));
  const home = homepageNode(entry.homepage);
  if (home) meta.append(home);
  if (meta.childNodes.length) copy.append(meta);
  if (entry.quarantine) {
    const note = el('div', 'ext-row-quarantine');
    note.setAttribute('role', 'status');
    note.append(el('strong', null, 'Quarantined: '));
    note.append(document.createTextNode(entry.quarantine));
    note.append(el('div', 'ext-row-quarantine-help', 'It contributed nothing this boot. Fix or reinstall it, then restart the wrangler.'));
    copy.append(note);
  }
  row.append(copy);
  const actions = el('div', 'ext-row-actions');
  if (entry.origin) {
    const update = el('button', 'ext-btn', 'Update…');
    update.type = 'button';
    update.addEventListener('click', () => onUpdate?.(entry));
    actions.append(update);
  }
  const remove = el('button', 'ext-btn ext-btn-danger', 'Uninstall');
  remove.type = 'button';
  remove.addEventListener('click', () => onUninstall?.(entry));
  actions.append(remove);
  row.append(actions);
  return row;
}

// The whole installed half of the Extensions tab: the rows, the on-demand
// "Check for updates" button, the install field and the progress line. Built as
// one element per modal open (settings.js's `extensionsBridge.mount`) rather
// than patched in place — this panel is behind a modal nobody watches while an
// install runs, so there is no scroll or drag state a re-render could eat, and
// the checklist panel's patching machinery would be dead weight here.
//
// The install "prompt" is an inline field rather than a second modal: it lives
// inside the settings modal that already has focus, and a URL is one line.
export function installedPanelEl({
  entries = [], statuses = {}, progress = '', busy = false,
  onInstall, onUninstall, onUpdate, onCheckUpdates,
} = {}) {
  const wrap = el('div');
  const head = el('div', 'ext-installed-head');
  head.append(el('div', 'setting-label', 'Installed extensions'));
  if (entries.length) {
    const check = el('button', 'ext-btn', 'Check for updates');
    check.type = 'button';
    check.addEventListener('click', () => onCheckUpdates?.());
    head.append(check);
  }
  wrap.append(head);

  if (!entries.length) {
    wrap.append(el('div', 'setting-help', 'None yet. Extensions you install from a git URL appear here; the ones above ship with the wrangler.'));
  }
  for (const entry of entries) {
    const row = externalRowEl(entry, { onUninstall, onUpdate });
    const status = statuses[entry.id];
    if (status) {
      const note = el('div', 'ext-row-note', updateStatusText(status));
      note.setAttribute('role', 'status');
      row.querySelector('.ext-row-copy').append(note);
    }
    wrap.append(row);
  }

  const form = el('div', 'ext-row');
  const copy = el('div', 'ext-row-copy');
  copy.append(el('div', 'ext-row-label', 'Install an extension'));
  copy.append(el('div', 'setting-help', 'Paste an https:// or ssh:// git URL. The wrangler fetches it and shows you what it asks for before anything is installed.'));
  const input = el('input', 'ext-install-url');
  input.type = 'text';
  input.placeholder = 'https://github.com/…';
  input.setAttribute('aria-label', 'Extension git URL');
  copy.append(input);
  if (progress) {
    const note = el('div', 'ext-install-progress', progress);
    note.setAttribute('role', 'status');
    copy.append(note);
  }
  form.append(copy);
  const go = el('button', 'ext-btn ext-btn-primary', 'Install…');
  go.type = 'button';
  go.disabled = busy;
  const submit = () => {
    const url = input.value.trim();
    if (url) onInstall?.(url);
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  const actions = el('div', 'ext-row-actions');
  actions.append(go);
  form.append(actions);
  wrap.append(form);
  return wrap;
}

// The "n behind" / "up to date" line an ext-check-updates reply adds to a row.
// Nothing is fetched on a schedule, so this only ever appears after a human
// pressed the button — which is why it is a per-row note rather than a badge
// the row is built with.
export function updateStatusText(status) {
  if (!status) return '';
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

  const id = el('div', 'ext-consent-meta');
  if (payload.author) id.append(el('span', 'ext-row-author', payload.author));
  if (payload.sha) id.append(el('span', 'ext-row-sha', payload.sha.slice(0, 8)));
  if (payload.update && payload.priorSha) id.append(el('span', 'ext-row-sha', `was ${payload.priorSha.slice(0, 8)}`));
  const home = homepageNode(payload.homepage);
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
      ? chipsEl(payload.capabilities, 'ext-chip')
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

// The install progress line. Short, phase-keyed, and it never claims anything is
// installed before ext-consent has run — `cloning` and `resolving` happen before
// any decision has been made.
export function progressText(phase, extra = {}) {
  switch (phase) {
    case 'cloning': return 'Fetching the repository…';
    case 'resolving': return 'Reading its manifest and lockfile…';
    case 'disclosed': return '';
    case 'installing': return 'Installing its dependencies…';
    case 'done': return `Installed ${extra.id || ''}. ${RESTART_NOTE}`.trim();
    case 'cancelled': return 'Cancelled. Nothing was installed.';
    case 'failed': return extra.message ? `Failed: ${extra.message}` : 'Failed.';
    default: return '';
  }
}
