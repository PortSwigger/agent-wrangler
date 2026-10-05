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
  if (!status.canApply) return `${commits} This wrangler is not running under launchd or systemd, so pull and restart it by hand.`;
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

export function updatePanelEl({ phase = 'idle', status = null, error = '', onCheck, onApply } = {}) {
  const busy = phase === 'checking' || phase === 'applying' || phase === 'restarting';
  const wrap = el('div', 'update-panel');
  const head = el('div', 'ext-installed-head');
  head.append(el('div', 'setting-label', 'Version'));
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
