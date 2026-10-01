import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A BUILTIN: the adversarial-pr-review skill plus the one thing a static
// SKILL.md cannot carry — the human's configured review process. The skill is
// the discoverable entry point and names the tool in the reviewer's brief; a
// tool on its own is not discovered (measured, see docs/extensions.md).
//
// Leaf-safe like every manifest under server/extensions/**: fs/path/url only.

export const dir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROCESS = fs.readFileSync(path.join(dir, 'default-process.md'), 'utf8');
export const REPORT_CONTRACT = fs.readFileSync(path.join(dir, 'report-contract.md'), 'utf8');

// The process is the human's to replace; the contract is not. The initiator —
// and any fix/re-review loop around it — waits on exactly one mail in exactly
// this shape, so a custom process that dropped the mail-back would stall it.
export function reviewBrief(configured) {
  const custom = typeof configured === 'string' && configured.trim() !== '';
  return [
    `Review process: ${custom ? 'custom (from Settings)' : 'default'}`,
    '',
    (custom ? configured : DEFAULT_PROCESS).trim(),
    '',
    '## Obligations and report format (fixed)',
    '',
    REPORT_CONTRACT.trim(),
  ].join('\n');
}

const adversarialReviewProcessTool = {
  name: 'adversarial_review_process',
  description:
    'For an adversarial PR REVIEWER launched by the adversarial-pr-review skill: returns the review '
    + 'process to follow and the fixed rules for reporting back. Call it first, before reviewing, and '
    + 'follow what it returns exactly. Takes no arguments.',
  inputSchema: {},
  async handler({ host }) {
    return { content: [{ type: 'text', text: reviewBrief(host.settings.get('process')) }] };
  },
};

export default {
  id: 'adversarial-review',
  label: 'Adversarial PR review',
  description: 'A second opinion on a pull request from the opposite agent provider, following a written-out review process you can replace in Settings.',
  help: 'Adds the adversarial-pr-review skill and the review process its reviewer follows.',
  author: 'Agent Wrangler',
  dir,
  defaultEnabled: true,
  requires: [],
  engines: { wranglerApi: '^1.16.0' },
  skills: ['adversarial-pr-review'],
  settings: [{
    key: 'process',
    type: 'textarea',
    label: 'Review process',
    help: 'What the reviewer checks and how. Leave empty to use the built-in process (shown here, and in '
      + 'server/extensions/builtin/adversarial-review/default-process.md). Anything you write replaces it. '
      + 'The read-only rules and the report format sent back are fixed either way.',
    placeholder: DEFAULT_PROCESS,
  }],
  tools: [adversarialReviewProcessTool],
};
