// The sessions in a task whose card shows a status halo that "Clear statuses"
// quiets: a just-finished or unread cyan alarm, an unacknowledged needs-you
// flash, or a fired (awake) snooze. A still-sleeping snooze is set aside, not
// alarming, so it is left alone.
export function clearableSessions(sessions, { justFinished, unread, isAcknowledged, phaseOf }) {
  return sessions.filter((s) => {
    const phase = phaseOf(s);
    if (phase === 'asleep') return false;
    return justFinished.has(s.sessionId)
      || unread.has(s.sessionId)
      || (s.status === 'needs-you' && !isAcknowledged(s))
      || phase === 'awake';
  });
}
