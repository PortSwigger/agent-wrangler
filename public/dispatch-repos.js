// Whether the runtime `runtimeId` (contributed by `extId`) runs its sessions at
// an execution location of its own, per the graph's extension runtime summaries.
export function runtimeHasLocation(extensions, extId, runtimeId) {
  if (!extId) return false;
  const e = (extensions || []).find((x) => x.id === extId);
  return Boolean(e?.runtimes?.find((r) => r?.id === runtimeId)?.location);
}
