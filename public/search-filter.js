export function closeTaskFilterOnOutsideClick(filter, target) {
  if (filter?.open && !filter.contains(target)) filter.open = false;
}
