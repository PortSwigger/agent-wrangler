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
    let last = null;
    const consume = (line) => {
      for (const event of scanner.push(line)) {
        if (event.kind === 'assistant' && event.text) last = event.text;
      }
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
    return last ? clipLastSaid(last) : null;
  } catch { return null; }
}
