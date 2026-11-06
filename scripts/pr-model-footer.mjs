#!/usr/bin/env node
// Started detached by scripts/pr-attach-hook.mjs with the url of a PR the agent
// just created: appends `Model: <id>` and `Made with Agent Wrangler` to its body,
// skipping either line it already has (server/pr-footer.js). Best-effort: every error is swallowed, no output.
import { runModelFooter } from '../server/pr-footer.js';

runModelFooter({ prUrl: process.argv[2] }).catch(() => {}).finally(() => process.exit(0));
