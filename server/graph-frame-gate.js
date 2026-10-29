// Drops a graph broadcast that would tell every board nothing new. On an idle
// server consecutive rebuilds differ only in `generatedAt` (Date.now() at build),
// yet each one re-sent the whole multi-MB snapshot to every client every 2–4s, and
// each client re-parsed and re-rendered it.
//
// Runs AFTER history-gate on its wire graph, and keys on everything but `history`
// and `generatedAt`: history-gate already leaves history off an unchanged tick, so
// its presence alone means "changed". Keying on the wire graph's whole body instead
// would count the history-carrying frame and the history-less one after it as a
// change, sending one extra frame after every archive.
//
// Safe for the same reason history-gate is: a control socket either receives every
// broadcast in order or is terminated (sendGuarded), and a new connection is served
// `lastGraph` directly by the connect path, never through this gate. Nothing reads
// `generatedAt` off the wire, but it is still sent on every frame that goes out.
//
// Returns the serialised `{type:'graph', graph}` message, or null to send nothing.
// The body is spliced rather than stringified twice: it is the multi-MB part, and
// it has to be serialised for the compare anyway.
export function createGraphFrameGate() {
  let lastBody = null;
  return function graphFrame(wire) {
    const { history, generatedAt, ...rest } = wire;
    const body = JSON.stringify(rest);
    const carriesHistory = 'history' in wire;
    if (!carriesHistory && body === lastBody) return null;
    lastBody = body;
    const tail = JSON.stringify(carriesHistory ? { history, generatedAt } : { generatedAt });
    return `{"type":"graph","graph":${joinObjects(body, tail)}}`;
  };
}

// Two serialised objects as one, `a`'s keys first. Either may be `{}` (an
// undefined value drops its key under JSON.stringify).
function joinObjects(a, b) {
  if (a === '{}') return b;
  if (b === '{}') return a;
  return `${a.slice(0, -1)},${b.slice(1)}`;
}
