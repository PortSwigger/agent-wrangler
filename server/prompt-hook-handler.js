// The two native UserPromptSubmit hooks post here before their model request.
// Their JSON output is the same for Claude and Codex: additionalContext joins
// the current prompt, while a blocking decision keeps it from being processed.
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export function createPromptHookHandler(sessionManager, { onError = () => {} } = {}) {
  return async (req, res) => {
    try {
      const sessionId = req.headers['x-aw-session'];
      if (typeof sessionId !== 'string' || !sessionManager.acceptsPromptHook(sessionId)) {
        res.writeHead(404).end('unknown session'); return;
      }
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_INPUT_BYTES) { res.writeHead(413).end('hook input too large'); return; }
        body += chunk;
      }
      let input;
      try { input = JSON.parse(body); }
      catch { res.writeHead(400).end('invalid hook json'); return; }
      if (input?.hook_event_name !== 'UserPromptSubmit' || typeof input.prompt !== 'string' || input.agent_id) {
        res.writeHead(400).end('invalid hook input'); return;
      }
      const result = await sessionManager.runPromptHooks({
        sessionId, liveSessionId: input.session_id || null,
        agent: input.agent === 'codex' ? 'codex' : 'claude',
        entry: sessionManager.entryFor(sessionId) || null,
        prompt: input.prompt, cwd: input.cwd || null, model: input.model || null,
        source: input.source || null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      onError(err);
      if (!res.headersSent) res.writeHead(500).end('hook error');
    }
  };
}
