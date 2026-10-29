import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { knownAgentIds } from '../../agents/index.js';
import { frontOf, curveOf, onFront, resolvedPick, scoreOf, beatenBy } from '../../../public/model-front.js';

const data = JSON.parse(readFileSync(new URL('../../../public/model-front-data.json', import.meta.url), 'utf8'));
const units = {
  quality: 'Terminal-Bench 4.0 points',
  usd: 'list-price dollars per task',
  minutes: 'wall-clock minutes per task',
};
const point = ({ agent, model, effort, quality, usd, minutes }) => ({ agent, model, effort, quality, usd, minutes });
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

export const getModelFrontTool = {
  name: 'get_model_front',
  description:
    'Which agent/model/effort settings give the most quality for their cost and time, from the same '
    + 'benchmark data as the dispatch dialog\'s model picker. Use it when choosing a model for '
    + 'spawn_session, a handoff, an advisor or a reviewer. `front` lists every setting nothing beats on '
    + 'quality, cost and time together, cheapest first. `onCurve: false` marks a setting that is on the '
    + 'front only for being faster. Pass `pick` to check one setting against the whole installed-agent '
    + 'front, regardless of filters: whether it is on the front, and the best setting that beats it. '
    + 'An unscored pick has no numbers or verdict. Numbers measure doing a coding task '
    + '(Terminal-Bench 4.0), not reviewing one. Only settings this board can launch. Read-only.',
  inputSchema: {
    agent: z.string().optional().describe(`Only this agent's front settings (${knownAgentIds().join(', ')}); does not restrict pick judgement.`),
    maxUsd: z.number().positive().optional().describe('Leave out front settings costing more than this per task.'),
    minQuality: z.number().min(0).max(100).optional().describe('Leave out front settings scoring below this.'),
    pick: z.object({ agent: z.string(), model: z.string(), effort: z.string().optional() }).optional()
      .describe('A setting to judge. Omit effort (or pass "") for Auto, scored as the effort the agent will use.'),
  },
  async handler({ deps }, args = {}) {
    const agents = await deps.agents();
    for (const id of [args.agent, args.pick?.agent]) {
      if (id !== undefined && !agents.some((a) => a.id === id)) {
        return errorResult(`Unknown or unavailable agent "${id}". Valid agents: ${agents.map((a) => a.id).join(', ') || '(none installed)'}.`);
      }
    }
    if (args.pick) {
      const agent = agents.find((a) => a.id === args.pick.agent);
      if (!agent.models.some((m) => m.value === args.pick.model)) {
        return errorResult(`Unknown model "${args.pick.model}" for agent "${agent.id}". Valid models: ${agent.models.map((m) => m.value).join(', ')}.`);
      }
    }

    const front = frontOf(agents, data);
    const curve = curveOf(front);
    const structuredContent = {
      read: data.read,
      credit: data.credit,
      units,
      front: front.filter((p) => (args.agent === undefined || p.agent === args.agent)
        && (args.maxUsd === undefined || p.usd <= args.maxUsd)
        && (args.minQuality === undefined || p.quality >= args.minQuality))
        .map((p) => ({ ...point(p), onCurve: onFront(curve, p) })),
    };
    if (args.pick) {
      const resolved = resolvedPick(agents, args.pick);
      const measured = data.models[resolved.agent]?.[resolved.model];
      const score = Object.hasOwn(measured || {}, resolved.effort || '') ? scoreOf(resolved, data) : null;
      structuredContent.pick = { ...args.pick, resolvedEffort: resolved.effort || '', scored: !!score };
      if (score) {
        const beaten = beatenBy(front, resolved, data);
        Object.assign(structuredContent.pick, {
          quality: score.quality, usd: score.usd, minutes: score.minutes,
          onFront: onFront(front, resolved), beatenBy: beaten ? point(beaten) : null,
        });
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};
