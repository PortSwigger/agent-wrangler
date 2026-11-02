export function createSoundMigration(storage) {
  let attempted = false;
  return (send) => {
    if (attempted) return;
    let raw;
    try { raw = (storage ?? globalThis.localStorage)?.getItem('cm-setting-soundOnFinish'); }
    catch { attempted = true; return; }
    if (raw == null) { attempted = true; return; }
    attempted = send({ type: 'extension-enabled', id: 'sounds', enabled: raw === '1', onlyIfUnset: true }) !== false;
  };
}
