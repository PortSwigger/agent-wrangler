import { fileURLToPath } from 'node:url';

// A runtime only the deck it is installed on offers, whose pane runs `sleep`
// in place of an agent. server/multi-deck.test.js installs it on a second deck
// to start real sessions there from the board's new-session dialog.
export default {
  id: 'deck-runtime-probe',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  label: 'Deck runtime probe',
  version: '0.1.0',
  defaultEnabled: true,
  runtimes: [{
    id: 'probe-shell',
    label: 'Probe shell',
    resumable: false,
    buildLaunch: async () => 'sleep 3600',
  }],
};
