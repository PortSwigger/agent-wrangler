import { extractCaller } from './mcp/server.js';
import { sessionModelId } from './agents/index.js';

// POST /pr-model — the PR model footer's lookup (server/pr-footer.js). Answers
// `{ model }` for the caller's card (X-AW-Session, as /pr-attach): the live
// model off the board, else the launch model, as an exact id. `model` is null
// when the footer setting is off or the card is unknown, which the footer reads
// as "leave the PR alone". Read-only: nothing is attached or stored.
export function createPrModelHandler({ graph, entryFor, enabled, logError = () => {} }) {
  return async function prModelHandler(req, res) {
    try {
      const caller = extractCaller(req);
      if (caller == null) { res.writeHead(400).end('bad request'); return; }
      let model = null;
      if (enabled()) {
        const row = graph()?.sessions?.find((s) => s.sessionId === caller);
        const entry = entryFor(caller);
        model = sessionModelId(row?.agent ?? entry?.agent, row?.currentModel, row?.model ?? entry?.model);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model }));
    } catch (err) {
      logError('[pr-model]', err);
      if (!res.headersSent) res.writeHead(500).end('error');
    }
  };
}
