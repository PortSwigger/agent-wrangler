import data from './model-front-data.json' with { type: 'json' };
import {
  scoreOf, dominates, frontOf, fullFrontOf, unavailableOf, curveOf,
  beatenBy, nearestOf, autoEffortOf, resolvedPick, programmesOf,
} from './model-front.js';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const frozenData = freeze(data);
export const MODEL_FRONT = Object.freeze({
  data: frozenData,
  scoreOf: (pick) => scoreOf(pick, frozenData),
  dominates,
  frontOf: (agents) => frontOf(agents, frozenData),
  fullFrontOf: () => fullFrontOf(frozenData),
  unavailableOf: (front) => unavailableOf(front, frozenData),
  curveOf,
  beatenBy: (front, pick) => beatenBy(front, pick, frozenData),
  nearestOf,
  autoEffortOf,
  resolvedPick,
  programmesOf: (agents, front, programmes) => programmesOf(agents, front, programmes, frozenData),
});
