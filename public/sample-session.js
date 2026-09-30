// A made-up session with EVERY core card chip populated, for the settings
// dialog's sample card (api.cards.renderSample, app.js renderSampleCard). Never
// in the graph and never wired: `sample: true` tells a `card.pill` contribution
// it is drawing a preview, so it may render placeholder content or nothing.
// Links carry no url, so they render as inert <span>s rather than anchors.
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const SAMPLE_SESSION = deepFreeze({
  sessionId: '__sample__',
  sample: true,
  label: 'Sample session',
  agent: 'claude',
  status: 'idle',
  managed: true,
  restarting: true,
  cwd: '/Users/you/Projects/app-worktree-sample',
  branch: 'sample-branch',
  lastActivity: Date.now() - 5 * 60 * 1000,
  usd: 1.23,
  modelPill: { label: 'opus', title: 'Model: opus' },
  tokens: { input: 12345, output: 6789 },
  autoCompactTokens: 200000,
  subAgents: [{ id: 'sample-sub', label: 'Sample sub-agent', agentType: 'general-purpose', status: 'running', startedAt: Date.now() }],
  autoMergeOnPass: true,
  runtime: 'devcontainer',
  links: [
    { type: 'pr', number: 42, checkStatus: 'passing' },
    { type: 'jira', key: 'ABC-123' },
  ],
});
