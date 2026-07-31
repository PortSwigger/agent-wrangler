import crypto from 'node:crypto';
import { z } from 'zod';

// Open a plain-shell terminal in the board sidebar. The shell starts in the
// caller's session cwd, and `command` (if given) is pre-populated in the prompt
// without Enter — the user decides when to run it. Rejected if no board clients
// are connected (nowhere to show it). Returns an error if any newline is detected
// in `command` (guards against prompt-injection across session boundaries).
export const createTerminalTool = {
  name: 'create_terminal',
  description:
    'Open a plain shell terminal in the wrangler board sidebar, in your session\'s working '
    + 'directory. Optionally pre-populate the shell prompt with `command` (without running it — '
    + 'the user decides). Only works when a board client is connected. Returns an error when '
    + 'no board is open, when your session cwd cannot be resolved, or when `command` contains '
    + 'a newline.',
  inputSchema: {
    command: z.string().optional()
      .refine((s) => s == null || !s.includes('\n'), { message: 'command must not contain newlines' })
      .describe('Shell command to pre-populate the prompt with (no Enter). Omit to open a blank shell.'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity.');
    const entry = deps.sessionManager.entryFor(caller);
    if (!entry?.cwd) return errorResult('Could not resolve the working directory for your session.');
    if (deps.boardClients() === 0) return errorResult('No board clients are connected — nothing to show the terminal in.');

    const terminalId = `t_${crypto.randomBytes(4).toString('hex')}`;
    let tmuxName;
    try {
      tmuxName = await deps.createShellSession(entry.cwd, deps.sessionManager.socket, args.command ?? '');
    } catch (err) {
      return errorResult(`Failed to create shell session: ${String(err.message || err)}`);
    }
    deps.terminalRegistry.set(terminalId, { tmuxName, socket: deps.sessionManager.socket, cwd: entry.cwd });
    deps.broadcast({ type: 'open-terminal', terminalId, command: args.command ?? '', sessionId: caller });
    return { content: [{ type: 'text', text: `Shell terminal opened (${terminalId})` }] };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
