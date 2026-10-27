import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../data-dir.js';
import { writeJsonAtomic } from '../../../atomic-json.js';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

export class LoginStore {
  constructor(root = path.join(DATA_DIR, 'logins')) { this.root = root; }

  slugFor(label) {
    const slug = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) throw new Error('A login needs a name');
    return slug;
  }

  dir(slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid login');
    return path.join(this.root, slug);
  }

  codexHome(slug) { return path.join(this.dir(slug), 'codex-home'); }
  claudeTokenPath(slug) { return path.join(this.dir(slug), 'claude.token'); }
  _sessions() {
    const sessions = readJson(path.join(this.root, 'sessions.json'), {});
    if (!sessions || Array.isArray(sessions) || typeof sessions !== 'object' || Object.values(sessions).some((slug) => typeof slug !== 'string')) throw new Error('Invalid login bindings');
    return sessions;
  }
  _removed() { return readJson(path.join(this.root, 'removed.json'), {}); }
  labelFor(slug) { return this.get(slug)?.label || this._removed()[slug] || slug; }

  add(label) {
    const slug = this.slugFor(label);
    const dir = this.dir(slug);
    if (fs.existsSync(dir) || Object.hasOwn(this._removed(), slug)) throw new Error(`A login called "${label}" already exists`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(dir, 'login.json'), { label: String(label).trim(), createdAt: Date.now() });
    return { slug, label: String(label).trim() };
  }

  get(slug) {
    const meta = readJson(path.join(this.dir(slug), 'login.json'), null);
    if (!meta) return null;
    const authPath = path.join(this.codexHome(slug), 'auth.json');
    let email = null;
    if (fs.existsSync(authPath)) {
      try {
        const auth = readJson(authPath, {});
        const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
        if (typeof claims.email === 'string') email = claims.email;
      } catch { /* An opaque login still counts as present. */ }
    }
    return { slug, label: meta.label, claude: { present: fs.existsSync(this.claudeTokenPath(slug)), capturedAt: meta.claudeCapturedAt ?? null }, codex: { present: fs.existsSync(authPath), email } };
  }

  list() {
    let entries;
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return entries.filter((e) => e.isDirectory()).map((e) => this.get(e.name)).filter(Boolean);
  }

  setClaudeToken(slug, token) {
    if (!this.get(slug)) throw new Error(`login "${this.labelFor(slug)}" no longer exists`);
    const file = this.claudeTokenPath(slug);
    fs.writeFileSync(file, token.trim(), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const metaPath = path.join(this.dir(slug), 'login.json');
    writeJsonAtomic(metaPath, { ...readJson(metaPath, {}), claudeCapturedAt: Date.now() });
  }

  readClaudeToken(slug) {
    try {
      const token = fs.readFileSync(this.claudeTokenPath(slug), 'utf8').trim();
      if (token) return token;
    } catch { /* Report a named refusal without exposing file contents. */ }
    throw new Error(`login "${this.labelFor(slug)}" has no usable Claude token`);
  }

  forget(slug, provider) {
    if (!this.get(slug)) throw new Error(`login "${this.labelFor(slug)}" no longer exists`);
    if (provider === 'codex') fs.rmSync(this.codexHome(slug), { recursive: true, force: true });
    else if (provider === 'claude') {
      fs.rmSync(this.claudeTokenPath(slug), { force: true });
      const file = path.join(this.dir(slug), 'login.json');
      const meta = readJson(file, {});
      delete meta.claudeCapturedAt;
      writeJsonAtomic(file, meta);
    } else throw new Error('Invalid login provider');
  }

  remove(slug) {
    const label = this.labelFor(slug);
    const sessions = this._sessions();
    if (Object.values(sessions).includes(slug)) writeJsonAtomic(path.join(this.root, 'removed.json'), { ...this._removed(), [slug]: label });
    fs.rmSync(this.dir(slug), { recursive: true, force: true });
  }

  bind(cardId, slug) {
    this.dir(slug);
    writeJsonAtomic(path.join(this.root, 'sessions.json'), { ...this._sessions(), [cardId]: slug });
  }
  loginFor(cardId) { return Object.hasOwn(this._sessions(), cardId) ? this._sessions()[cardId] : null; }
  unbind(cardId) {
    const sessions = this._sessions();
    delete sessions[cardId];
    writeJsonAtomic(path.join(this.root, 'sessions.json'), sessions);
    const removed = this._removed();
    for (const slug of Object.keys(removed)) if (!Object.values(sessions).includes(slug)) delete removed[slug];
    writeJsonAtomic(path.join(this.root, 'removed.json'), removed);
  }
  snapshot() {
    const sessions = this._sessions();
    const logins = this.list();
    for (const [slug, label] of Object.entries(this._removed())) logins.push({ slug, label, removed: true });
    return { logins, sessions };
  }
}
