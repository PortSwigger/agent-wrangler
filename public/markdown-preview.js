// Read-only markdown → HTML renderer, shared by the task-memory preview pane and
// the chat view's assistant prose. DOM-free and `window`-free on purpose: it takes
// the markdown-it factory as an argument (the browser passes `window.markdownit`,
// the test passes the vendored UMD via a CommonJS eval) so it unit-tests exactly
// like util.js with no jsdom.
//
// markdown-it is the safe-by-default choice: `html:false` escapes raw HTML inline
// rather than passing it through, and its built-in validateLink blocks
// javascript:/vbscript:/data: hrefs — so the rendered innerHTML needs no separate
// sanitizer pass before it goes into the preview div.
import { linkedHtml, MD_LINK_CLASS } from './text-links.js';
import { resolveTerminalPath } from './term-links.js';

// A link destination that names a local markdown file, e.g. `[plan](docs/plan.md)`.
// Any fragment is dropped — the preview modal renders a whole file and has nothing
// to scroll to — and a destination with a scheme or a protocol-relative prefix is
// left to the normal link rules.
function localMarkdownHref(href, baseDir) {
  const raw = String(href || '').split('#')[0];
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the raw form */ }
  if (!/\.(?:md|markdown)$/i.test(decoded)) return null;
  return resolveTerminalPath(decoded, baseDir);
}

// Renderer rules run over a flat token array, so "am I inside a link?" is answered
// by counting the unclosed link_open tokens before this one. Without it, a path in
// a link's own label would nest a <button> inside an <a> — invalid, and the inner
// control would swallow the click meant for the outer link.
function insideLink(tokens, idx) {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    if (tokens[i].type === 'link_open') depth++;
    else if (tokens[i].type === 'link_close') depth--;
  }
  return depth > 0;
}

// `mdPathBase` is a getter for the session's cwd (a function, so the chat view can
// hand over one renderer that follows whichever session is on screen). Omit it and
// nothing changes: the memory preview pane renders exactly as it always has, with
// no path linkification and no preview buttons.
export function createRenderer(markdownit, { mdPathBase = null } = {}) {
  const md = markdownit({ html: false, linkify: true, typographer: false, breaks: false });
  const esc = md.utils.escapeHtml;
  const baseOf = () => (typeof mdPathBase === 'function' ? mdPathBase() : mdPathBase) || null;

  // External http(s) links open in a new tab; rel guards the opener from
  // tabnabbing. A link to a local .md file becomes a preview control instead (see
  // localMarkdownHref). Relative / in-repo links to anything else (e.g.
  // `src/token.js`) and any other scheme are left to the default rule untouched —
  // they stay same-tab and markdown-it has already dropped unsafe schemes by this
  // point.
  const defaultLinkOpen = md.renderer.rules.link_open
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
      return defaultLinkOpen(tokens, idx, options, env, self);
    }
    const mdPath = mdPathBase ? localMarkdownHref(href, baseOf()) : null;
    if (mdPath) {
      // The element stays an <a> and only its attributes change, so the matching
      // link_close needs no touching. Dropping the href is what stops it
      // navigating the board away; role/tabindex are what keep it a real control
      // without one. Same shape as text-links.js's linkedHtml, deliberately.
      token.attrs = [];
      token.attrSet('class', MD_LINK_CLASS);
      token.attrSet('role', 'button');
      token.attrSet('tabindex', '0');
      token.attrSet('data-md-path', mdPath);
      // Same as a bare path's control: the label is prose, so the destination
      // has to be reachable on hover.
      token.attrSet('title', mdPath);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  // Bare paths in prose and in inline code. Inline code is the common case, not an
  // afterthought — an agent writes `docs/plan.md` in backticks far more often than
  // as a markdown link — and it is what the terminal view already linkifies.
  //
  // Fenced blocks (`fence`/`code_block`) are deliberately NOT linkified: they are
  // content to copy verbatim, and the chat view renders them as their own block
  // where an inline control fights both the styling and a drag-select.
  //
  // URLs are left alone here: markdown-it's own linkify has already turned bare
  // http(s) URLs in prose into anchors, and a second pass would nest a link.
  if (mdPathBase) {
    md.renderer.rules.text = (tokens, idx) => (
      insideLink(tokens, idx)
        ? esc(tokens[idx].content)
        : linkedHtml(tokens[idx].content, { baseDir: baseOf(), urls: false, escapeHtml: esc })
    );
    md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const body = insideLink(tokens, idx)
        ? esc(token.content)
        : linkedHtml(token.content, { baseDir: baseOf(), urls: false, escapeHtml: esc });
      return `<code${self.renderAttrs(token)}>${body}</code>`;
    };
  }

  return (src) => md.render(src || '');
}
