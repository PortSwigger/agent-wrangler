export const IDLE_HOLD_MS = 60000;
export const QUIET_MS = 900000;

export function createStatusWatcher() {
  const states = new Map();
  const exited = new Set();
  return {
    forget(id) { states.delete(id); },
    tick(sessions, entryFor, { now, mailSince = () => false }) {
      const nodes = new Map(sessions.map((s) => [s.sessionId, s]));
      const events = [];
      for (const id of new Set([...states.keys(), ...nodes.keys(), ...exited])) {
        const node = nodes.get(id);
        const entry = entryFor(id);
        const exitReason = node?.exitOutput ? 'exited' : entry?.archivedAt ? 'archived' : !node && !entry ? 'gone' : null;
        if (exited.has(id)) {
          if (exitReason) {
            if (!node && !entry) exited.delete(id);
            continue;
          }
          exited.delete(id);
        }
        const previous = states.get(id);
        const to = entry ? entry.statusNotify?.to ?? null : previous?.to ?? null;
        const child = node ? {
          sessionId: id, label: node.label, status: node.status,
          waitingFor: node.waitingFor ?? null, exitOutput: node.exitOutput ?? null,
        } : previous?.child;
        const status = node?.managed === false && !node.exitOutput ? 'idle'
          : node?.status ?? 'unknown';
        const effective = status === 'idle' && node?.hasBackgroundShell ? 'working' : status;
        if (!previous) {
          if (exitReason) { exited.add(id); continue; }
          states.set(id, { status: effective, idleSince: effective === 'idle' ? now : null,
            workingSeen: effective === 'working', notified: new Set(), child, to });
          continue;
        }
        previous.child = child;
        previous.to = to;
        if (exitReason) {
          events.push({ to, child, kind: 'exited', exitReason });
          exited.add(id);
          states.delete(id);
          continue;
        }
        if (effective === 'unknown' && previous.status === 'idle') continue;
        if (effective !== previous.status) {
          previous.notified.clear();
          previous.idleSince = effective === 'idle' ? now : null;
        }
        const event = { to, child };
        if (effective === 'needs-you' && previous.status !== 'needs-you') {
          events.push({ ...event, kind: 'needs-you' });
        } else if (effective === 'idle' && previous.workingSeen && now - previous.idleSince >= IDLE_HOLD_MS && !previous.notified.has('idle')) {
          previous.notified.add('idle');
          events.push({ ...event, kind: 'idle', idleMs: now - previous.idleSince,
            reported: to !== null && mailSince(id, to, previous.idleSince) });
        } else if (effective === 'working' && status === 'working' && Number.isFinite(node?.lastActivity)
          && now - node.lastActivity >= QUIET_MS && !previous.notified.has('quiet')) {
          previous.notified.add('quiet');
          events.push({ ...event, kind: 'quiet', quietMs: now - node.lastActivity });
        }
        previous.workingSeen ||= effective === 'working';
        previous.status = effective;
      }
      return events;
    },
  };
}
