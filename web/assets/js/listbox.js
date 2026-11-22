// Select-only combobox (WAI-ARIA APG pattern): a pill trigger with role=combobox, a glass listbox in
// #layers. Focus stays on the trigger; aria-activedescendant points at the active option.
// Keys: ↓ / ↑ / Enter / Space / Alt+↓ open; in the list ↓ ↑ Home End PageDown PageUp move, Enter /
// Space / Alt+↑ choose, Esc closes, Tab chooses and moves on, typing jumps to the first match.
import { h, icon, nextId } from './dom.js';
import { layerRoot, place, closeOnMove, trackLayer, closeMenus } from './layers.js';

/**
 * selectBox({ label, options, value, onChange, icon?, className?, placeholder? })
 * options: [{ value, label, swatch?, hint?, group? }]  (group: a heading shown before the option)
 * returns { el, setOptions(options, value), setValue(value), get value(), open() }
 */
export function selectBox({ label, options = [], value = '', onChange, icon: iconName, className, emptyLabel, anchor = null }) {
  const id = nextId('cb');
  const labelId = `${id}-l`, listId = `${id}-list`, valueId = `${id}-v`;
  const valueEl = h('span', { class: 'cb-value', id: valueId });
  const trigger = h('div', {
    class: ['combo', className], role: 'combobox', tabindex: '0',
    'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-labelledby': `${labelId} ${valueId}`,
  },
  h('span', { class: 'sr-only', id: labelId }, label),
  iconName ? icon(iconName, 'cb-ico') : null,
  valueEl,
  icon('chevronDown', 'cb-caret'));

  let opts = options, current = value, popup = null, active = -1, optEls = [], disabled = false;
  let typed = '', typedAt = 0;

  function paintValue() {
    const o = opts.find((x) => x.value === current);
    const text = h('span', { class: 'cb-text' }, o ? o.short || o.label : (emptyLabel || ''));
    if (o?.swatch) valueEl.replaceChildren(h('span', { class: 'swatch', style: { background: o.swatch } }), text);
    else valueEl.replaceChildren(text);
    trigger.dataset.set = current ? '1' : '';
  }

  function setActive(i, scroll = true) {
    if (!popup || !optEls.length) return;
    active = Math.max(0, Math.min(optEls.length - 1, i));
    optEls.forEach((el, k) => el.classList.toggle('active', k === active));
    trigger.setAttribute('aria-activedescendant', optEls[active].id);
    if (scroll) optEls[active].scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const o = opts[i];
    close();
    if (!o) return;
    if (o.value !== current) { current = o.value; paintValue(); onChange?.(o.value, o); }
  }

  let untrack = () => {}, unwatch = () => {}, scrim = null;
  function open(at = null) {
    if (popup || disabled) return;
    closeMenus();
    scrim = h('div', { class: 'layer-scrim clear' });
    scrim.addEventListener('mousedown', (e) => { e.preventDefault(); close(); });
    const list = h('div', { class: 'menu-list', role: 'listbox', id: listId, 'aria-labelledby': labelId });
    optEls = opts.map((o, i) => {
      const el = h('div', { class: 'cb-opt', role: 'option', id: `${id}-o${i}`, 'aria-selected': String(o.value === current) },
        o.swatch ? h('span', { class: 'swatch', style: { background: o.swatch } }) : o.icon ? icon(o.icon) : h('span', { 'aria-hidden': 'true' }),
        h('span', { class: 'opt-label' }, o.label, o.hint ? h('span', { class: 'opt-hint' }, ` · ${o.hint}`) : null),
        o.value === current ? icon('check', 'opt-check') : h('span', { 'aria-hidden': 'true' }));
      el.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus on the trigger
      el.addEventListener('click', () => choose(i));
      el.addEventListener('mousemove', () => { if (active !== i) setActive(i, false); });
      return el;
    });
    const children = [];
    opts.forEach((o, i) => {
      if (o.group) children.push(h('div', { class: 'menu-label', role: 'presentation' }, o.group));
      if (o.sepBefore) children.push(h('div', { class: 'sep', role: 'presentation' }));
      children.push(optEls[i]);
    });
    list.append(...children);
    popup = h('div', { class: 'menu cb-pop' }, list);
    // anchor: the visible control the list belongs to (the month stepper's whole pill, not just its label)
    const at0 = (typeof anchor === 'function' ? anchor() : anchor) || trigger;
    popup.style.minWidth = `${Math.max(200, at0.getBoundingClientRect().width)}px`;
    layerRoot().append(scrim, popup);
    place(popup, { anchor: at0 });
    trigger.setAttribute('aria-expanded', 'true');
    untrack = trackLayer(popup, close);
    unwatch = closeOnMove(popup, close);
    const sel = opts.findIndex((o) => o.value === current);
    setActive(at ?? (sel >= 0 ? sel : 0));
  }

  function close() {
    if (!popup) return;
    unwatch(); untrack();
    popup.remove(); scrim?.remove();
    popup = null; scrim = null; optEls = []; active = -1;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }

  function typeAhead(ch) {
    const now = Date.now();
    typed = now - typedAt > 700 ? ch : typed + ch;
    typedAt = now;
    const from = popup ? active : opts.findIndex((o) => o.value === current);
    const start = typed.length === 1 ? from + 1 : Math.max(0, from);
    const order = [...opts.keys()].slice(start).concat([...opts.keys()].slice(0, start));
    const hit = order.find((i) => opts[i].label.startsWith(typed));
    if (hit === undefined) return;
    if (!popup) open(hit); else setActive(hit);
  }

  trigger.addEventListener('click', () => { if (popup) close(); else open(); });
  trigger.addEventListener('blur', () => close());
  trigger.addEventListener('keydown', (e) => {
    const k = e.key;
    if (!popup) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); open(); return; }
      if (k === 'Home') { e.preventDefault(); open(0); return; }
      if (k === 'End') { e.preventDefault(); open(opts.length - 1); return; }
    } else {
      if (k === 'ArrowDown' && e.altKey) { e.preventDefault(); return; }
      if (k === 'ArrowUp' && e.altKey) { e.preventDefault(); choose(active); return; }
      switch (k) {
        case 'ArrowDown': e.preventDefault(); setActive(active + 1); return;
        case 'ArrowUp': e.preventDefault(); setActive(active - 1); return;
        case 'Home': e.preventDefault(); setActive(0); return;
        case 'End': e.preventDefault(); setActive(optEls.length - 1); return;
        case 'PageDown': e.preventDefault(); setActive(active + 10); return;
        case 'PageUp': e.preventDefault(); setActive(active - 10); return;
        case 'Enter': case ' ': e.preventDefault(); choose(active); return;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return;
        case 'Tab': choose(active); return;
        default: break;
      }
    }
    if (k.length === 1 && k !== ' ' && k !== '/' && k !== '?' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); typeAhead(k); }
  });

  paintValue();
  return {
    el: trigger,
    setOptions(next, v = current) { opts = next; current = v; close(); paintValue(); },
    setValue(v) { current = v; paintValue(); },
    get value() { return current; },
    /** Disabled: not focusable, does not open; aria-disabled says why the value cannot change. */
    setDisabled(v) {
      disabled = Boolean(v);
      if (disabled) close();
      trigger.setAttribute('aria-disabled', String(disabled));
      trigger.tabIndex = disabled ? -1 : 0;
    },
    open,
    close,
  };
}
