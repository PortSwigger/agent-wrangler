// Node construction for the chat view. The rule this module exists to enforce:
// chat content is agent- and repo-generated, so paths, tool targets, tool output
// and command text go in via textContent/dataset and NEVER innerHTML — the same
// rule diff-dom.js states for the same class of content.
//
// The single exception is assistant markdown, which goes through the renderer
// injected as `renderMarkdown` (markdown-preview.js's createRenderer in the
// browser). That renderer is already safe by default — html:false escapes raw
// HTML rather than passing it through, and validateLink drops javascript:/
// vbscript:/data: — so its output needs no separate sanitiser pass. It is
// injected rather than imported so this module tests with no window and no jsdom.
//
// Every affordance glyph (disclosure caret, sub-agent arrow, notice mark) is a
// CSS ::before/::after, never a text node: they are decoration, so keeping them
// out of the DOM keeps them out of the accessibility tree and out of a copied
// selection — and means this module never grows a glyph table.
//
// The user bubble is the second exception to "textContent only", and a narrow
// one: it is still built node by node, never from a markup string — the linkifier
// hands back plain segments and every one of them becomes a text node or a
// control whose label is set with textContent. So the rule above is unchanged in
// substance; a URL or a .md path in the human's own words just becomes clickable.

import { linkSegments, MD_LINK_CLASS } from './text-links.js';

export function activityTitle(item) {
  if (!item.adds && !item.dels) return item.label;
  return `${item.label} +${item.adds} −${item.dels}`;
}

const AGO = (ms) => `${Math.round(ms / 1000)}s`;

// `baseDir` is the session's cwd — a getter, because one chat-dom instance serves
// every session the view opens. It resolves a relative .md path the same way the
// terminal's link provider does; with none, a relative path stays plain text.
export function createChatDom({ document: doc = globalThis.document, renderMarkdown, baseDir = null } = {}) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const baseOf = () => (typeof baseDir === 'function' ? baseDir() : baseDir) || null;

  // Fill `parent` with the human's text, promoting URLs and local markdown paths
  // to controls. The overwhelmingly common case is one segment, i.e. exactly the
  // single text node this used to be. A .md path gets no href — nothing about it
  // is a URL — and chat-view.js opens the preview modal from one delegated
  // [data-md-path] handler; role/tabindex are what make a href-less anchor a
  // real, focusable control. See text-links.js's linkedHtml for why it is an
  // anchor rather than a <button>: the two builders must emit the same thing.
  const fillLinked = (parent, text) => {
    for (const seg of linkSegments(text, { baseDir: baseOf() })) {
      if (seg.kind === 'url') {
        const a = el('a', 'chat-link', seg.text);
        a.setAttribute('href', seg.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        parent.appendChild(a);
      } else if (seg.kind === 'file') {
        const a = el('a', MD_LINK_CLASS, seg.text);
        a.setAttribute('role', 'button');
        a.setAttribute('tabindex', '0');
        a.setAttribute('title', seg.path);
        a.dataset.mdPath = seg.path;
        parent.appendChild(a);
      } else if (seg.text) {
        parent.appendChild(doc.createTextNode(seg.text));
      }
    }
    return parent;
  };

  // Shared by the activity and thinking chips: both are the same control (a
  // disclosure button that reveals a sibling body), so they get the same
  // markup contract — chat-view.js wires one click handler shape for both.
  const chipButton = (className, labelClass, labelText, title) => {
    const chip = el('button', className);
    chip.setAttribute('type', 'button');
    chip.setAttribute('aria-expanded', 'false');
    if (title) chip.setAttribute('title', title);
    chip.appendChild(el('span', labelClass, labelText));
    return chip;
  };

  function toolRow(t) {
    const row = el('div', 'chat-tool-row');
    // The name and target live on their own flex line rather than as bare
    // adjacent spans: without a container they rendered as one run-together
    // word ("Grepredirect"), since neither carries whitespace of its own.
    const head = el('div', 'chat-tool-head');
    head.appendChild(el('span', 'chat-tool-name', t.name));
    if (t.target) {
      const target = el('span', 'chat-tool-target', t.target);
      // Truncated to one line in CSS, so the untruncated value has to stay
      // reachable somewhere — a path or command is often only distinguishable
      // by its tail.
      target.setAttribute('title', t.target);
      head.appendChild(target);
    }
    row.appendChild(head);
    if (t.output) {
      const pre = el('pre', 'chat-tool-output', t.output);
      if (t.truncated) pre.dataset.truncated = '1';
      row.appendChild(pre);
    }
    if (t.ok === false) row.dataset.failed = '1';
    return row;
  }

  function activityNode(item) {
    const wrap = el('div', 'chat-activity');
    const chip = chipButton('chat-activity-chip', 'chat-activity-label', item.label, activityTitle(item));
    // The counts are their own coloured spans rather than part of the label
    // text so + and − can carry the green/red they mean everywhere else in the
    // app; activityTitle keeps the flat form for the tooltip.
    if (item.adds || item.dels) {
      const stat = el('span', 'chat-diffstat');
      stat.appendChild(el('span', 'chat-adds', `+${item.adds}`));
      stat.appendChild(el('span', 'chat-dels', `−${item.dels}`));
      chip.appendChild(stat);
    }
    wrap.appendChild(chip);
    const body = el('div', 'chat-activity-body');
    body.dataset.collapsed = '1';
    for (const t of item.tools) body.appendChild(toolRow(t));
    wrap.appendChild(body);
    return wrap;
  }

  function itemNode(item) {
    if (item.type === 'activity') return activityNode(item);
    const e = item.event;
    if (item.type === 'user') {
      // The plain single-text-node bubble stays the shape for the overwhelmingly
      // common case, and only a message that actually carries an attachment pays
      // for the wrapper. `pre-wrap` on .chat-user is what keeps the human's own
      // line breaks, so the text stays text nodes either way rather than becoming
      // markdown — this is their words verbatim, not prose to render. fillLinked
      // adds nothing to that: it only lifts a URL or a .md path out into its own
      // control, leaving every other character exactly where it was.
      if (!Array.isArray(e.images) || !e.images.length) return fillLinked(el('div', 'chat-user'), e.text);
      const wrap = el('div', 'chat-user');
      if (e.text) wrap.appendChild(fillLinked(el('div', 'chat-user-text'), e.text));
      const row = el('div', 'chat-user-images');
      for (const img of e.images) {
        // A chip, not a thumbnail: GET /file is markdown-only by design and
        // widening it to serve arbitrary image paths would open a read surface
        // for one decoration. The chip is also exactly what the pane shows for
        // an attached image, so the two views agree.
        const chip = el('span', 'chat-user-image', img.label || 'Image');
        // The filename is the only part a reader might want, and it is often the
        // only thing telling two pastes apart.
        if (img.name) chip.setAttribute('title', img.name);
        row.appendChild(chip);
      }
      wrap.appendChild(row);
      return wrap;
    }
    if (item.type === 'assistant') {
      const wrap = el('div', 'chat-assistant');
      const prose = el('div', 'chat-prose');
      prose.innerHTML = renderMarkdown(e.text); // the one sanctioned innerHTML
      wrap.appendChild(prose);
      // Only when there is something to put in it: an empty foot still drew its
      // own gap under every prose block, which read as a stray blank line.
      if (e.model) {
        const foot = el('div', 'chat-turn-foot');
        foot.appendChild(el('span', 'chat-model', e.model));
        wrap.appendChild(foot);
      }
      return wrap;
    }
    if (item.type === 'thinking') {
      const wrap = el('div', 'chat-thinking');
      const label = e.durationMs ? `Thought for ${AGO(e.durationMs)}` : 'Thinking';
      // A chip only when there is a body to reveal. Claude's thinking is usually
      // blank and Codex's is presence-only (encrypted_content, summary: []), so
      // the textless case is the common one and must not offer a control that
      // opens nothing.
      if (e.text) {
        wrap.appendChild(chipButton('chat-thinking-chip', 'chat-thinking-label', label));
        const body = el('div', 'chat-thinking-body', e.text);
        body.dataset.collapsed = '1';
        wrap.appendChild(body);
      } else {
        wrap.appendChild(el('span', 'chat-thinking-label', label));
      }
      return wrap;
    }
    if (item.type === 'recap') {
      const wrap = el('div', 'chat-recap');
      wrap.appendChild(el('div', 'chat-recap-label', 'Recap'));
      if (e.text) wrap.appendChild(el('div', 'chat-recap-text', e.text));
      // The next step is a BUTTON, not more prose: it is the one piece of a
      // recap the reader might want to act on, and the chat view can act on it
      // (chat-view.js loads it into the composer rather than sending it, so it
      // stays a suggestion the human edits or discards).
      if (e.next) {
        const go = el('button', 'chat-recap-next');
        go.setAttribute('type', 'button');
        go.setAttribute('title', 'Put this in the composer');
        go.appendChild(el('span', 'chat-recap-next-text', e.next));
        wrap.appendChild(go);
      }
      return wrap;
    }
    if (item.type === 'subagent') {
      const wrap = el('div', 'chat-subagent');
      wrap.dataset.subagentId = e.id;
      wrap.appendChild(el('span', 'chat-subagent-name', e.name));
      return wrap;
    }
    const wrap = el('div', 'chat-notice');
    wrap.dataset.noticeKind = e.noticeKind || 'info';
    wrap.appendChild(el('span', 'chat-notice-text', `${e.noticeKind === 'denied' ? 'Denied' : 'Resolved'}: ${e.text}`));
    return wrap;
  }

  // The live "something is happening" row. Built here with the rest of the node
  // construction, but owned by chat-view.js: it is the only node in the stream
  // that is not an event, so it is created once per mount, kept as the last
  // child, and removed when the session stops working.
  function liveRow() {
    const wrap = el('div', 'chat-live');
    wrap.appendChild(el('span', 'chat-live-label', 'Working'));
    wrap.appendChild(el('span', 'chat-live-elapsed', ''));
    return wrap;
  }

  return { itemNode, liveRow };
}
