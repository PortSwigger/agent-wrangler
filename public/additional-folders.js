import { PLUS_ICON, X_ICON } from './icons.js';

export function createAdditionalFolders({ list, add, send, recentFolders = () => [], onChange = () => {}, document = globalThis.document }) {
  let rows = [];
  let enabled = true;
  add.innerHTML = `<span aria-hidden="true">${PLUS_ICON}</span>`;
  let nextId = 0;
  function addRow(value = '', focus = false) {
    const row = { field: `extra-folder-${++nextId}`, entries: [], wanted: false, index: -1 };
    const el = document.createElement('div');
    el.className = 'additional-folder-row';
    const combo = document.createElement('div');
    combo.className = 'combo';
    const input = document.createElement('input');
    input.value = value;
    input.placeholder = '/path/to/another/project';
    input.autocomplete = 'off';
    input.disabled = !enabled;
    input.setAttribute?.('aria-label', 'Additional folder');
    const box = document.createElement('div');
    box.className = 'suggest hidden';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'folder-action';
    remove.innerHTML = `<span aria-hidden="true">${X_ICON}</span>`;
    remove.title = 'Remove folder';
    remove.setAttribute?.('aria-label', 'Remove folder');
    const hint = document.createElement('div');
    hint.className = 'worktree-msg hidden';
    combo.append(input, box, hint);
    el.append(combo, remove);
    list.append(el);
    Object.assign(row, { el, input, box, hint });
    rows.push(row);
    function close() { row.wanted = false; box.className = 'suggest hidden'; }
    function browse() {
      if (!enabled) return;
      row.entries = []; row.index = -1; row.wanted = true;
      hint.className = 'worktree-msg hidden';
      send({ type: 'browse-folders', field: row.field, path: input.value });
      render(row);
      onChange();
    }
    row.pick = (path) => {
      if (!enabled) return;
      input.value = `${path.replace(/\/+$/, '')}/`;
      browse(); close();
    };
    input.addEventListener('focus', browse);
    input.addEventListener('input', browse);
    input.addEventListener('mousedown', () => { if (!row.wanted) browse(); });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', (e) => {
      if (!enabled) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); row.wanted = true;
        row.index = row.matches.length ? Math.max(0, Math.min(row.matches.length - 1, row.index + (e.key === 'ArrowDown' ? 1 : -1))) : -1;
        render(row);
      } else if ((e.key === 'Enter' && row.matches[row.index] && !e.metaKey && !e.ctrlKey) || (e.key === 'Tab' && !e.shiftKey && row.wanted && row.matches.length)) {
        e.preventDefault(); row.pick(row.matches[Math.max(0, row.index)]);
      } else if (e.key === 'Escape' && row.wanted) {
        e.preventDefault(); e.stopPropagation(); close();
      }
    });
    remove.addEventListener('click', () => { rows = rows.filter((r) => r !== row); el.remove(); onChange(); });
    render(row);
    if (focus) input.focus();
  }
  function render(row) {
    const q = row.input.value.trim().toLowerCase();
    row.matches = [...new Set([
      ...recentFolders().filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 8),
      ...row.entries,
    ])].slice(0, 12);
    if (row.index >= row.matches.length) row.index = row.matches.length - 1;
    row.box.replaceChildren();
    row.matches.forEach((path, index) => {
      const item = document.createElement('div');
      item.className = `suggest-item${row.index === index ? ' active' : ''}`;
      item.textContent = path;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); row.pick(path); });
      row.box.append(item);
    });
    row.box.className = row.wanted && row.matches.length ? 'suggest' : 'suggest hidden';
  }
  add.addEventListener('click', () => { if (enabled) addRow('', true); });
  return {
    setEnabled(value) {
      enabled = Boolean(value);
      add.disabled = !enabled;
      add.title = enabled ? 'Add another folder' : 'Additional folders require a local launch';
      for (const row of rows) {
        row.input.disabled = !enabled;
        if (!enabled) { row.wanted = false; row.box.className = 'suggest hidden'; }
      }
      onChange();
    },
    reset(values = []) { rows = []; list.replaceChildren(); for (const value of values) addRow(value); onChange(); },
    values() { if (!enabled) return []; return [...new Set(rows.map(({ input }) => input.value.trim().replace(/(?!^)\/+$/, '')).filter(Boolean))]; },
    invalid() { return enabled && rows.some((row) => row.input.value.trim() && row.checkedPath === row.input.value && row.exists === false); },
    onBrowse(msg) {
      if (!msg.field?.startsWith('extra-folder-')) return false;
      const row = rows.find((r) => r.field === msg.field);
      if (!row || row.input.value !== msg.path) return true;
      row.checkedPath = msg.path;
      row.exists = msg.exists;
      row.entries = msg.entries || [];
      row.hint.textContent = msg.exists === false ? 'Choose an existing folder.' : '';
      row.hint.className = msg.exists === false ? 'worktree-msg error' : 'worktree-msg hidden';
      render(row);
      onChange();
      return true;
    },
  };
}
