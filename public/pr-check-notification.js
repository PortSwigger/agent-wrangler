export function prCheckToastOptions(status, scope, sessionId, openSession) {
  if (status !== 'failing' && status !== 'changes-requested') return undefined;
  return {
    duration: 15000,
    actions: scope === 'session'
      ? [{ label: 'View session', onClick: () => openSession(sessionId) }]
      : [],
  };
}
