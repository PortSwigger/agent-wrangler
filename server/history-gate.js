// Keeps `graph.history` off the wire on the ~1800 broadcasts an hour that don't
// change it. Archived entries are frozen — measured on the live board, ~15 archive
// events a day against a 2s broadcast cadence — so re-serialising the whole list
// every tick was 85% of a 2.2MB snapshot per client (see CLAUDE.md's sendGuarded
// bullet, which this closes the amplifier half of).
//
// Absence, not null or [], is the "unchanged" signal: the last archive being purged
// empties the list, and the client has to be able to tell that from a no-op tick.
//
// Safe because a control socket either delivers every broadcast in order or is torn
// down — sendGuarded TERMINATES a non-reading peer rather than skipping a message —
// and a reconnect is served the full lastGraph by the connect path. So there is no
// "client silently missed the one broadcast that carried history" case to recover
// from; a client that is still connected has every history it was ever sent.
//
// The compare is over the serialised list rather than a cheaper counter/mtime
// because the whole point is correctness under fields that mutate in place (a
// rename, a label recomputation): anything narrower has to be kept in step with
// state-reader's record by hand, and the JSON is needed to send it anyway.
export function createHistoryGate() {
  let lastJson = null;
  return function wireGraph(graph) {
    const json = JSON.stringify(graph.history ?? null);
    if (json === lastJson) {
      // Copy, never delete: `lastGraph` is assigned before the broadcast and is
      // what the connect path and every handler's ctx.graph() read.
      const { history, ...wire } = graph;
      return wire;
    }
    lastJson = json;
    return graph;
  };
}
