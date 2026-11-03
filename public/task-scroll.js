export function watchTaskScrollEdges(grid) {
  const bodies = [...grid.querySelectorAll('.task-body')];
  const update = (body) => {
    const cell = body.closest('.task-cell');
    const scrollable = getComputedStyle(body).overflowY === 'auto';
    cell.classList.toggle('task-more-below', scrollable && body.scrollHeight - body.clientHeight - body.scrollTop > 1);
    cell.style.setProperty('--task-scrollbar-width', `${body.offsetWidth - body.clientWidth}px`);
    cell.style.setProperty('--task-edge-height', `${Math.min(28, body.clientHeight)}px`);
  };
  const updateAll = () => bodies.forEach(update);
  const resize = new ResizeObserver(updateAll);
  const observeSizes = () => {
    resize.disconnect();
    for (const body of bodies) {
      resize.observe(body);
      for (const child of body.children) resize.observe(child);
    }
    updateAll();
  };
  const mutations = new MutationObserver(observeSizes);
  const onScroll = (event) => update(event.currentTarget);
  for (const body of bodies) {
    body.addEventListener('scroll', onScroll, { passive: true });
    mutations.observe(body, { childList: true, subtree: true, characterData: true });
  }
  observeSizes();
  return () => {
    resize.disconnect();
    mutations.disconnect();
    for (const body of bodies) body.removeEventListener('scroll', onScroll);
  };
}
