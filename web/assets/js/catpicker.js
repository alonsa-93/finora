// Category picker popover: type to filter, arrows to move, Enter to choose. Whether the change also
// applies to similar rows is asked AFTER the pick, with the real count (views/transactions.js).
import { h, icon } from './dom.js';
import { openMenu } from './layers.js';
import { state } from './store.js';

const KIND_GROUP = { expense: 'הוצאות', income: 'הכנסות', neutral: 'העברות וחיובי כרטיס' };

/**
 * pickCategory(anchorOrPoint, { current, onPick(categoryId) })
 */
export function pickCategory(pos, { current, onPick }) {
  const input = h('input', { type: 'search', placeholder: 'חיפוש קטגוריה', 'aria-label': 'חיפוש קטגוריה', autocomplete: 'off' });
  const footer = null;

  const build = (q) => {
    const needle = q.trim();
    const items = [];
    for (const kind of ['expense', 'income', 'neutral']) {
      const cats = state.categories.filter((c) => c.kind === kind && (!needle || c.name.includes(needle)));
      if (!cats.length) continue;
      items.push({ group: KIND_GROUP[kind] });
      for (const c of cats) {
        items.push({
          label: c.name, swatch: c.color, kbd: c.id === current ? 'נוכחית' : null,
          onSelect: () => onPick(c.id),
        });
      }
    }
    return items;
  };
  // the class (its width) goes in before placement, or the right edge drifts off the trigger
  const menu = openMenu(pos, build(''), { label: 'בחירת קטגוריה', header: h('div', { class: 'menu-search' }, h('label', { class: 'pill-field' }, icon('search'), input)), footer, className: 'cat-menu' });
  input.addEventListener('input', () => { menu.render(build(input.value)); menu.setActive(-1); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const active = menu.el.querySelector('[role="menuitem"].active') || menu.el.querySelector('[role="menuitem"]');
      active?.click();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      menu.move(1);
    }
  });
  input.focus();
  return menu;
}
