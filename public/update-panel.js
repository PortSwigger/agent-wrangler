const shortSha = (sha) => (sha || '').slice(0, 7);

export const UPDATE_HELP = 'Fast-forwards to origin/main and restarts the wrangler. Running sessions carry on, and pick up new tools and skills when restarted or resumed.';

export function shouldReloadForVersion(seen, next) {
  return Boolean(seen && next && seen !== next);
}

export function sessionOnOlderCode(session, codeVersion) {
  return Boolean(session?.managed && codeVersion && session.launchedCodeVersion && session.launchedCodeVersion !== codeVersion);
}

export function updateAvailable(status) {
  return Boolean(status && status.behind > 0 && !status.blocked);
}

export function updateToastText(status, { lastToasted = null, userAsked = false } = {}) {
  if (!updateAvailable(status) || userAsked || status.remote === lastToasted) return '';
  if (status.rolledBack?.target === status.remote) return '';
  return 'Update available:';
}

export function rolledBackText(rolledBack) {
  if (!rolledBack?.target) return '';
  return `The update to ${shortSha(rolledBack.target)} failed to start, so the wrangler rolled back to ${shortSha(rolledBack.previous)}. Automatic updates skip that commit; check the service log for the error.`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, { disabled = false, onClick } = {}) {
  const btn = el('button', className, label);
  btn.type = 'button';
  btn.disabled = disabled;
  btn.addEventListener('click', () => onClick?.());
  return btn;
}

export function updateSummary({ phase, status, error } = {}) {
  if (phase === 'checking') return 'Checking origin/main…';
  if (phase === 'applying') return 'Updating…';
  if (phase === 'restarting') return 'Restarting… the board will reload when it\'s back.';
  if (phase === 'error') return error || 'The update failed.';
  if (!status) return '';
  if (status.behind === 0) return `Up to date (${shortSha(status.head)}).`;
  const commits = `${status.behind} new commit${status.behind === 1 ? '' : 's'} on origin/main.`;
  if (status.blocked) return `${commits} ${status.blocked}`;
  if (!status.canApply) return `${commits} This wrangler was not started by the checkout service (launchd or systemd), so pull and restart it by hand.`;
  return commits;
}

function commitListEl(commits) {
  const list = el('ul', 'update-commits');
  for (const { sha, subject } of commits) {
    const item = el('li');
    item.append(el('span', 'ext-row-sha', sha), document.createTextNode(` ${subject}`));
    list.append(item);
  }
  return list;
}

// An install the board's Git updater does not own (a Homebrew keg, an unpacked
// release): say so and how it is updated instead, and offer no check at all.
function unavailablePanelEl(reason) {
  const wrap = el('div', 'update-panel');
  const head = el('div', 'update-panel-head');
  head.append(el('div', 'setting-label', 'Updates from the board'));
  wrap.append(head);
  wrap.append(el('div', 'setting-help', `Unavailable. ${reason}`));
  return wrap;
}

// An upgrade repointed AW_INSTALL_ROOT under this running server (server/
// install-root.js installRootDrift): sessions already get the new version's
// hook and skills, so the board asks for the restart that finishes it. Offers
// the Restart action only where the server can restart itself; otherwise says
// how, in the words the server chose for this install.
export function installDriftNotice({ drift, canRestart = false } = {}) {
  if (!drift) return null;
  const { version, runningVersion } = drift;
  const versions = version && runningVersion && version !== runningVersion ? ` (${runningVersion} → ${version})` : '';
  const text = drift.target
    ? `An upgrade has landed${versions}, but this wrangler is still running the old version. Sessions already use the new version's hook and skills, so restart the wrangler to finish the upgrade.`
    : `The install path ${drift.installRoot} cannot be resolved, so an upgrade may be in progress. Restart the wrangler once it finishes.`;
  return { text, restart: Boolean(canRestart), hint: canRestart ? null : (drift.restartHint || null) };
}

export function installDriftEl({ drift, canRestart = false, restarting = false, onRestart } = {}) {
  const notice = installDriftNotice({ drift, canRestart });
  if (!notice) return null;
  const wrap = el('div', 'update-panel');
  const head = el('div', 'update-panel-head');
  head.append(el('div', 'setting-label', 'Restart to finish the upgrade'));
  if (notice.restart) head.append(button(restarting ? 'Restarting…' : 'Restart now', 'ext-btn ext-btn-warn', { disabled: restarting, onClick: onRestart }));
  wrap.append(head);
  wrap.append(el('div', 'update-summary', notice.text));
  if (notice.hint) wrap.append(el('div', 'setting-help', notice.hint));
  return wrap;
}

export function updatePanelEl({ phase = 'idle', status = null, error = '', unavailable = null, onCheck, onApply } = {}) {
  if (unavailable) return unavailablePanelEl(unavailable);
  const busy = phase === 'checking' || phase === 'applying' || phase === 'restarting';
  const wrap = el('div', 'update-panel');
  const head = el('div', 'update-panel-head');
  head.append(el('div', 'setting-label', 'Manual update'));
  const canUpdate = phase === 'status' && status && status.behind > 0 && !status.blocked && status.canApply;
  if (canUpdate) head.append(button('Update and restart', 'ext-btn ext-btn-primary', { onClick: onApply }));
  head.append(button(phase === 'checking' ? 'Checking…' : 'Check for updates', 'ext-btn', { disabled: busy, onClick: onCheck }));
  wrap.append(head);
  wrap.append(el('div', 'setting-help', UPDATE_HELP));
  const summary = updateSummary({ phase, status, error });
  if (summary) wrap.append(el('div', phase === 'error' ? 'update-summary update-error' : 'update-summary', summary));
  if (phase === 'status' && status?.commits?.length) wrap.append(commitListEl(status.commits));
  const rollback = rolledBackText(status?.rolledBack);
  if (rollback) wrap.append(el('div', 'update-summary update-error', rollback));
  return wrap;
}

// ── Installed extensions, from the core tick's background check ──
// Notify only in every mode: nothing here offers to apply an extension update,
// because each one goes through its consent screen in the Extensions tab.

export function outdatedExtensions(summary) {
  return (summary?.extensions || []).filter((e) => e.behind && !e.error);
}

// "4 changes", or "50+ changes" when the count stopped short of the installed commit.
export function changesText(n, capped = false) {
  return `${n}${capped ? '+' : ''} change${n === 1 && !capped ? '' : 's'}`;
}

function totalChanges(exts) {
  return changesText(exts.reduce((n, e) => n + (e.commits || 0), 0), exts.some((e) => e.capped));
}

// What the toast dedupes on: a toast is due only when an extension falls behind
// that was not behind before, or a remote moves again.
export function extUpdateKeys(summary) {
  return outdatedExtensions(summary).map((e) => `${e.id}@${e.remoteSha}`).sort();
}

export function extUpdateIsNew(summary, lastToasted = []) {
  const seen = new Set(lastToasted);
  return extUpdateKeys(summary).some((k) => !seen.has(k));
}

// The toast line. With a core update in the same check the extensions fold into
// its text, since there is one toast slot.
export function extUpdateToastText(summary, { core = false } = {}) {
  const exts = outdatedExtensions(summary);
  if (!exts.length) return '';
  if (core) return `Update available · ${exts.length} extension${exts.length === 1 ? '' : 's'} out of date`;
  if (exts.length === 1) return `${exts[0].label || exts[0].id} has an update · ${changesText(exts[0].commits || 0, exts[0].capped)} missing`;
  return `${exts.length} extensions out of date · ${totalChanges(exts)} missing`;
}

export function extUpdateLineText(summary) {
  const exts = outdatedExtensions(summary);
  if (!exts.length) {
    const checked = (summary?.extensions || []).filter((e) => !e.error).length;
    return checked === 1 ? 'Your 1 extension is up to date.' : `All ${checked} extensions up to date.`;
  }
  return `${exts.length} extension${exts.length === 1 ? '' : 's'} out of date · ${totalChanges(exts)} missing.`;
}

function checkedAgoText(at, now) {
  const mins = Math.floor(Math.max(0, now - at) / 60000);
  if (mins < 1) return 'Checked just now.';
  if (mins < 60) return `Checked ${mins} minute${mins === 1 ? '' : 's'} ago.`;
  const hours = Math.floor(mins / 60);
  return `Checked ${hours} hour${hours === 1 ? '' : 's'} ago.`;
}

// The Extensions block under Manual update. Null with Automatic updates Off
// (there is no background check to report) and before the first check.
export function extUpdatesEl({ summary = null, mode = 'notify', onOpen, now = Date.now() } = {}) {
  if (mode === 'off' || !summary?.extensions?.length) return null;
  const exts = outdatedExtensions(summary);
  const wrap = el('div', 'update-panel');
  const head = el('div', 'update-panel-head');
  head.append(el('div', 'setting-label', 'Extensions'));
  if (exts.length) head.append(button('Open Extensions', 'ext-btn', { onClick: onOpen }));
  wrap.append(head);
  wrap.append(el('div', 'update-summary', extUpdateLineText(summary)));
  if (exts.length > 1) {
    const list = el('ul', 'update-commits');
    for (const e of exts) {
      const item = el('li');
      item.append(el('b', null, e.label || e.id), document.createTextNode(` · ${changesText(e.commits || 0, e.capped)}`));
      list.append(item);
    }
    wrap.append(list);
  }
  if (mode === 'auto' && exts.length) wrap.append(el('div', 'update-summary update-auto-note', 'Auto mode installs wrangler updates only. Extension updates wait for you.'));
  const at = summary.checkedAt ? `${checkedAgoText(summary.checkedAt, now)} ` : '';
  wrap.append(el('div', 'setting-help', `${at}Built-in extensions are not checked.`));
  return wrap;
}
