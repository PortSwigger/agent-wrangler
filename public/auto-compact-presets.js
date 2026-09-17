export function autoCompactPresetTokens(agent) {
  return agent === 'codex'
    ? [50000, 100000, 250000]
    : [100000, 250000, 500000, 1000000];
}

export function normalizeAutoCompactPreset(tokens, agent) {
  return autoCompactPresetTokens(agent).includes(tokens) ? tokens : undefined;
}
