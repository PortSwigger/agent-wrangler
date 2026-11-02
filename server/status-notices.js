import { lastActiveAt } from './session-manager.js';

export const IDLE_HOLD_MS = 60000;
export const QUIET_MS = 900000;

export function createStatusWatcher() {
  const states = new Map();
  const exited = new Set();
  let seeded = false;
  return {
    forget(id) { states.delete(id); },
    tick(sessions, entryFor, { now, mailSince = () => false }) {
      const baseline = !seeded;
      seeded = true;
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
        const launchAt = lastActiveAt({ relaunchedAt: entry?.relaunchedAt, createdAt: entry?.createdAt });
        const activeAt = lastActiveAt({ lastActivity: node?.lastActivity, relaunchedAt: entry?.relaunchedAt, createdAt: entry?.createdAt });
        let previous = states.get(id);
        const to = entry ? entry.statusNotify?.to ?? null : previous?.to ?? null;
        const child = node ? {
          sessionId: id, label: node.label, status: node.status,
          waitingFor: node.waitingFor ?? null, exitOutput: node.exitOutput ?? null,
        } : previous?.child;
        const status = node?.managed === false && !node.exitOutput ? 'idle'
          : node?.status ?? 'unknown';
        const effective = status === 'idle' && node?.hasBackgroundShell ? 'working' : status;
        if (!previous) {
          if (exitReason && baseline) { exited.add(id); continue; }
          previous = { status: baseline ? effective : 'unknown', idleSince: effective === 'idle' ? now : null,
            workingSeen: baseline && effective === 'working',
            workingSince: effective === 'working' ? launchAt ?? entry?.statusNotify?.since ?? now : null,
            notified: new Set(), child, to, launchAt };
          states.set(id, previous);
          if (baseline) continue;
        }
        if (previous.launchAt !== launchAt) {
          previous.notified.delete('quiet');
          previous.workingSince = launchAt;
        }
        previous.launchAt = launchAt;
        previous.child = child;
        previous.to = to;
        if (exitReason) {
          events.push({ to, child, kind: 'exited', exitReason });
          exited.add(id);
          states.delete(id);
          continue;
        }
        if (effective === 'unknown') continue;
        if (effective !== previous.status) {
          previous.notified.clear();
          previous.idleSince = effective === 'idle' ? now : null;
          if (effective === 'working') previous.workingSince = previous.workingSeen ? now : launchAt ?? entry?.statusNotify?.since ?? now;
        }
        const event = { to, child };
        if (effective === 'needs-you' && previous.status !== 'needs-you') {
          events.push({ ...event, kind: 'needs-you' });
        } else if (effective === 'idle' && previous.workingSeen && now - previous.idleSince >= IDLE_HOLD_MS && !previous.notified.has('idle')) {
          previous.notified.add('idle');
          events.push({ ...event, kind: 'idle', idleMs: now - previous.idleSince,
            reported: to !== null && mailSince(id, to, previous.workingSince ?? previous.idleSince) });
        } else if (effective === 'working' && status === 'working' && Number.isFinite(activeAt)
          && now - activeAt >= QUIET_MS && !previous.notified.has('quiet')) {
          previous.notified.add('quiet');
          events.push({ ...event, kind: 'quiet', quietMs: now - activeAt });
        }
        previous.workingSeen ||= effective === 'working';
        previous.status = effective;
      }
      return events;
    },
  };
}
