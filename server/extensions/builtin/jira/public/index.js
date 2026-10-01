// Jira, client half: the chip a `jira` board link draws. The key shows on the
// chip and links to the issue; a key-only link (stored before a base URL was
// set) is resolved here against the current Jira base URL setting.
const JIRA_ICON =
  '<svg class="icon" viewBox="0 0 24 24" fill="#2684FF"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z"/></svg>';

export function hrefFor(link, baseUrl) {
  if (link.url) return link.url;
  const base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!base || !link.key) return '';
  return `${base.endsWith('/') ? base : `${base}/`}${link.key}`;
}

export function chip(link, _graph, api) {
  if (link?.type !== 'jira') return null;
  return {
    label: link.key || link.url || 'link',
    href: hrefFor(link, api?.settings?.().baseUrl),
    icon: JIRA_ICON,
  };
}

export default {
  register(slots) {
    slots.register('link.chip', { id: 'jira', chip });
  },
};
