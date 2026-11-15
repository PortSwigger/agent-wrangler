import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const file = (name) => new URL(name, import.meta.url);

export default {
  id: 'restart-probe',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  label: 'Restart probe',
  defaultEnabled: true,
  requires: [],
  stores: {
    restartProbe: () => ({
      async write() {
        fs.writeFileSync(file('committed'), 'applied');
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(file('release'))) {
          if (Date.now() > deadline) throw new Error('probe release timed out');
          await delay(10);
        }
        return { applied: true };
      },
    }),
  },
  tools: [{
    name: 'restart_probe',
    description: 'Hold a committed test write until released.',
    inputSchema: {},
    async handler({ host }) {
      const result = await host.stores.restartProbe.write();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  }],
};
