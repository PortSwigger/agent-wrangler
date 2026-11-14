import path from 'node:path';
import { readJsonOrLoud, writeJsonAtomic } from '../atomic-json.js';
import { createTokenStore } from './tokens.js';
import { createLaptopCheck } from './check.js';
import { createSessionApiServer, listenSessionApi, guarded } from './server.js';
import { setSessionApiPort } from '../runtime.js';
import { warnLegacy } from '../deck/legacy.js';

export { SESSION_API_ROUTES } from './server.js';
export { carriesSessionCredential } from './check.js';

// Everything a server process needs for the session API, built once at boot:
// the token store, the caller check and the guarded handlers. `start()` binds
// the session API's own listener; `legacyHandlers` adapt the old POST routes on
// the deck's port (and the board's forwarder to it) onto the same check, with
// the legacy path for sessions launched before tokens, and log one deprecation
// warning naming the session API's port. `resolve` is injectable so another
// deployment can plug in its own check (docs/session-api.md).
export function createSessionApi({ dataDir, cardState, handlers, resolve, log = () => {}, logWarn = () => {}, logError = () => {} }) {
  const tokens = createTokenStore({ file: path.join(dataDir, 'session-tokens.json'), onError: logError });
  const check = resolve || createLaptopCheck({ tokens, cardState, logWarn });
  const onRefuse = (req, who) => logWarn(`[session-api] refused ${req.method} ${req.url.split('?')[0]}: ${who?.reason || who?.refuse || 'refused'}`);
  const server = createSessionApiServer({ resolve: check, handlers, onRefuse });
  let bound = { host: '127.0.0.1', port: null };

  const legacyHandlers = Object.fromEntries(Object.entries(handlers).map(([route, h]) => {
    const handle = guarded(check, h, { legacy: true, onRefuse });
    return [route, (req, res) => {
      const at = bound.port ? `http://${bound.host}:${bound.port}` : 'its own port';
      warnLegacy('POST /mcp, /pr-attach and /pr-model on the deck\'s or board\'s port', `the session API at ${at} (sessions launched before it move there when resumed)`, logWarn);
      return handle(req, res);
    }];
  }));

  return {
    tokens,
    resolve: check,
    legacyHandlers,
    server,
    // Live sessions keep the URLs they launched with, so the port must survive a
    // restart: unless `fixed`, the port bound last time is asked for first, and
    // whatever is bound is saved for next time.
    async start({ port, fixed = false, host = '127.0.0.1' }) {
      const portFile = path.join(dataDir, 'session-api.json');
      const saved = fixed ? null : Number(readJsonOrLoud(portFile, 'session API port')?.port) || null;
      const got = await listenSessionApi(server, { port: saved ?? port, fixed, host });
      if (!fixed && got !== saved) {
        try { writeJsonAtomic(portFile, { port: got }); } catch (err) { logError('[session-api] saving the port failed', err); }
      }
      bound = { host, port: got };
      setSessionApiPort(got);
      log(`[agent-wrangler] session API at http://${host}:${got}`);
      return got;
    },
  };
}
