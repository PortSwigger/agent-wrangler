import { registerRuntime } from '../runtimes/index.js';
import { runtimeOffer, startupRuntimes, localProcessRefusal } from '../runtimes/offer.js';
import { createShellSession } from '../shell-session.js';
import { writeConfig } from '../config-store.js';
import { testLocationRuntime, manager } from './location-runtime.js';

registerRuntime(testLocationRuntime(), 'testext');
const sm = manager();
sm._trustLaunchCwd = async () => {};
const outcome = (p) => p.then((r) => ({ ok: r.sessionId ? (sm.map.get(r.sessionId).runtime || 'local') : true }), (e) => ({ refused: e.message }));
const snapshot = () => runtimeOffer().map(({ id, unavailable }) => (unavailable ? { id, unavailable } : { id }));

const before = snapshot();
writeConfig({ deckRuntimes: ['local'] });
const out = {
  startup: startupRuntimes(),
  offer: before,
  offerAfterConfigWrite: snapshot(),
  local: await outcome(sm.dispatch({ intent: 'x' })),
  testloc: await outcome(sm.dispatch({ intent: 'x', runtime: 'testloc' })),
  terminalRefusal: localProcessRefusal(),
  terminal: await outcome(createShellSession('/', 'aw-probe-socket', '/nonexistent/tmux')),
};
process.stdout.write(JSON.stringify(out));
