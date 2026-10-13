export function snapshotTaskRects(grid, adhocId) {
  return [...grid.querySelectorAll('.task-cell')].map((cell) => {
    const rect = cell.getBoundingClientRect();
    return {
      id: cell.dataset.entity === 'no-task' ? adhocId : cell.dataset.taskid,
      rect: {
        left: rect.left + grid.scrollLeft, right: rect.right + grid.scrollLeft,
        top: rect.top + grid.scrollTop, bottom: rect.bottom + grid.scrollTop,
        height: rect.height,
      },
    };
  });
}

export function taskAtPoint(rects, x, y, grid) {
  x += grid.scrollLeft;
  y += grid.scrollTop;
  for (const { id, rect } of rects) {
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return id;
  }
  return null;
}
