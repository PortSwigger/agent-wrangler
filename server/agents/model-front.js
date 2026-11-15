import { readFileSync } from 'node:fs';
import { frontOf, curveOf, onFront } from '../../public/model-front.js';

export const data = JSON.parse(readFileSync(new URL('../../public/model-front-data.json', import.meta.url), 'utf8'));
const units = {
  quality: 'Terminal-Bench 4.0 points',
  usd: 'list-price dollars per task',
  minutes: 'wall-clock minutes per task',
};
export const point = ({ agent, model, effort, quality, usd, minutes }) => ({ agent, model, effort, quality, usd, minutes });

export function modelFront(agents, { agent, maxUsd, minQuality } = {}) {
  if (agent !== undefined && !agents.some((a) => a.id === agent)) {
    throw new Error(`Unknown or unavailable agent "${agent}". Valid agents: ${agents.map((a) => a.id).join(', ') || '(none installed)'}.`);
  }
  if (maxUsd !== undefined && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0)) {
    throw new Error('maxUsd must be a positive finite number');
  }
  if (minQuality !== undefined && (typeof minQuality !== 'number' || !Number.isFinite(minQuality) || minQuality < 0 || minQuality > 100)) {
    throw new Error('minQuality must be a number between 0 and 100');
  }
  const front = frontOf(agents, data);
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
