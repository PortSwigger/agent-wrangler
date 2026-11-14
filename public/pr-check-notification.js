export const PR_TOAST_MS = 15000;

export function prCheckToastOptions(status, scope, sessionId, openSession) {
  if (status !== 'failing' && status !== 'changes-requested') return undefined;
  return {
    duration: PR_TOAST_MS,
    actions: scope === 'session'
      ? [{ label: 'View session', onClick: () => openSession(sessionId) }]
      : [],
  };
}

export function prAlertToastOptions() {
  return { duration: PR_TOAST_MS };
}

export function prToastSuppressed(msg, suppressNudged) {
  return Boolean(suppressNudged && msg.nudged);
}
