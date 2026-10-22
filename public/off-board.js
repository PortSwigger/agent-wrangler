// A card an extension spawned with `sessions.spawn({ offBoard: true })` carries
// that extension's id as `offBoard`, and lives in the extension's own view. It
// stays in the graph (so lookups by id, the panel and the extension all find it),
// but every path that draws or walks the board's grid goes through here.
export function onBoard(sessions) {
  return sessions.filter((s) => !s.offBoard);
}
