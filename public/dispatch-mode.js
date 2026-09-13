export function dispatchModePresentation(mode) {
  const workflow = mode === 'workflow';
  return {
    standardPressed: !workflow,
    workflowPressed: workflow,
    intentLabel: workflow
      ? 'Issue (Jira key, GitHub issue, or description)'
      : 'Intent / first prompt',
    intentPlaceholder: workflow
      ? 'ENT-1234, a GitHub issue URL or #number, or a free-text task'
      : 'What should the agent work on?',
    launchLabel: workflow ? 'Start workflow' : 'Launch',
  };
}

export function cwdStatePresentation({ exists, scratch }) {
  if (exists === false && !scratch) {
    return {
      message: 'This folder will be created when the session starts.',
      className: 'worktree-msg hint',
      blocks: false,
    };
  }
  return { message: '', className: 'worktree-msg hidden', blocks: false };
}
