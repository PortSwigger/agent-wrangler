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

export function activityTitle(item) {
  if (!item.adds && !item.dels) return item.label;
  return `${item.label} +${item.adds} −${item.dels}`;
}

const AGO = (ms) => `${Math.round(ms / 1000)}s`;

export function createChatDom({ document: doc = globalThis.document, renderMarkdown } = {}) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
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
      return el('div', 'chat-user', e.text);
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
