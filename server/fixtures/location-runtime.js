import { SessionManager } from '../session-manager.js';
import { registerRuntime, unregisterRuntimesFor } from '../runtimes/index.js';
import { setPickedRuntimesForTest } from '../runtimes/offer.js';

export const WORK = '/srv/location-only/work';

const TRANSCRIPT = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the widget' }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-15T10:00:00.000Z', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500 }, content: [{ type: 'text', text: 'done' }] } }),
].join('\n');

export function testLocationRuntime(calls = [], over = {}) {
  let n = 0;
  return {
    id: 'testloc',
    label: 'Test location',
    agents: ['claude', 'codex'],
    wrapLaunch: async (args) => { calls.push(['wrap', args]); return `run-at-location ${JSON.stringify(args.location)}`; },
    location: {
      provision: async (args) => { calls.push(['provision', args]); n += 1; return { box: `box-${n}` }; },
      open: async ({ ref, phase }) => { calls.push(['open', ref, phase]); return { cwd: `${WORK}/${ref.box}` }; },
      suspend: async ({ ref }) => { calls.push(['suspend', ref]); },
      resume: async ({ ref }) => { calls.push(['resume', ref]); },
      delete: async ({ ref }) => { calls.push(['delete', ref]); },
      unpushed: async ({ ref }) => { calls.push(['unpushed', ref]); return []; },
      transcript: async () => TRANSCRIPT,
      codexId: async () => null,
      ...over,
    },
  };
}

// A deck offering only `rt` unless `picked` says otherwise (null: every runtime).
export async function withRuntime(rt, fn, { picked = [rt.id] } = {}) {
  registerRuntime(rt, 'testext');
  setPickedRuntimesForTest(() => picked);
  try { return await fn(); } finally {
    setPickedRuntimesForTest(null);
    unregisterRuntimesFor('testext');
  }
}

export function manager() {
  const sm = new SessionManager();
  sm.map.clear();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => [];
  sm._trustLaunchCwd = async () => { throw new Error('host trust must not run for a location card'); };
  return sm;
}

