import { createHash } from 'node:crypto';
import { toolInputSchema } from './tool-schema.js';

export const TOOL_REFRESH_NOTE = 'Extension MCP tool schemas changed; re-run ToolSearch before calling MCP tools and disregard earlier schema results.';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      const next = canonical(value[key]);
      return [key, key === 'required' && Array.isArray(next) ? next.sort() : next];
    }));
  }
  return value;
}

export function extensionToolFingerprint(tools) {
  const schemas = tools.flatMap((tool) => {
    const converted = toolInputSchema(tool);
    return converted ? [{ name: tool.name, description: tool.description, inputSchema: converted.jsonSchema }] : [];
  })
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(canonical(schemas))).digest('hex');
}
