import { fileURLToPath } from 'node:url';

// An extension written against the surfaces boards had before the deck API:
// it reads dropped session fields off the graph, fetches GET /file and
// GET /ext-file, and opens a /ws without ?api=. server/extension-compat.test.js
// installs it to pin that each still works, through its adapter.
const dir = fileURLToPath(new URL('.', import.meta.url));
const note = `${dir}note.md`;

export default {
  id: 'compat-probe',
  dir,
  label: 'Compat probe',
  defaultEnabled: true,
  requires: ['files:view'],
  client: 'public/client.js',
  handlers: [{ type: 'compat-probe-ping', handler: (msg, _host, reply) => reply({ pong: msg.n }) }],
  graph({ host }) {
    host.files.allow(note);
    return { compatProbe: { note } };
  },
};
