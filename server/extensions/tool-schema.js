import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { logWarn } from '../log.js';

const warned = new Set();

export function toolInputSchema(tool) {
  try {
    const schema = normalizeObjectSchema(tool.inputSchema);
    const jsonSchema = JSON.parse(JSON.stringify(schema
      ? toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' })
      : { type: 'object', properties: {} }));
    if (!jsonSchema || Array.isArray(jsonSchema) || jsonSchema.type !== 'object') {
      throw new TypeError('Tool input schema must describe an object');
    }
    return { schema: schema ?? tool.inputSchema, jsonSchema };
  } catch (err) {
    const key = JSON.stringify([tool.extId, tool.name]);
    if (!warned.has(key)) {
      warned.add(key);
      logWarn(`[extensions] Omitting tool ${tool.extId ?? 'core'}/${tool.name}: input schema conversion failed`, err);
    }
    return null;
  }
}
