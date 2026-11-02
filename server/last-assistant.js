import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { adapterFor as defaultAdapterFor } from './agents/index.js';
import { clipLastSaid } from './status-notice-format.js';

export async function lastAssistantText(entry, { adapterFor = defaultAdapterFor, historyOptions } = {}) {
  try {
    if (!entry) return null;
    const { history } = adapterFor(entry.agent ?? 'claude');
    const files = await history.findFiles(entry.liveSessionId || entry.sessionId, historyOptions);
    const scanner = history.createScanner();
    const branch = (entry.agent ?? 'claude') === 'claude' ? [] : null;
    let last = null;
    const take = (events) => {
      for (const event of events) {
        if (event.kind === 'assistant' && event.text) last = event.text;
      }
    };
    const consume = (line) => {
      if (!branch) return take(scanner.push(line));
      const tagged = scanner.pushTagged(line);
      const events = tagged.events.filter((e) => e.kind === 'user' || e.kind === 'assistant')
        .map((e) => e.kind === 'user' ? { kind: 'user' } : { kind: 'assistant', text: clipLastSaid(e.text ?? '') });
      if (events.length) branch.push({ uuid: tagged.uuid, events });
    };
    for (const file of files) {
      if (history.forEachLine) await history.forEachLine(file, consume);
      else {
        const stream = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try { for await (const line of lines) consume(line); }
        finally { lines.close(); stream.destroy(); }
      }
    }
    if (branch) take(scanner.selectLive(branch));
    return last ? clipLastSaid(last) : null;
  } catch { return null; }
}
