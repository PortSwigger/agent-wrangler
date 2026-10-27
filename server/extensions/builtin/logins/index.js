import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoginStore } from './login-store.js';
import { HANDLERS, stopCaptures } from './handlers.js';
import { prepare, launchContext, onBeforeDispatch, onFork, onPurge } from './launch.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const watchers = new WeakMap();

export default {
  id: 'logins', label: 'Logins',
  help: 'Run a session on a stored second Claude or Codex login, chosen in the dispatch dialog. Off, every session relaunches on the CLIs’ own login; stored logins are kept.',
  description: 'Dispatch a session on another Claude or Codex login while the rest of the board keeps Default.',
  author: 'Agent Wrangler', defaultEnabled: false, dir,
  requires: ['board:rebuild', 'terminals:create'],
  engines: { wranglerApi: '^1.48.0' },
  stores: { logins: () => new LoginStore() },
  handlers: HANDLERS,
  hooks: { 'session.prepare': prepare, 'session.launchContext': launchContext },
  session: { onBeforeDispatch, onFork, onPurge },
  graph: ({ host }) => ({ logins: host.stores.logins.snapshot() }),
  activate({ host }) {
    const store = host.stores.logins;
    fs.mkdirSync(store.root, { recursive: true, mode: 0o700 });
    let timer;
    const watcher = fs.watch(store.root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { host.rebuild().catch(() => {}); }, 100);
      timer.unref?.();
    });
    watcher.on('error', () => { host.rebuild().catch(() => {}); });
    watchers.set(store, () => { watcher.close(); clearTimeout(timer); });
  },
  deactivate({ host }) {
    const store = host?.stores?.logins;
    if (!store) return;
    watchers.get(store)?.();
    watchers.delete(store);
    stopCaptures(store);
  },
  client: 'public/index.js', styles: 'public/styles.css',
};
