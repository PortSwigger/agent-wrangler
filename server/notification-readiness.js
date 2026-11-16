export function createNotificationReadiness({ entryFor, isResuming = () => false, mcpSeenAt, startedAt = Date.now() }) {
  return (id) => {
    if (isResuming(id)) return false;
    const entry = entryFor(id);
    const launchedAt = Math.max(entry?.createdAt || 0, entry?.relaunchedAt || 0);
    return !entry || entry.mailCapable === false || launchedAt < startedAt || mcpSeenAt(id) > launchedAt;
  };
}
