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

  function toolRow(t) {
    const row = el('div', 'chat-tool-row');
    row.appendChild(el('span', 'chat-tool-name', t.name));
    row.appendChild(el('span', 'chat-tool-target', t.target || ''));
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
    const chip = el('button', 'chat-activity-chip');
    chip.setAttribute('type', 'button');
    chip.setAttribute('aria-expanded', 'false');
    chip.appendChild(el('span', 'chat-activity-label', activityTitle(item)));
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
      const foot = el('div', 'chat-turn-foot');
      if (e.model) foot.appendChild(el('span', 'chat-model', e.model));
      wrap.appendChild(foot);
      return wrap;
    }
    if (item.type === 'thinking') {
      const wrap = el('div', 'chat-thinking');
      wrap.appendChild(el('span', 'chat-thinking-label', e.durationMs ? `Thought for ${AGO(e.durationMs)}` : 'Thinking'));
      if (e.text) {
        const body = el('div', 'chat-thinking-body', e.text);
        body.dataset.collapsed = '1';
        wrap.appendChild(body);
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

  return { itemNode };
}
