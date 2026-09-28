import fs from 'node:fs';
import path from 'node:path';

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Claude already loads each extension-shipped skill directory as a plugin.
// Its native hook file lives there; Codex reads the same file at launch.
export function nativeHookGroups({ dir, skills = [] }) {
  const groups = {};
  for (const skill of skills) {
    const pluginDir = path.join(dir, 'skills', skill);
    const file = path.join(pluginDir, 'hooks', 'hooks.json');
    if (!fs.existsSync(file)) continue;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config?.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
      throw new Error(`${file} must contain a hooks object`);
    }
    for (const [event, entries] of Object.entries(config.hooks)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(event) || !Array.isArray(entries)) {
        throw new Error(`${file}: invalid hook event ${JSON.stringify(event)}`);
      }
      for (const group of entries) {
        if (!Array.isArray(group?.hooks) || !group.hooks.length) throw new Error(`${file}: ${event} needs hooks`);
        for (const hook of group.hooks) {
          if (hook?.type !== 'command' || typeof hook.command !== 'string' || !hook.command) {
            throw new Error(`${file}: ${event} must use command hooks supported by Claude and Codex`);
          }
        }
        (groups[event] ||= []).push({ ...group, hooks: group.hooks.map((hook) => ({
          ...hook,
          // A CLI config hook has no plugin root of its own. Set both native
          // names inside a child shell so quoted and unquoted uses expand alike.
          command: `env CLAUDE_PLUGIN_ROOT=${quote(pluginDir)} PLUGIN_ROOT=${quote(pluginDir)} sh -c ${quote(hook.command)}`,
        })) });
      }
    }
  }
  return groups;
}
