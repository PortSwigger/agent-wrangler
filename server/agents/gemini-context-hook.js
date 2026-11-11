#!/usr/bin/env node
// Gemini CLI SessionStart hook (gemini-config.js registers it): hands the
// session the instructions its launch carried in $AW_GEMINI_CONTEXT, which
// Gemini adds to the conversation as context. A resumed conversation already
// holds them, so only a fresh start or a /clear gets them again. Always exits 0
// and prints nothing else: a failing hook must never block a session starting.
let input = '';
try {
  for await (const chunk of process.stdin) input += chunk;
} catch { /* no stdin */ }
let source = null;
try { source = JSON.parse(input)?.source ?? null; } catch { /* not JSON */ }
const context = process.env.AW_GEMINI_CONTEXT;
if (context && source !== 'resume') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}
