import { closeTaskFilterOnOutsideClick } from './search-filter.js';

const ARROW = '<svg class="search-select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

export function describeOptions(children) {
  const items = [];
  for (const child of children) {
    if (child.tagName === 'OPTGROUP') {
      items.push({ heading: child.label });
      for (const o of child.children) items.push({ value: o.value, label: o.textContent, disabled: o.disabled || child.disabled });
    } else if (child.tagName === 'OPTION') {
      items.push({ value: child.value, label: child.textContent, disabled: child.disabled });
    }
  }
  return items;
}

export function enhanceSelect(select) {
  if (select.dataset.dd) return;
  select.dataset.dd = '1';

  const details = document.createElement('details');
  details.className = 'search-dd dd-field';
  const summary = document.createElement('summary');
  summary.className = 'search-select dd-select';
  const label = document.createElement('span');
  label.className = 'search-select-label';
  summary.append(label);
  summary.insertAdjacentHTML('beforeend', ARROW);
  const panel = document.createElement('div');
  panel.className = 'search-dd-panel';
  details.append(summary, panel);
  select.classList.add('dd-native');
  select.after(details);

  function paint() {
    const selected = select.options[select.selectedIndex];
    label.textContent = selected ? selected.textContent : '';
    details.classList.toggle('disabled', select.disabled);
    if (select.disabled) details.open = false;
    panel.textContent = '';
    for (const item of describeOptions(select.children)) {
      if (item.heading !== undefined) {
        const head = document.createElement('div');
        head.className = 'search-task-heading';
        head.textContent = item.heading;
        panel.appendChild(head);
        continue;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-dd-option' + (item.value === select.value ? ' on' : '');
      row.textContent = item.label;
      row.disabled = item.disabled;
      row.addEventListener('click', () => {
        select.value = item.value;
        details.open = false;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        summary.focus();
      });
      panel.appendChild(row);
    }
  }

  const proto = Object.getPrototypeOf(select);
  for (const prop of ['value', 'selectedIndex']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop) || Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); paint(); },
    });
  }
  new MutationObserver(paint).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label'] });
  select.addEventListener('change', paint);
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    const card = details.closest('.modal-card');
    if (!card) return;
    const room = card.getBoundingClientRect().bottom - summary.getBoundingClientRect().bottom;
    details.classList.toggle('up', room < Math.min(panel.scrollHeight, 240) + 16);
  });
  summary.addEventListener('click', (e) => { if (select.disabled) e.preventDefault(); });
  details.addEventListener('keydown', (e) => {
    if (select.disabled || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    if (details.open) {
      const rows = [...panel.querySelectorAll('button:not(:disabled)')];
      const at = rows.indexOf(document.activeElement);
      const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : at + step;
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
      return;
    }
    const options = [...select.options];
    for (let i = select.selectedIndex + step; i >= 0 && i < options.length; i += step) {
      if (options[i].matches(':disabled')) continue;
      select.selectedIndex = i;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
  });
  paint();
}

export function enhanceSelects(root) {
  const run = () => root.querySelectorAll('select:not([data-dd])').forEach(enhanceSelect);
  run();
  new MutationObserver(run).observe(root, { childList: true, subtree: true });
  document.addEventListener('pointerdown', (e) => {
    for (const d of root.querySelectorAll('.dd-field[open]')) closeTaskFilterOnOutsideClick(d, e.target);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = root.querySelector('.dd-field[open]');
    if (!open) return;
    open.open = false;
    e.stopPropagation();
  }, true);
}
