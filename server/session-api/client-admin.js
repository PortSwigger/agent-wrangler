// What Settings' Outside MCP clients panel does, through the deck actions
// `admin.outside-clients`, `admin.outside-client-mint` and
// `admin.outside-client-revoke` (deck/native-actions.js). Minting is a board
// action only: no MCP tool can mint, list or widen a client token.
//
// `clients` is the store (clients.js), `scopes()` the enabled extensions'
// declared scopes (the loader's clientScopes), `extLabel(id)` an extension's
// display name, and `endpoint()` where a client calls and whether the session
// API is on loopback (session-api/index.js).
export function createClientAdmin({ clients, scopes, extLabel = (id) => id, endpoint = () => ({ url: null, loopback: false }), log = () => {} }) {
  const scopeList = () => (scopes() || []).map((sc) => ({
    key: sc.key,
    extId: sc.extId,
    extension: extLabel(sc.extId) || sc.extId,
    label: sc.label,
    description: sc.description || '',
    exclusive: sc.exclusive === true,
    tools: [...sc.tools],
  }));
  const describe = (c) => `"${c.name}" (${c.id})`;

  function state() {
    return { clients: clients.list(), scopes: scopeList(), endpoint: endpoint() };
  }

  return {
    state,
    // Answers the new token once, beside the refreshed state; it is never kept.
    mint({ name, scopes: wanted, days } = {}) {
      const declared = scopeList();
      const keys = new Set(declared.map((sc) => sc.key));
      const exclusive = new Set(declared.filter((sc) => sc.exclusive).map((sc) => sc.key));
      const { client, token } = clients.mint({ name, scopes: wanted, days, known: (k) => keys.has(k), exclusive });
      log(`[outside-clients] minted ${describe(client)} with ${client.scopes.join(', ')}, expiring ${new Date(client.expiresAt).toISOString()}`);
      return { ...state(), minted: client, token };
    },
    revoke(id) {
      const gone = typeof id === 'string' ? clients.revoke(id) : null;
      if (!gone) throw new Error('No such client');
      log(`[outside-clients] revoked ${describe(gone)}`);
      return state();
    },
    // The MCP layer's report of every request (seen) and tool call (called).
    seen(client) { clients.noteUse(client.id); },
    // `outcome` is ok, error or threw for a tool it was offered, and refused for
    // one it was not, whose name the client chose (so it is quoted, and not kept
    // as its last tool).
    called(client, tool, outcome, ms) {
      if (outcome === 'refused') {
        clients.noteUse(client.id);
        log(`[outside-clients] ${describe(client)} called ${JSON.stringify(String(tool).slice(0, 64))}: refused, not in its scopes`);
        return;
      }
      clients.noteUse(client.id, tool);
      log(`[outside-clients] ${describe(client)} called ${tool}: ${outcome} in ${ms}ms`);
    },
  };
}
