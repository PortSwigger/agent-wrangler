import { parseCliArgs, usage } from './cli-args.js';
import { VERSION } from './version.js';

// Entry point exec'd by bin/agent-wrangler. Flags become env vars BEFORE the
// server module is imported: index.js and data-dir.js read them at module load,
// and a static import would be hoisted above this code.
const parsed = parseCliArgs(process.argv.slice(2));

if (parsed.action === 'help') {
  process.stdout.write(usage());
  process.exit(0);
}
if (parsed.action === 'version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (parsed.action === 'error') {
  process.stderr.write(`agent-wrangler: ${parsed.error}\n\n${usage()}`);
  process.exit(2);
}

Object.assign(process.env, parsed.env);
await import('./index.js');
