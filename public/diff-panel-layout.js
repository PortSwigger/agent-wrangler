export function diffPanelSizing({ gridInlineWidth, gridRenderedWidth, fullscreen }) {
  if (fullscreen) return { width: '', sized: false };
  const width = gridInlineWidth || `${gridRenderedWidth}px`;
  return { width, sized: Boolean(width) };
}

export function nextDiffPanelState({ storedWidth, nextWidth, fullscreen }) {
  const width = nextWidth ?? storedWidth;
  return { storedWidth: width, ...diffPanelSizing({ gridInlineWidth: width, gridRenderedWidth: 0, fullscreen }) };
}
