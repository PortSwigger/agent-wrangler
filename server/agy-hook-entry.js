import { agyHookResponse } from './agy-hooks.js';
if (process.env.AW_SESSION_ID) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 256 * 1024) break; }
    const payload = JSON.parse(input || '{}');
    const event = process.argv[2];
    const port = Number(process.env.AW_PORT);
    if (port > 0 && port <= 65535) {
      const response = await fetch(`http://127.0.0.1:${port}/agy-hook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(900),
        body: JSON.stringify({ cardId: process.env.AW_SESSION_ID, conversationId: payload.conversationId, event, parentPid: process.ppid, modelName: payload.modelName, stepIdx: payload.stepIdx, fullyIdle: payload.fullyIdle, terminationReason: payload.terminationReason }),
      });
      if (response.ok) {
        const { accepted, identified, tools } = await response.json();
        if (accepted || (identified && event === 'SessionStart')) {
          const result = agyHookResponse(event, payload, { tools });
          if (result) process.stdout.write(JSON.stringify(result));
        }
      }
    }
  } catch {}
}
