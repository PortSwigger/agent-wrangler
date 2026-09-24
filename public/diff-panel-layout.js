export function diffPanelSizing({ gridInlineWidth, fullscreen }) {
  if (fullscreen) return { width: '', sized: false };
  const width = gridInlineWidth || '';
  return { width, sized: Boolean(width) };
}

export function nextDiffPanelState({ storedWidth, nextWidth, fullscreen }) {
  const width = nextWidth ?? storedWidth;
  return { storedWidth: width, ...diffPanelSizing({ gridInlineWidth: width, fullscreen }) };
}
