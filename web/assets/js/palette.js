// Command palette (Ctrl+K): jump to a section, month, category or merchant, or run an action.
import { h, icon, nextId } from './dom.js';
import { state } from './store.js';
import { SECTIONS, go } from './router.js';
import { monthLabel } from './format.js';
import { layerRoot } from './layers.js';

let open = null;

function normalize(s) { return String(s || '').toLowerCase().replace(/["'״׳.\-]/g, '').replace(/\s+/g, ' ').trim(); }

function score(text, q) {
  const t = normalize(text);
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.split(' ').some((w) => w.startsWith(q))) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

/** actions: [{ label, icon, kbd, run }] provided by app.js */
export function openPalette(actions) {
  if (open) { open.input.focus(); return; }
  const restore = document.activeElement;
  const listId = nextId('pal');
  const input = h('input', {
    type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list',
    'aria-label': 'חיפוש, מעבר או פקודה', placeholder: 'לאן לעבור? בית עסק, קטגוריה, חודש או פקודה', autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('div', { class: 'palette-list', id: listId, role: 'listbox', 'aria-label': 'תוצאות' });
  const scrim = h('div', { class: 'layer-scrim for-palette' });
  const el = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'פקודות' },
    h('div', { class: 'palette-input' }, icon('search'), input),
    list,
    h('div', { class: 'palette-foot', 'aria-hidden': 'true' },
      h('span', null, h('kbd', null, '↑↓'), ' מעבר'), h('span', null, h('kbd', null, 'Enter'), ' בחירה'), h('span', null, h('kbd', null, 'Esc'), ' סגירה')));

  let flat = [], active = 0;

  function build(qRaw) {
    const q = normalize(qRaw);
    const groups = [];
    const push = (title, items, limit) => {
      const scored = items.map((it) => ({ ...it, s: score(it.match || it.label, q) })).filter((it) => it.s > 0)
        .sort((a, b) => b.s - a.s).slice(0, limit);
      if (scored.length) groups.push({ title, items: scored });
    };
    push('מעבר', [
      ...SECTIONS.filter((s) => !s.business || state.business?.enabled).map((s) => ({ label: s.label, icon: s.icon, kbd: `Ctrl+${s.key}`, match: s.id === 'annual' ? 'שנתי סיכום שנתי שנה מגמות' : s.id === 'chat' ? 'שאלות שאלה שאל צאט צ׳אט עוזר' : s.label, run: () => go(s.id) })),
      { label: 'מגמות מחירים', icon: 'tag2', match: 'מגמות מחירים התייקרויות מחיר', run: () => go('annual', { tab: 'prices' }) },
    ], q ? 4 : 6);
    push('פעולות', actions.filter((a) => !a.when || a.when()).map((a) => ({ ...a })), q ? 5 : 8);
    if (q) {
      push('בתי עסק', state.merchants.map((m) => ({ label: m, icon: 'store', sub: 'כל התנועות', run: () => go('transactions', { q: m }) })), 6);
      push('קטגוריות', state.categories.map((c) => ({ label: c.name, icon: 'tag', swatch: c.color, sub: state.month ? monthLabel(state.month) : 'כל התקופות', run: () => go('transactions', { category: c.id, month: state.month || undefined }) })), 6);
      push('חודשים', state.availableMonths.map((m) => ({ label: monthLabel(m), icon: 'calendar', sub: 'סקירה', run: () => go('overview', { month: m }) })), 4);
    } else if (state.availableMonths.length) {
      push('חודשים אחרונים', state.availableMonths.slice(0, 3).map((m) => ({ label: monthLabel(m), icon: 'calendar', sub: 'סקירה', run: () => go('overview', { month: m }) })), 3);
    }
    // Free-text search is the fallback, listed last: Enter on "קבועים" or "מאי" should jump there,
    // not search the transactions for that word.
    if (q) groups.push({ title: 'חיפוש', items: [{ label: `חיפוש בתנועות: ${qRaw.trim()}`, icon: 'search', run: () => go('transactions', { q: qRaw.trim() }) }] });
    return groups;
  }

  function render() {
    const groups = build(input.value);
    flat = [];
    list.replaceChildren();
    if (!groups.length) { list.append(h('div', { class: 'palette-empty', role: 'presentation' }, 'לא נמצא. אפשר לחפש לפי שם בית עסק, קטגוריה או חודש.')); input.removeAttribute('aria-activedescendant'); return; }
    for (const g of groups) {
      const gid = nextId('pg');
      const groupEl = h('div', { role: 'group', 'aria-labelledby': gid }, h('div', { class: 'palette-group', id: gid }, g.title));
      for (const it of g.items) {
        const id = nextId('po');
        const idx = flat.length;
        const opt = h('div', { class: 'palette-item', role: 'option', id, 'aria-selected': 'false' },
          it.swatch ? h('span', { class: 'swatch', style: { background: it.swatch, justifySelf: 'center' } }) : icon(it.icon || 'chevron'),
          h('span', null, h('bdi', null, it.label), it.sub ? h('span', { class: 'sub' }, ` · ${it.sub}`) : null),
          it.kbd ? h('kbd', null, it.kbd) : h('span'));
        opt.addEventListener('mousemove', () => setActive(idx));
        opt.addEventListener('mousedown', (e) => e.preventDefault());
        opt.addEventListener('click', () => choose(idx));
        flat.push({ it, opt });
        groupEl.append(opt);
      }
      list.append(groupEl);
    }
    setActive(0);
  }

  function setActive(i) {
    if (!flat.length) return;
    active = (i + flat.length) % flat.length;
    flat.forEach((f, k) => f.opt.setAttribute('aria-selected', String(k === active)));
    input.setAttribute('aria-activedescendant', flat[active].opt.id);
    flat[active].opt.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const f = flat[i];
    if (!f) return;
    close(false);
    f.it.run();
  }

  function close(restoreFocus = true) {
    scrim.remove(); el.remove(); open = null;
    if (restoreFocus && restore && document.contains(restore)) restore.focus();
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(Math.min(flat.length - 1, active + 6)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(Math.max(0, active - 6)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  });
  scrim.addEventListener('mousedown', () => close());

  layerRoot().append(scrim, el);
  open = { input, close };
  render();
  input.focus();
}

export const paletteOpen = () => Boolean(open);
