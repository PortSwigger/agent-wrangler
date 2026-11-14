import { fileURLToPath } from 'node:url';

// An extension that calls every member of the board's extension api, written
// in the unsplit manifest shape (client and styles at the top level).
// server/ext-api.test.js installs it on an isolated instance and pins that each
// member still works on top of the deck API.
const dir = fileURLToPath(new URL('.', import.meta.url));
const note = `${dir}note.md`;

export default {
  id: 'ext-api-probe',
  dir,
  label: 'Extension API probe',
  version: '0.1.0',
  defaultEnabled: true,
  requires: ['files:view', 'cards:hideChips', 'board:press', 'session:type'],
  engines: { wranglerApi: '^1.74.0' },
  hideDispatchField: ['effort'],
  keybindings: [{ combo: 'Alt+Shift+P', scope: 'board' }],
  earlyAdopter: { branch: 'next' },
  settings: [{ key: 'probe', type: 'text', label: 'Probe' }],
  client: 'public/client.js',
  styles: 'public/styles.css',
  handlers: [{ type: 'ext-api-probe-ping', handler: (msg, _host, reply) => reply({ pong: msg.n }) }],
  graph({ host }) {
    host.files.allow(note);
    return { extApiProbe: { note } };
  },
};
