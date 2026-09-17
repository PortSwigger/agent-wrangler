export function autoCompactPresetTokens(agent) {
  return agent === 'codex'
    ? [50000, 100000, 250000]
    : [100000, 250000, 500000, 1000000];
}
