import { agyPane } from './agents/agy-pane.js';
import { agyNativeReady, AGY_STARTUP_PROBE, AGY_STARTUP_FAILURE } from './agy-startup.js';
export async function prepareAgyPane({ target, socket, fork = false, capture, keys, send, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 20000, modeState = { cycles: 0 } }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = await capture(target, 60, socket);
    if (agyPane.classify(pane).status === 'needs-you') return { ready: false, reason: 'Antigravity needs attention in the terminal.' };
    if (agyPane.classify(pane).status === 'idle' && agyPane.ready(pane) && agyPane.empty(pane)) {
      if (agyPane.mode(pane) === 'auto') {
        if (fork) await send(target, '/fork', socket);
        return { ready: true };
      }
      modeState.cycles = (modeState.cycles || 0) + 1;
      if (modeState.cycles > 3) return { ready: false, reason: 'Antigravity auto mode could not be verified. Check account support in the terminal.' };
      await keys(target, ['BTab'], socket);
    }
    await sleep(250);
  }
  return { ready: false, reason: 'Antigravity composer or auto mode was not ready before the timeout.' };
}

export async function advanceAgyStartup({ entry, capture, keys, send, confirm, paste, save = () => {}, current = () => true, nativeReady = agyNativeReady, prepare = prepareAgyPane, timeoutMs = 20000 }) {
  const startup = entry.agyStartup;
  if (!startup || !current()) return;
  const pending = entry.agyPendingIntent;
  if (pending && ['sending', 'unknown'].includes(pending.state)) {
    entry.agyLaunchWarning = 'Antigravity task submission is uncertain. Inspect the terminal before sending again; automatic replay is disabled.';
    save(); return;
  }
  const target = entry.paneId || entry.tmux, socket = entry.socket || '';
  const result = await prepare({ target, socket, capture, keys, send, timeoutMs, modeState: startup });
  if (!current()) return;
  if (!result.ready) { entry.agyLaunchWarning = result.reason; save(); return; }
  if (entry.agyForkPending && !startup.forkSent) {
    startup.forkSent = true; save();
    try { await send(target, '/fork', socket); }
    catch { entry.agyLaunchWarning = 'Antigravity /fork submission is uncertain; inspect the terminal before retrying.'; save(); }
    return;
  }
  if (!nativeReady(entry)) {
    entry.agyLaunchWarning = AGY_STARTUP_FAILURE;
    if (!startup.probeSent) {
      startup.probeSent = true; save();
      try { await send(target, AGY_STARTUP_PROBE, socket); }
      catch { entry.agyLaunchWarning = 'Antigravity native startup probe submission is uncertain. Inspect the terminal; no task was sent.'; }
    }
    save(); return;
  }
  if (entry.agyForkPending || !entry.liveSessionId) {
    entry.agyLaunchWarning = 'Antigravity root conversation identity is pending. Task and mail are retained.';
    save(); return;
  }
  delete entry.agyLaunchWarning;
  if (pending?.state === 'pending') {
    if (pending.imagePaths?.length && !await paste(target, socket, 'agy', pending.imagePaths)) {
      pending.state = 'unknown';
      entry.agyLaunchWarning = 'Antigravity image attachment is uncertain. Inspect the terminal; automatic replay is disabled.';
      save(); return;
    }
    if (!current() || !nativeReady(entry)) return;
    pending.state = 'sending'; save();
    try {
      await send(target, pending.text, socket);
      pending.state = await confirm(target, socket, { text: pending.text || (pending.imagePaths?.length ? '[Image #1]' : ''), agent: 'agy' }) ? 'submitted' : 'unknown';
    } catch { pending.state = 'unknown'; }
    if (pending.state === 'unknown') entry.agyLaunchWarning = 'Antigravity task submission is uncertain. Inspect the terminal; automatic replay is disabled.';
  }
  save();
}
