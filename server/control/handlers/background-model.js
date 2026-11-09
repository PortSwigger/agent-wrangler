import { writeConfig } from '../../config-store.js';
import { resolveHeadlessTarget } from '../../headless.js';

// Settings › Automation › Background model. Only a pair that can run headless
// is stored (an agent with a headless mode and a model it lists); anything else
// is ignored, so the row reads back the value still in force.
export const backgroundModelHandler = {
  type: 'set-background-model',
  async handler(msg, ctx) {
    if (typeof msg.agent !== 'string' || typeof msg.model !== 'string' || !msg.agent || !msg.model) return;
    let target;
    try { target = resolveHeadlessTarget({ agent: msg.agent, model: msg.model }); } catch { await ctx.rebuild(); return; }
    writeConfig({ backgroundModel: { agent: target.agent, model: target.model } });
    await ctx.rebuild();
  },
};
