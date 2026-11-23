import { readFileSync } from 'node:fs';
import { frontOf, curveOf, onFront } from '../../public/model-front.js';

export const data = JSON.parse(readFileSync(new URL('../../public/model-front-data.json', import.meta.url), 'utf8'));
const units = {
  quality: 'Terminal-Bench points, on the newest version (4.1, else 4.0) the board has run each model on, averaged with Arena agent-leaderboard scores rescaled to those points',
  usd: 'list-price dollars per task',
  minutes: 'wall-clock minutes per task',
};
export const point = ({ agent, model, effort, quality, usd, minutes }) => ({ agent, model, effort, quality, usd, minutes });

export function modelFront(agents, { agent, maxUsd, minQuality } = {}, { agents: selectedAgents, excludeModels } = {}) {
  for (const [name, values] of Object.entries({ agents: selectedAgents, excludeModels })) {
    if (values !== undefined && (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !v.trim()))) {
      throw new Error(`${name} must be an array of non-empty strings`);
    }
  }
  for (const id of selectedAgents || []) {
    if (!agents.some((a) => a.id === id)) {
      throw new Error(`Unknown or unavailable agent "${id}". Valid agents: ${agents.map((a) => a.id).join(', ') || '(none installed)'}.`);
    }
  }
  if (agent !== undefined && !agents.some((a) => a.id === agent)) {
    throw new Error(`Unknown or unavailable agent "${agent}". Valid agents: ${agents.map((a) => a.id).join(', ') || '(none installed)'}.`);
  }
  if (maxUsd !== undefined && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0)) {
    throw new Error('maxUsd must be a positive finite number');
  }
  if (minQuality !== undefined && (typeof minQuality !== 'number' || !Number.isFinite(minQuality) || minQuality < 0 || minQuality > 100)) {
    throw new Error('minQuality must be a number between 0 and 100');
  }
  const candidates = agents.filter((a) => selectedAgents === undefined || selectedAgents.includes(a.id))
    .map((a) => ({ ...a, models: (a.models || []).filter((m) => !excludeModels?.includes(m.value)) }));
  const front = frontOf(candidates, data);
  const curve = curveOf(front);
  return {
    read: data.read,
    credit: data.credit,
    units: { ...units },
    front: front.filter((p) => (agent === undefined || p.agent === agent)
      && (maxUsd === undefined || p.usd <= maxUsd)
      && (minQuality === undefined || p.quality >= minQuality))
      .map((p) => ({ ...point(p), onCurve: onFront(curve, p) })),
  };
}
