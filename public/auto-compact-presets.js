export function autoCompactPresetTokens(agent) {
  return agent === 'codex'
    ? [50000, 100000, 250000]
    : [100000, 250000, 500000, 1000000];
}

export function normalizeAutoCompactPreset(tokens, agent) {
  return autoCompactPresetTokens(agent).includes(tokens) ? tokens : undefined;
}

export function normalizeAutoCompactPresetForAgentChange(tokens, previousAgent, nextAgent) {
  return previousAgent === nextAgent ? tokens : normalizeAutoCompactPreset(tokens, nextAgent);
}

// Compact label for a token count ("250k", "1m") — not limited to the presets
// above, since spawn_session/schedule_session accept any integer in range.
export function formatAutoCompactTokens(tokens) {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return tokens.toLocaleString('en-US');
}
