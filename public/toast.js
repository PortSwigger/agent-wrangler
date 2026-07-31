// The single bottom toast. Zero coupling — pure DOM + a shared timer — so every
// module can surface feedback without importing app state.
let toastTimer;
// `opts` is either a single action `{ label, onClick, duration }` (legacy) or
// `{ actions: [{label, onClick}], duration }`. Action toasts grow a depleting
// progress bar whose CSS animation drives dismissal — pausing it on hover pauses
// the countdown too, so a destructive action never vanishes mid-decision.
// Plain-text callers keep the 4s default.
export function toast(text, isErr, opts) {
  const el = document.getElementById('toast');
  el.className = isErr ? 'err' : '';
  el.textContent = text;
  el.onmouseenter = el.onmouseleave = null;
  const actions = opts ? (opts.actions || (opts.label ? [opts] : [])) : [];
  const duration = opts?.duration ?? 4000;
  const hide = () => el.classList.add('hidden');
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { clearTimeout(toastTimer); hide(); action.onClick(); });
    el.append(btn);
  }
  clearTimeout(toastTimer);
  if (actions.length) {
    const bar = document.createElement('div');
    bar.className = 'toast-progress';
    bar.style.animationDuration = `${duration}ms`;
    bar.addEventListener('animationend', hide);
    el.append(bar);
    el.onmouseenter = () => { bar.style.animationPlayState = 'paused'; };
    el.onmouseleave = () => { bar.style.animationPlayState = 'running'; };
  } else {
    toastTimer = setTimeout(hide, duration);
  }
}
