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
  --port <n>         Port to listen on (env AW_PORT, default 7878)
  --data-dir <path>  State directory (env AW_DATA_DIR, default ~/.agent-wrangler).
                     One instance per data dir; use a distinct one to run an
                     isolated instance.
  --open             Open the board in a browser once it is serving
                     (env AW_OPEN_BROWSER=1)
  --host <addr>      Interface to bind (env AW_BIND_HOST, default 127.0.0.1).
                     Anything other than loopback exposes session control to
                     your network; only use it deliberately, e.g. 0.0.0.0 for a
                     devcontainer session that must reach /mcp.
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
    env.AW_PORT = String(port);
  }
  if (values['data-dir'] !== undefined) {
    if (!values['data-dir']) return { action: 'error', error: '--data-dir must not be empty' };
    env.AW_DATA_DIR = values['data-dir'];
  }
  if (values.open) env.AW_OPEN_BROWSER = '1';
  if (values.host !== undefined) {
    if (!values.host) return { action: 'error', error: '--host must not be empty' };
    env.AW_BIND_HOST = values.host;
  }
  return { action: 'run', env };
}
