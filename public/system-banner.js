// A persistent, non-auto-dismissing banner for server-wide alerts (as opposed to
// #toast, which is single-slot and timer-driven even for action toasts — wrong
// for something meant to stay visible, unmissed, until acted on). Zero coupling,
// like toast.js: pure DOM, no app state.

const DISMISS_KEY = 'aw-system-banner-dismiss';

function readDismiss() {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY)); } catch { return null; }
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// A "dismiss for today" click only suppresses alerts at or below the dismissed
// level, so a worsening leak (a higher level than what was dismissed) always
// breaks back through — the point is to silence today's already-seen warning,
// not to blind anyone to it actually getting worse.
function isDismissed(level) {
  const d = readDismiss();
  return Boolean(d && level != null && level <= d.level && Date.now() < d.until);
}

// `level` (optional) enables the dismiss control and the suppression check above;
// omit it for an alert with no "for today" concept.
export function showSystemBanner(text, { level } = {}) {
  if (isDismissed(level)) return;
  const el = document.getElementById('system-banner');
  el.textContent = '';
  const msg = document.createElement('span');
  msg.textContent = text;
  el.append(msg);
  if (level != null) {
    const btn = document.createElement('button');
    btn.className = 'system-banner-dismiss';
    btn.textContent = 'Dismiss for today';
    btn.addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ level, until: endOfToday() }));
      hideSystemBanner();
    });
    el.append(btn);
  }
  el.classList.remove('hidden');
  document.body.classList.add('system-banner-open');
}

export function hideSystemBanner() {
  document.getElementById('system-banner').classList.add('hidden');
  document.body.classList.remove('system-banner-open');
}
