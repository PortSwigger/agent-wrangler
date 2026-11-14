import { fileURLToPath } from 'node:url';

// A split extension whose board half shows one section per deck that reports
// it (api.decks()), each with that deck's own count and a button that bumps it
// on that deck alone (api.act's `deck`). server/multi-deck-extensions.test.js
// installs it on two decks, one of them with another boardApi.
let count = 0;

export default {
  id: 'per-deck-probe',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  label: 'Per-deck probe',
  version: '0.1.0',
  defaultEnabled: true,
  requires: ['board:rebuild'],
  boardApi: '^1.77.0',
  handlers: [{
    type: 'per-deck-probe-bump',
    async handler(_msg, host, reply) {
      count += 1;
      await host.rebuild();
      reply({ count });
    },
  }],
  graph: () => ({ count }),
  board: { client: 'public/client.js', styles: 'public/styles.css' },
};
