// The Extensions settings tab and the install/update consent modal. Pure DOM
// builders with no app state, like toast.js and system-banner.js: settings.js
// mounts what these return.
//
// ONE LIST, not two. Builtin and installed extensions used to be rendered by two
// different code paths — settings.js's innerHTML toggle rows above, this module's
// installed rows below — which showed the same extension's name and description
// twice and made "is it on" and "where did it come from" look like questions
// about different things. Every row here is now a `.setting-row` carrying
// `data-id="ext:<id>"` and a `.setting-toggle`, which is exactly what settings.js's
// own delegated click handler already drives, so unifying the list cost no second
// flip path and no second flip note.
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

// The restart affordance, which lives ONCE in the panel head beside "Check for
// updates" rather than on each row: a restart is a whole-wrangler action, not a
// per-extension one, and several pending rows would otherwise each draw a button
// that does exactly the same thing. The rows still SAY what is waiting on it.
//
// Absent — leaving the rows' sentences alone — when the server did not say it can
// restart itself: under `npm start` an exit is a shutdown with nothing to bring
// the board back, so there is nothing honest to offer.
function restartButtonEl({ restarting, onRestart } = {}) {
  const btn = el('button', 'ext-btn ext-btn-warn', restarting ? 'Restarting…' : 'Restart now');
  btn.type = 'button';
  btn.disabled = Boolean(restarting);
  btn.addEventListener('click', () => onRestart?.());
  return btn;
}

// One row per extension, builtin or installed. What only an installed one has —
// where it came from, Uninstall, and Update when a check found one — is added on
// top of the shared name/description/toggle.
//
// The row deliberately shows the origin URL and NOTHING else machine-facing: the
// pinned commit, the author string and the local path told a reader nothing they
// could act on and crowded out the two fields that identify the thing (its name
// and where it came from). The commit still appears where it is a decision input,
// on the consent modal.
export function extensionRowEl(entry, {
  status, pendingRemoval, onUninstall, onUpdate,
} = {}) {
  const row = el('div', `setting-row ext-row${pendingRemoval ? ' ext-row-removed' : ''}`);
  row.dataset.id = `ext:${entry.id}`;
  const copy = el('div', 'setting-copy');
  copy.append(el('div', 'setting-label', entry.label || entry.id));
  const blurb = entry.description || entry.help;
  if (blurb) copy.append(el('div', 'setting-help', blurb));
  const origin = originNode(entry.origin);
  if (origin) {
    const meta = el('div', 'ext-row-meta');
    meta.append(origin);
    copy.append(meta);
  }
  if (entry.quarantine && !pendingRemoval) {
    const note = noteEl('ext-row-quarantine', '');
    note.append(el('strong', null, 'Quarantined: '));
    note.append(document.createTextNode(entry.quarantine));
    note.append(el('div', 'ext-row-quarantine-help', 'It is not running. Fix or reinstall it; a builtin needs a restart.'));
    copy.append(note);
  }
  if (pendingRemoval) {
    copy.append(noteEl('ext-row-note', `Uninstalled. ${RESTART_NOTE}`));
  } else if (status) {
    copy.append(noteEl('ext-row-note', updateStatusText(status)));
  }
  row.append(copy);

  const actions = el('div', 'ext-row-actions');
  if (!pendingRemoval) {
    // Update is offered only when a check actually found a newer commit. A
    // permanently present "Update…" button says nothing about whether there is
    // one, and pressing it re-clones and re-consents for no reason.
    if (entry.external && entry.origin && status?.behind) {
      const update = el('button', 'ext-btn', 'Update…');
      update.type = 'button';
      update.addEventListener('click', () => onUpdate?.(entry));
      actions.append(update);
    }
    if (entry.external) {
      const remove = el('button', 'ext-btn ext-btn-danger', 'Uninstall');
      remove.type = 'button';
      remove.addEventListener('click', () => onUninstall?.(entry));
      actions.append(remove);
    }
    // The toggle settings.js's delegated handler drives — same markup as its own
    // rowHtml, because it is the same control.
    const toggle = el('button', `setting-toggle${entry.enabled ? ' on' : ''}`);
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', entry.enabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', entry.label || entry.id);
    toggle.append(el('span', 'setting-knob'));
    actions.append(toggle);
  }
  row.append(actions);
  return row;
}

// The whole Extensions tab: every extension as one row, the on-demand "Check for
// updates" button, the install field and the progress line. Built as one element
// per modal open (settings.js's `extensionsBridge.mount`) rather than patched in
// place — this panel is behind a modal nobody watches while an install runs, so
// there is no scroll or drag state a re-render could eat.
//
// The install "prompt" is an inline field rather than a second modal: it lives
// inside the settings modal that already has focus, and a URL is one line.
export function extensionsPanelEl({
  entries = [], statuses = {}, checking = false, progress = '', busy = false,
  pendingRemoval = [], pendingInstall = '', canRestart = false, restarting = false,
  onInstall, onUninstall, onUpdate, onCheckUpdates, onRestart,
} = {}) {
  const wrap = el('div');
  const head = el('div', 'ext-installed-head');
  head.append(el('div', 'setting-label', 'Extensions'));
  // Beside the check button, and only while something is actually waiting on it.
  if (canRestart && (pendingRemoval.length || pendingInstall)) {
    head.append(restartButtonEl({ restarting, onRestart }));
  }
  if (entries.some((e) => e.external && e.origin)) {
    const check = el('button', 'ext-btn', checking ? 'Checking…' : 'Check for updates');
    check.type = 'button';
    // Feedback while the ls-remote round trip runs: without it the button looked
    // inert until an "Up to date." appeared some seconds later, which reads as
    // nothing having happened.
    check.disabled = checking;
    check.addEventListener('click', () => onCheckUpdates?.());
    head.append(check);
  }
  wrap.append(head);

  const removing = new Set(pendingRemoval);
  for (const entry of entries) {
    wrap.append(extensionRowEl(entry, {
      status: checking && entry.external && entry.origin ? { checking: true } : statuses[entry.id],
      pendingRemoval: removing.has(entry.id),
      onUninstall,
      onUpdate,
    }));
  }

  const form = el('div', 'setting-row ext-row');
  const copy = el('div', 'setting-copy');
  copy.append(el('div', 'setting-label', 'Install an extension'));
  copy.append(el('div', 'setting-help', 'Paste an https:// or ssh:// git URL. The wrangler fetches it and shows you what it asks for before anything is installed.'));
  const input = el('input', 'ext-install-url');
  input.type = 'text';
  input.placeholder = 'https://github.com/…';
  input.setAttribute('aria-label', 'Extension git URL');
  copy.append(input);
  // Only an update of an already-registered id ever sets `pendingInstall`, and
  // its row shows the version still running rather than the one on disk — so the
  // "restart to finish" line rides the install field instead, beside the head's
  // button, and outlives the progress line once that has faded.
  if (pendingInstall) {
    copy.append(noteEl('ext-row-note', progress || `Installed ${pendingInstall}. ${RESTART_NOTE}`));
  } else if (progress) {
    copy.append(noteEl('ext-install-progress', progress));
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
