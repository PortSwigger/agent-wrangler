import path from 'node:path';
import { readJsonOrLoud, writeJsonAtomic } from '../atomic-json.js';
import { createTokenStore } from './tokens.js';
import { createLaptopCheck } from './check.js';
import { createSessionApiServer, listenSessionApi, guarded } from './server.js';
import { setSessionApiPort } from '../runtime.js';

export { SESSION_API_ROUTES } from './server.js';

// Everything a server process needs for the session API, built once at boot:
// the token store, the caller check and the guarded handlers. `start()` binds
// the session API's own listener; `legacyHandlers` are the same routes for the
// deck (and the board's forwarder), where sessions launched before tokens
// still call. `resolve` is injectable so another deployment can plug in its
// own check (docs/session-api.md).
export function createSessionApi({ dataDir, cardState, handlers, resolve, log = () => {}, logWarn = () => {}, logError = () => {} }) {
  const tokens = createTokenStore({ file: path.join(dataDir, 'session-tokens.json'), onError: logError });
  const check = resolve || createLaptopCheck({ tokens, cardState, logWarn });
  const onRefuse = (req, who) => logWarn(`[session-api] refused ${req.method} ${req.url.split('?')[0]}: ${who?.reason || who?.refuse || 'refused'}`);
  const legacyHandlers = Object.fromEntries(Object.entries(handlers).map(([route, h]) => [route, guarded(check, h, { legacy: true, onRefuse })]));
  const server = createSessionApiServer({ resolve: check, handlers, onRefuse });

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
      const bound = await listenSessionApi(server, { port: saved ?? port, fixed, host });
      if (!fixed && bound !== saved) {
        try { writeJsonAtomic(portFile, { port: bound }); } catch (err) { logError('[session-api] saving the port failed', err); }
      }
      setSessionApiPort(bound);
      log(`[agent-wrangler] session API at http://${host}:${bound}`);
      return bound;
    },
  };
}
