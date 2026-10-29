const modelsOf = (a) => a?.models || [];
export const effortsOf = (a, m) => (m?.efforts?.length ? (a?.efforts || []).filter((e) => m.efforts.includes(e.value)) : a?.efforts || []);

const rows = (data) => Object.values(data.models).flatMap((m) => Object.values(m).flatMap((e) => Object.values(e)));
const spans = new WeakMap();
function spanOf(data) {
  if (!spans.has(data)) {
    const all = rows(data), lc = all.map((v) => Math.log(v[1])), t = all.map((v) => v[2]);
    spans.set(data, { c0: Math.min(...lc), c1: Math.max(...lc), t0: Math.min(...t), t1: Math.max(...t) });
  }
  return spans.get(data);
}
const at = (v, lo, hi) => (hi > lo ? (v - lo) / (hi - lo) * 100 : 0);
export const costAt = (usd, data) => { const s = spanOf(data); return at(Math.log(usd), s.c0, s.c1); };

export function scoreOf(pick, data) {
  const v = pick?.effort && data.models[pick?.agent]?.[pick?.model]?.[pick.effort];
  if (!v) return null;
  const s = spanOf(data);
  return { quality: v[0], usd: v[1], minutes: v[2], cost: costAt(v[1], data), time: at(v[2], s.t0, s.t1) };
}

export function measuredPoints(agents, data) {
  return agents.flatMap((a) => modelsOf(a).flatMap((m) => effortsOf(a, m).map((e) => {
    const s = scoreOf({ agent: a.id, model: m.value, effort: e.value }, data);
    return s && { agent: a.id, model: m.value, effort: e.value, ...s };
  }).filter(Boolean)));
}

export const dominates = (y, x) => y.quality >= x.quality && y.usd <= x.usd && y.minutes <= x.minutes && (y.quality > x.quality || y.usd < x.usd || y.minutes < x.minutes);

export function frontOf(agents, data) {
  const all = measuredPoints(agents, data);
  return all.filter((x) => !all.some((y) => dominates(y, x))).sort((a, b) => a.usd - b.usd || b.quality - a.quality);
}

export function curveOf(front) {
  return front.filter((x) => !front.some((y) => y.quality >= x.quality && y.usd <= x.usd && (y.quality > x.quality || y.usd < x.usd)))
    .sort((a, b) => a.usd - b.usd || b.quality - a.quality);
}

export function fullFrontOf(data) {
  return frontOf(Object.entries(data.models).map(([id, ms]) => ({ id, models: Object.keys(ms).map((value) => ({ value, efforts: Object.keys(ms[value]) })), efforts: [...new Set(Object.values(ms).flatMap(Object.keys))].map((value) => ({ value })) })), data);
}
export const unavailableOf = (front, data) => fullFrontOf(data).filter((p) => !onFront(front, p));

export const nearestOf = (front, p) => front.reduce((best, x) => (!best || Math.hypot(x.cost - p.cost, x.quality - p.quality) < Math.hypot(best.cost - p.cost, best.quality - p.quality) ? x : best), null);

export const autoEffortOf = (agents, p) => (p && !p.effort && modelsOf(agents.find((a) => a.id === p.agent)).find((m) => m.value === p.model)?.autoEffort) || '';
export const resolvedPick = (agents, p) => { const e = autoEffortOf(agents, p); return e ? { ...p, effort: e } : p; };

export const samePick =(a, b) => !!a && !!b && a.agent === b.agent && a.model === b.model && (a.effort || '') === (b.effort || '');
export const onFront = (front, pick) => front.some((p) => samePick(p, pick));

export function beatenBy(front, pick, data) {
  const s = scoreOf(pick, data);
  return (s && front.filter((p) => dominates(p, s)).sort((a, b) => b.quality - a.quality || a.usd - b.usd)[0]) || null;
}

export function programmesOf(agents, front, programmes, data) {
  const installed = ['claude', 'codex'].filter((id) => agents.some((a) => a.id === id));
  const set = installed.length === 2 ? 'both' : installed[0], names = (programmes[set] || []).map(([n]) => n);
  const picks = (name) => [set, ...installed].map((s) => (programmes[s] || []).find(([n]) => n === name)?.[1]).filter(Boolean);
  const rank = (p) => (agents.find((a) => a.id === p.agent)?.efforts || []).findIndex((e) => e.value === p.effort);
  const costs = names.map((n) => {
    const ps = picks(n), aim = scoreOf(ps[0], data)?.quality ?? 0;
    return (x) => {
      const k = ps.findIndex((p) => samePick(p, x)), kin = ps.filter((p) => p.agent === x.agent && p.model === x.model);
      if (k >= 0) return Math.min(k, 1) * 1000;
      if (kin.length) return 2000 + Math.min(...kin.map((p) => Math.abs(rank(x) - rank(p)) * 2 + (rank(x) > rank(p))));
      return 3000 + Math.abs(x.quality - aim);
    };
  });
  const pts = [...front].sort((a, b) => a.quality - b.quality), memo = new Map();
  const best = (i, j) => {
    if (i === names.length) return { score: 0, at: [] };
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    const skip = best(i + 1, j);
    let out = { score: skip.score, at: [null, ...skip.at] };
    for (let k = j; k < pts.length; k++) {
      const next = pts.findIndex((p, m) => m > k && p.quality > pts[k].quality), rest = best(i + 1, next < 0 ? pts.length : next);
      const score = rest.score + 1e5 - costs[i](pts[k]);
      if (score > out.score) out = { score, at: [pts[k], ...rest.at] };
    }
    memo.set(key, out);
    return out;
  };
  return best(0, 0).at.map((p, i) => p && { name: names[i], ...p }).filter(Boolean);
}
