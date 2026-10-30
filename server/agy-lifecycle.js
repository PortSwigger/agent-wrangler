import { agyPane } from './agents/agy-pane.js';
export async function prepareAgyPane({ target, socket, fork = false, capture, keys, send, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 20000 }) {
  const deadline = Date.now() + timeoutMs;
  let cycles = 0;
  while (Date.now() < deadline) {
    const pane = await capture(target, 60, socket);
    if (agyPane.classify(pane).status === 'needs-you') return { ready: false, reason: 'Antigravity needs attention in the terminal.' };
    if (agyPane.ready(pane) && agyPane.empty(pane)) {
      if (/(?:^|\s)auto(?:\s|$)/im.test(pane.split('\n').slice(-4).join('\n'))) {
        if (fork) await send(target, '/fork', socket);
        return { ready: true };
      }
      if (++cycles > 3) return { ready: false, reason: 'Antigravity auto mode could not be verified. Check account support in the terminal.' };
      await keys(target, ['BTab'], socket);
    }
    await sleep(250);
  }
  return { ready: false, reason: 'Antigravity composer or auto mode was not ready before the timeout.' };
}
