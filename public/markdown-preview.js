// Read-only markdown → HTML renderer for the task-memory preview pane. DOM-free
// and `window`-free on purpose: it takes the markdown-it factory as an argument
// (the browser passes `window.markdownit`, the test passes the vendored UMD via a
// CommonJS eval) so it unit-tests exactly like util.js with no jsdom.
//
// markdown-it is the safe-by-default choice: `html:false` escapes raw HTML inline
// rather than passing it through, and its built-in validateLink blocks
// javascript:/vbscript:/data: hrefs — so the rendered innerHTML needs no separate
// sanitizer pass before it goes into the preview div.
export function createRenderer(markdownit) {
  const md = markdownit({ html: false, linkify: true, typographer: false, breaks: false });

  // External http(s) links open in a new tab; rel guards the opener from
  // tabnabbing. Relative / in-repo links (e.g. `src/token.js`) and any other
  // scheme are left to the default rule untouched — they stay same-tab and
  // markdown-it has already dropped unsafe schemes by this point.
  const defaultLinkOpen = md.renderer.rules.link_open
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return (src) => md.render(src || '');
}
