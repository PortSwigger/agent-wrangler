import { effortsOf } from './model-front.js';

const KEY = 'aw-dispatch-pick';

export function readDispatchPick(storage) {
  try { return JSON.parse(storage?.getItem(KEY) || 'null'); } catch { return null; }
}

export function saveDispatchPick(storage, pick) {
  try { storage?.setItem(KEY, JSON.stringify(pick)); } catch {}
}

export function dispatchPick(agents, saved, explicit) {
  const wanted = explicit ?? saved;
  let agent = agents.find((a) => (!wanted?.agent || a.id === wanted.agent) && a.models.some((m) => m.value === wanted?.model));
  let model = agent?.models.find((m) => m.value === wanted.model);
  const matched = Boolean(model);
  if (!model) {
    agent = agents.find((a) => a.id === explicit?.agent && a.models.length)
      || [...agents].filter((a) => a.models.length).sort((a, b) => (a.reviewPriority ?? Infinity) - (b.reviewPriority ?? Infinity) || a.id.localeCompare(b.id))[0] || agents.find((a) => a.models.length);
    model = agent?.models.find((m) => m.default) || agent?.models[0];
  }
  if (!model) return null;
  const keepEffort = matched || (explicit?.agent === agent.id && !explicit.model);
  const effort = keepEffort && effortsOf(agent, model).some((e) => e.value === wanted.effort) ? wanted.effort : '';
  return { agent: agent.id, model: model.value, effort };
}
