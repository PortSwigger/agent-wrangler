import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { logWarn } from '../log.js';

const warned = new Set();
const failures = new Map();

export function toolInputSchema(tool) {
  const key = JSON.stringify([tool.extId, tool.name]);
  try {
    const schema = normalizeObjectSchema(tool.inputSchema);
    const jsonSchema = JSON.parse(JSON.stringify(schema
      ? toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' })
      : { type: 'object', properties: {} }));
    if (!jsonSchema || Array.isArray(jsonSchema) || jsonSchema.type !== 'object') {
      throw new TypeError('Tool input schema must describe an object');
    }
    failures.delete(key);
    return { schema: schema ?? tool.inputSchema, jsonSchema };
  } catch (err) {
    failures.set(key, { name: tool.name, error: String(err?.message ?? err) });
    if (!warned.has(key)) {
      warned.add(key);
      logWarn(`[extensions] Omitting tool ${tool.extId ?? 'core'}/${tool.name}: input schema conversion failed`, err);
    }
    return null;
  }
}

export function extensionToolSchemaFailures(tools) {
  const extensions = new Map();
  for (const tool of tools) {
    if (toolInputSchema(tool)) continue;
    if (!extensions.has(tool.extId)) extensions.set(tool.extId, []);
    extensions.get(tool.extId).push(failures.get(JSON.stringify([tool.extId, tool.name])));
  }
  return [...extensions].sort(([a], [b]) => a.localeCompare(b)).map(([extId, tools]) => ({
    extId, tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
  }));
}
