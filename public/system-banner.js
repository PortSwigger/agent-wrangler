// A persistent, non-auto-dismissing banner for server-wide alerts (as opposed to
// #toast, which is single-slot and timer-driven even for action toasts — wrong
// for something meant to stay visible, unmissed, until acted on). Zero coupling,
// like toast.js: pure DOM, no app state.

const DISMISS_KEY = 'aw-system-banner-dismiss';

// Dismissals are NAMESPACED BY PRODUCER, because there is more than one now and
// their `level` scales are unrelated: the fd watchdog counts file descriptors
// (200/250/300) while the heap one reports percentages (50/75/90), so a single
// bare level number meant dismissing an fd banner would silently suppress a
// 90%-heap one. The stored value is a `{ [kind]: {level, until} }` map; a legacy
// bare `{level, until}` is read as the fd entry it was, so nobody's existing
// dismissal turns into a banner they already said no to today.
//
// A producer with no "for today" concept at all (the quarantined-builtin banner
// — a repo bug must stay visible) passes no `level` and never reaches this.
function readDismiss(kind) {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(DISMISS_KEY)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.level === 'number') return kind === 'fd' ? raw : null;
  const entry = raw[kind];
  return entry && typeof entry.level === 'number' ? entry : null;
}

function writeDismiss(kind, entry) {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(DISMISS_KEY)); } catch { /* unreadable — replaced below */ }
  const next = raw && typeof raw === 'object' && typeof raw.level !== 'number' ? { ...raw } : {};
  // A legacy bare value is carried across under its own kind rather than
  // dropped, for the same reason readDismiss understands it.
  if (raw && typeof raw.level === 'number') next.fd = raw;
  next[kind] = entry;
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* private window — the banner simply reappears */ }
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
function isDismissed(level, kind) {
  const d = readDismiss(kind);
  return Boolean(d && level != null && level <= d.level && Date.now() < d.until);
}

// `level` (optional) enables the dismiss control and the suppression check above;
// omit it for an alert with no "for today" concept. `kind` namespaces that
// dismissal to one producer — see readDismiss — and is required whenever `level`
// is given.
export function showSystemBanner(text, { level, kind = 'fd' } = {}) {
  if (isDismissed(level, kind)) return;
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
      writeDismiss(kind, { level, until: endOfToday() });
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
