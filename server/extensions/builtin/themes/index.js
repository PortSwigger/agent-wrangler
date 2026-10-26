import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled themes beyond Dark and Light. Each folder under themes/ is one
// theme, and gets a hidden toggle whose `theme` names it: false takes it out
// of the picker and /api/styles (extensions/index.js themeSources), unset is
// on. The settings panel (public/index.js) draws one picker button per theme.

export const dir = path.dirname(fileURLToPath(import.meta.url));
export const THEMES_DIR = path.join(dir, 'themes');

const camel = (id) => id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

// Every theme folder with a readable theme.json, sorted by id.
export function readThemes(themesDir = THEMES_DIR) {
  const out = [];
  for (const e of fs.readdirSync(themesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(themesDir, e.name, 'theme.json'), 'utf8'));
      out.push({ id: e.name, key: camel(e.name), manifest });
    } catch {}
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const listThemesHandler = {
  type: 'themes-list',
  handler(msg, host, reply) {
    reply({ kind: 'themes', reqId: msg.reqId, themes: readThemes() });
  },
};

export default {
  id: 'themes',
  label: 'Themes',
  description: 'Extra themes for Settings › Appearance beyond Dark and Light.',
  help: 'Turn a theme off to hide it from the picker. A browser that had it chosen shows Dark until it is back on.',
  author: 'Agent Wrangler',
  dir,
  defaultEnabled: true,
  themes: 'themes',
  settings: readThemes().map((t) => ({ key: t.key, type: 'toggle', label: t.manifest.name || t.id, theme: t.id, hidden: true })),
  handlers: [listThemesHandler],
  engines: { wranglerApi: '^1.45.0' },
  client: 'public/index.js',
};
