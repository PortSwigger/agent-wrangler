import { parseArgs } from 'node:util';

// Command-line flags for bin/agent-wrangler. Each flag only sets the env var the
// server already reads, because DATA_DIR and the port are resolved at module load
// (ESM imports are hoisted), so cli.js must apply these before importing
// index.js. Pure — argv in, an action and env out — so it is testable without
// booting the server.

export function usage() {
  return `Usage: agent-wrangler [options]

Starts the Agent Wrangler board and serves it until stopped (Ctrl-C).

Options:
  --port <n>         Port to listen on (env AW_PORT, default 7878). With
                     --deck-only, the deck's port (env AW_DECK_PORT).
  --data-dir <path>  State directory (env AW_DATA_DIR, default ~/.agent-wrangler).
                     One instance per data dir; use a distinct one to run an
                     isolated instance.
  --open             Open the board in a browser once it is serving
                     (env AW_OPEN_BROWSER=1)
  --host <addr>      Interface to bind (env AW_BIND_HOST, default 127.0.0.1).
                     Anything other than loopback exposes session control to
                     your network; only use it deliberately, e.g. 0.0.0.0 for a
                     devcontainer session that must reach /mcp.
  --deck-only        Serve only the deck API (GET /deck, /ws?api=1, /pty, /mcp)
                     on its own port, with no board pages (env AW_DECK_ONLY=1).
                     Give it its own --data-dir and --port.
  --allowed-origins <list>
                     Board origins allowed to use the deck, comma-separated
                     (env AW_ALLOWED_ORIGINS, or config.json allowedOrigins),
                     e.g. http://localhost:7878
  -h, --help         Show this help
  -v, --version      Show the version

Flags override the matching environment variables. Other settings are
environment-only; see the README.
`;
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  port: { type: 'string' },
  'data-dir': { type: 'string' },
  open: { type: 'boolean' },
  host: { type: 'string' },
  'deck-only': { type: 'boolean' },
  'allowed-origins': { type: 'string' },
};

// Returns { action: 'help' | 'version' | 'run', env } or { action: 'error', error }.
export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    return { action: 'error', error: err.message };
  }
  if (values.help) return { action: 'help', env: {} };
  if (values.version) return { action: 'version', env: {} };

  const env = {};
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
      return { action: 'error', error: `--port must be an integer from 1 to 65535 (got '${values.port}')` };
    }
    env[values['deck-only'] ? 'AW_DECK_PORT' : 'AW_PORT'] = String(port);
  }
  if (values['data-dir'] !== undefined) {
    if (!values['data-dir']) return { action: 'error', error: '--data-dir must not be empty' };
    env.AW_DATA_DIR = values['data-dir'];
  }
  // The legacy AW_NO_OPEN suppresses even AW_OPEN_BROWSER (shouldOpenBrowser), so
  // clear it too or --open loses to an old plist's setting.
  if (values.open) Object.assign(env, { AW_OPEN_BROWSER: '1', AW_NO_OPEN: '' });
  if (values.host !== undefined) {
    if (!values.host) return { action: 'error', error: '--host must not be empty' };
    env.AW_BIND_HOST = values.host;
  }
  if (values['deck-only']) env.AW_DECK_ONLY = '1';
  if (values['allowed-origins'] !== undefined) {
    const bad = values['allowed-origins'].split(',').map((o) => o.trim()).filter(Boolean)
      .find((o) => { try { return new URL(o).origin !== o.replace(/\/+$/, ''); } catch { return true; } });
    if (bad) return { action: 'error', error: `--allowed-origins takes origins like http://localhost:7878 (got '${bad}')` };
    env.AW_ALLOWED_ORIGINS = values['allowed-origins'];
  }
  return { action: 'run', env };
}
