export const PR_TOAST_MS = 15000;

export function prToastActions(scope, ownerId, openSession, openTask) {
  if (scope === 'session') return [{ label: 'View session', onClick: () => openSession(ownerId) }];
  if (scope === 'task') return [{ label: 'View task', onClick: () => openTask(ownerId) }];
  return [];
}

export function prCheckToastOptions(status, scope, ownerId, openSession, openTask) {
  return {
    ...(['failing', 'changes-requested'].includes(status) ? { duration: PR_TOAST_MS } : {}),
    actions: prToastActions(scope, ownerId, openSession, openTask),
  };
}

export function prAlertToastOptions(scope, ownerId, openSession, openTask) {
  return { duration: PR_TOAST_MS, actions: prToastActions(scope, ownerId, openSession, openTask) };
}

export function prToastSuppressed(msg, suppressNudged) {
  return Boolean(suppressNudged && msg.nudged);
}
