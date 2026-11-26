// What an extension's hideTool and tool handlers see of an outside MCP client
// (clients.js): its id and name and only that extension's own scope ids,
// unprefixed. A leaf with no imports, so the extension loader can use it.
export function clientViewFor(client, extId) {
  if (!client) return null;
  const prefix = `${extId}:`;
  return {
    id: client.id,
    name: client.name,
    scopes: (client.scopes || []).filter((s) => typeof s === 'string' && s.startsWith(prefix)).map((s) => s.slice(prefix.length)),
  };
}
