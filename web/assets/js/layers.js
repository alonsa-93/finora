// Floating layers: dialogs (focus-trapped, focus restored), menus (context + popover), popovers,
// toasts, live announcements. Every layer is rendered into ONE top-level container at the end of
// <body> (#layers) and positioned from the trigger's getBoundingClientRect(): a glass panel's
// backdrop-filter / transform would otherwise become the containing block of `position: fixed`.
import { h, icon, nextId } from './dom.js';

const stack = [];   // open layers, topmost last: { el, close }

export const hasOpenLayer = () => stack.length > 0;
/** For components that build their own layer (listbox.js): register so global keys stand back. */
export function trackLayer(el, close) {
  const entry = { el, close };
  stack.push(entry);
  return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); };
}

let root = null;
/** The single portal for everything that floats. A plain element (display: contents), never transformed. */
export function layerRoot() {
  if (!root || !root.isConnected) {
    root = document.getElementById('layers') || h('div', { id: 'layers', class: 'layer-root' });
    document.body.append(root);
  }
  return root;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/**
 * Return focus to where it came from. The opener may have been re-rendered while the layer was
 * open (e.g. a table row after saving); then use its replacement (same data-focus-key), else <main>.
 */
export function restoreFocus(restore) {
  if (!restore) return;
  if (document.contains(restore)) { restore.focus({ preventScroll: true }); return; }
  const key = restore.dataset?.focusKey;
  const twin = key && document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  (twin || document.getElementById('main'))?.focus({ preventScroll: true });
}

const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement);

function trap(e, root) {
  if (e.key !== 'Tab') return;
  const f = focusables(root);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ---------------- positioning ---------------- */
const MARGIN = 8;
const cssPx = (name, fallback) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;

/** The free area a popover may use: below the title bar, clear of the floating rail, 8px from every edge. */
export function safeArea() {
  const top = (document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? cssPx('--titlebar-h', 40)) + MARGIN;
  let right = innerWidth - MARGIN;
  let left = MARGIN;
  const rail = document.querySelector('.sidebar');
  if (rail) {
    const r = rail.getBoundingClientRect();
    if (r.width && r.left > innerWidth / 2) right = Math.min(right, r.left - MARGIN);   // RTL: the rail is on the right
    else if (r.width) left = Math.max(left, r.right + MARGIN);
  }
  return { top, right, bottom: innerHeight - MARGIN, left };
}

/**
 * Place a fixed layer next to a trigger or a point.
 * pos: { anchor: Element } | { rect: DOMRect } | { x, y }
 * Anchored: aligned to the trigger's right edge (RTL start), below it; flips above when there is
 * more room there; clamped into the safe area; max-height shrinks to the room available.
 * Point (context menu): opens to the left of the pointer (RTL), flips right / up at the edges.
 */
export function place(el, pos, { gap = cssPx('--pop-gap', 6), align = 'start' } = {}) {
  const area = safeArea();
  el.classList.remove('is-placed');
  el.style.maxHeight = '';
  el.style.left = '0px'; el.style.top = '0px';
  let r = el.getBoundingClientRect();
  let x, y, side = 'bottom';
  const anchorRect = pos.rect || (pos.anchor ? pos.anchor.getBoundingClientRect() : null);
  if (anchorRect) {
    const a = anchorRect;
    const below = area.bottom - (a.bottom + gap);
    const above = (a.top - gap) - area.top;
    x = align === 'end' ? a.left : a.right - r.width;
    if (r.height <= below || below >= above) {
      y = a.bottom + gap;
      if (r.height > below) el.style.maxHeight = `${Math.max(120, below)}px`;
    } else {
      side = 'top';
      if (r.height > above) el.style.maxHeight = `${Math.max(120, above)}px`;
      r = el.getBoundingClientRect();
      y = a.top - gap - r.height;
    }
  } else {
    x = pos.x - r.width;
    if (x < area.left) x = pos.x;                       // no room on the left: open to the right
    y = pos.y;
    if (y + r.height > area.bottom) {
      if (pos.y - r.height >= area.top) { y = pos.y - r.height; side = 'top'; }   // flip above the pointer
      else { el.style.maxHeight = `${area.bottom - area.top}px`; y = area.top; }
    }
  }
  r = el.getBoundingClientRect();
  // Anchored and too wide to hang from the trigger's right edge (RTL start): hang from its left edge
  // instead, so the layer stays attached to its trigger rather than being pushed sideways by the clamp.
  if (anchorRect && align !== 'end' && x < area.left && anchorRect.left + r.width <= area.right) x = anchorRect.left;
  else if (anchorRect && align === 'end' && x + r.width > area.right && anchorRect.right - r.width >= area.left) x = anchorRect.right - r.width;
  x = Math.max(area.left, Math.min(x, area.right - r.width));
  y = Math.max(area.top, Math.min(y, area.bottom - r.height));
  // whole pixels, rounded towards the inside of the safe area (a half pixel must not cross the margin)
  el.style.left = `${Math.max(Math.ceil(area.left), Math.min(Math.round(x), Math.floor(area.right - r.width)))}px`;
  el.style.top = `${Math.max(Math.ceil(area.top), Math.min(Math.round(y), Math.floor(area.bottom - r.height)))}px`;
  el.dataset.side = side;
  el.classList.add('is-placed');   // entry animation starts only now
  return side;
}

/** Close a popover when the page under it moves: window resize, or a scroll outside the popover. */
export function closeOnMove(el, close) {
  const onScroll = (e) => { if (!el.contains(e.target)) close(); };
  const onResize = () => close();
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onResize);
  return () => {
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
  };
}

/* ---------------- dialog ---------------- */
/**
 * openDialog({ title, body: Node|Node[], actions: Node[], wide, onClose, initialFocus })
 * returns { el, close }
 */
export function openDialog({ title, body, actions = [], wide = false, onClose, initialFocus, className, role = 'dialog' }) {
  const restore = document.activeElement;
  const titleId = nextId('dlg');
  const scrim = h('div', { class: 'layer-scrim' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'סגירה' }, icon('close'));
  const el = h('div', { class: ['dialog', wide && 'wide', className], role, 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'dlg-head' }, h('h2', { id: titleId }, title), closeBtn),
    h('div', { class: 'dlg-body' }, body),
    actions.length ? h('div', { class: 'dlg-foot' }, actions) : null);
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    scrim.remove(); el.remove();
    const i = stack.findIndex((l) => l.el === el); if (i >= 0) stack.splice(i, 1);
    restoreFocus(restore);
    onClose?.(result);
  };
  closeBtn.addEventListener('click', () => close());
  scrim.addEventListener('mousedown', () => close());
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    trap(e, el);
  });
  layerRoot().append(scrim, el);
  stack.push({ el, close });
  // A body with nothing focusable (e.g. the shortcut list) must still scroll from the keyboard.
  const bodyEl = el.querySelector('.dlg-body');
  if (!focusables(bodyEl).length) { bodyEl.tabIndex = 0; bodyEl.setAttribute('role', 'group'); bodyEl.setAttribute('aria-labelledby', titleId); }
  const target = typeof initialFocus === 'function' ? initialFocus(el) : initialFocus;
  (target || focusables(el.querySelector('.dlg-body'))[0] || focusables(el)[0] || el).focus();
  return { el, close };
}

/** Promise-based confirm. */
export function confirmDialog({ title, message, confirmLabel = 'אישור', cancelLabel = 'ביטול', danger = false, extra }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: ['btn', danger ? 'danger solid' : 'primary'], type: 'button' }, confirmLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, cancelLabel);
    const dlg = openDialog({
      title, role: 'alertdialog',
      body: [h('p', null, message), extra || null],
      actions: [ok, cancel],
      initialFocus: () => cancel,
      onClose: () => resolve(result),
    });
    ok.addEventListener('click', () => { result = true; dlg.close(); });
    cancel.addEventListener('click', () => dlg.close());
  });
}

/**
 * A question with several answers (buttons). Resolves the chosen `value`, or null on Esc / close.
 * choices: [{ value, label, primary? }]; `initial` = the value whose button gets focus.
 */
export function choiceDialog({ title, message, extra, choices, initial }) {
  return new Promise((resolve) => {
    let result = null;
    const buttons = choices.map((c) => {
      const b = h('button', { class: ['btn', c.primary ? 'primary' : null], type: 'button' }, c.label);
      b.addEventListener('click', () => { result = c.value; dlg.close(); });
      return b;
    });
    const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'ביטול');
    cancel.addEventListener('click', () => dlg.close());
    const dlg = openDialog({
      title,
      body: [h('p', null, message), extra || null],
      actions: [...buttons, h('span', { class: 'grow' }), cancel],
      initialFocus: () => buttons[Math.max(0, choices.findIndex((c) => c.value === initial))],
      onClose: () => resolve(result),
    });
  });
}

/* ---------------- menus ---------------- */
/**
 * openMenu({ x, y } | { anchor } | { rect }, items, { label, onClose, header, footer })
 * item: { label, icon?, kbd?, onSelect, disabled?, swatch?, checked? } | 'sep' | { group: 'label' }
 */
export function openMenu(pos, items, { label = 'תפריט', onClose, header, footer, role = 'menu', className } = {}) {
  closeMenus();
  const restore = document.activeElement;
  const scrim = h('div', { class: 'layer-scrim clear' });
  // A menu with a search field (category picker) is a small dialog holding the field and the menu:
  // role=menu may only contain menu items. The list is the scroll container, focusable by script.
  const el = h('div', { class: ['menu', className], role: header ? 'dialog' : role, 'aria-label': label, tabindex: '-1' });
  const nodes = [];
  if (header) el.append(header);
  const list = header
    ? h('div', { class: 'menu-list', role, 'aria-label': label, tabindex: '0' })   // Tab reaches the list; arrows pick
    : h('div', { class: 'menu-list', role: role === 'menu' ? 'none' : 'presentation' });
  el.append(list);

  function render(itemsToShow) {
    list.replaceChildren();
    nodes.length = 0;
    for (const it of itemsToShow) {
      if (it === 'sep') { list.append(h('div', { class: 'sep', role: 'separator' })); continue; }
      if (it.group) { list.append(h('div', { class: 'menu-label', role: 'presentation' }, it.group)); continue; }
      const itemRole = it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
      const b = h('button', {
        type: 'button', role: itemRole, tabindex: '-1',
        'aria-disabled': it.disabled ? 'true' : null,
        'aria-checked': it.checked !== undefined ? String(Boolean(it.checked)) : null,
      },
      it.swatch ? h('span', { class: 'swatch', style: { background: it.swatch } })
        : it.icon ? icon(it.icon)
          : it.checked ? icon('check', 'opt-check') : h('span', { 'aria-hidden': 'true' }),
      h('span', { class: 'opt-label' }, it.label),
      it.kbd ? h('kbd', null, it.kbd) : h('span', { 'aria-hidden': 'true' }));
      b.addEventListener('click', () => { if (it.disabled) return; close(); it.onSelect?.(); });
      b.addEventListener('mousemove', () => { if (nodes.indexOf(b) !== active) setActive(nodes.indexOf(b)); });
      nodes.push(b);
      list.append(b);
    }
    if (!nodes.length && header) list.append(h('p', { class: 'menu-empty' }, 'לא נמצא'));
  }
  render(items);
  if (footer) el.append(footer);

  let active = -1;
  function setActive(i) {
    nodes.forEach((n) => n.classList.remove('active'));
    active = i;
    if (nodes[i]) { nodes[i].classList.add('active'); nodes[i].focus({ preventScroll: true }); nodes[i].scrollIntoView({ block: 'nearest' }); }
  }
  const move = (d) => {
    if (!nodes.length) return;
    let i = active;
    for (let n = 0; n < nodes.length; n++) {
      i = (i + d + nodes.length) % nodes.length;
      if (nodes[i].getAttribute('aria-disabled') !== 'true') break;
    }
    setActive(i);
  };
  // type-ahead on plain menus: the first item whose label starts with the typed letters
  let typed = '', typedAt = 0;
  function typeAhead(ch) {
    const now = Date.now();
    typed = now - typedAt > 700 ? ch : typed + ch;
    typedAt = now;
    const start = Math.max(0, active + (typed.length === 1 ? 1 : 0));
    const order = [...nodes.slice(start), ...nodes.slice(0, start)];
    const hit = order.find((n) => n.textContent.trim().startsWith(typed));
    if (hit) setActive(nodes.indexOf(hit));
  }

  let closed = false;
  let unwatch = () => {};
  function close() {
    if (closed) return; closed = true;
    unwatch();
    scrim.remove(); el.remove();
    const i = stack.findIndex((l) => l.el === el); if (i >= 0) stack.splice(i, 1);
    restoreFocus(restore);
    onClose?.();
  }
  el.addEventListener('keydown', (e) => {
    const inInput = e.target.tagName === 'INPUT';
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home' && !inInput) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !inInput) { e.preventDefault(); setActive(nodes.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') {
      if (el.querySelector('input')) trap(e, el);   // menus with fields: Tab moves between search, items, options
      else { e.preventDefault(); close(); }
    } else if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') { typeAhead(e.key); }
  });
  scrim.addEventListener('mousedown', close);
  scrim.addEventListener('contextmenu', (e) => { e.preventDefault(); close(); });

  layerRoot().append(scrim, el);
  stack.push({ el, close });
  place(el, pos);
  unwatch = closeOnMove(el, close);

  const firstInput = el.querySelector('input');
  if (firstInput) firstInput.focus(); else if (nodes.length) move(1); else el.focus();
  return { el, close, render, move, setActive, reposition: () => place(el, pos) };
}

export function closeMenus() {
  for (const l of [...stack]) if (l.el.classList.contains('menu') || l.el.classList.contains('popover')) l.close();
}

/* ---------------- popover (non-modal dialog anchored to a trigger) ---------------- */
/** openPopover(anchor, { label, content: Node[], onClose, initialFocus }) → { el, close } */
export function openPopover(anchor, { label, content, onClose, initialFocus, className }) {
  closeMenus();
  const restore = document.activeElement;
  const scrim = h('div', { class: 'layer-scrim clear' });
  const el = h('div', { class: ['popover', className], role: 'dialog', 'aria-label': label, tabindex: '-1' }, content);
  let closed = false;
  let unwatch = () => {};
  const close = (keepFocus = false) => {
    if (closed) return; closed = true;
    unwatch();
    scrim.remove(); el.remove();
    const i = stack.findIndex((l) => l.el === el); if (i >= 0) stack.splice(i, 1);
    if (!keepFocus) restoreFocus(restore);
    onClose?.();
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    trap(e, el);
  });
  scrim.addEventListener('mousedown', () => close());
  layerRoot().append(scrim, el);
  stack.push({ el, close });
  place(el, { anchor });
  unwatch = closeOnMove(el, () => close());
  const target = typeof initialFocus === 'function' ? initialFocus(el) : initialFocus;
  (target || focusables(el)[0] || el).focus();
  return { el, close };
}

/* ---------------- toasts + live region ---------------- */
let toastHost, live, liveAssertive;
function ensureHosts() {
  if (toastHost && toastHost.isConnected) return;
  toastHost = h('div', { class: 'toasts', role: 'region', 'aria-label': 'הודעות' });
  live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  liveAssertive = h('div', { class: 'sr-only', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  layerRoot().append(toastHost, live, liveAssertive);
}

export function announce(text, assertive = false) {
  ensureHosts();
  const el = assertive ? liveAssertive : live;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}

export function toast(message, { kind = 'info', action, timeout = 5000 } = {}) {
  ensureHosts();
  const t = h('div', { class: 'toast', dataset: { kind } });
  const origin = document.activeElement;   // where the user was when the toast appeared
  const close = () => {
    const hadFocus = t.contains(document.activeElement);
    t.remove();
    // Never strand keyboard focus on <body> when the focused toast goes away.
    if (hadFocus) restoreFocus(origin && origin !== document.body ? origin : document.getElementById('main'));
  };
  t.append(h('span', { class: 'msg' }, message));
  if (action) {
    const b = h('button', { class: 't-action', type: 'button' }, action.label);
    b.addEventListener('click', () => { close(); action.onSelect(); });
    if (action.kbd) b.setAttribute('aria-keyshortcuts', action.kbd);
    t.append(b);
  }
  const x = h('button', { class: 't-close', type: 'button', 'aria-label': 'סגירת ההודעה' }, icon('close'));
  x.addEventListener('click', close);
  t.append(x);
  toastHost.append(t);
  announce(action?.hint ? `${message} ${action.hint}` : message, kind === 'error');
  if (timeout) setTimeout(close, timeout);
  return close;
}

/* ---------------- tooltips ---------------- */
/**
 * One tooltip element for every [data-tip] in the app (replaces the OS `title` bubble, which ignores
 * the theme and RTL). Hover: after 400ms; keyboard focus: at once; Esc hides it. The text is also
 * exposed to assistive tech through aria-description on the trigger.
 */
let tipEl = null, tipFor = null, tipTimer = 0;
export function initTooltips() {
  if (tipEl) return;
  tipEl = h('div', { class: 'tooltip', role: 'tooltip', id: 'app-tooltip', hidden: true });
  layerRoot().append(tipEl);
  const show = (el) => {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tipFor = el;
    tipEl.textContent = text;
    tipEl.hidden = false;
    const a = el.getBoundingClientRect();
    tipEl.style.left = '0px'; tipEl.style.top = '0px';
    const r = tipEl.getBoundingClientRect();
    const area = safeArea();
    let y = a.top - 8 - r.height;
    if (y < area.top) y = a.bottom + 8;
    let x = a.right - r.width;                                  // RTL: right edges aligned
    x = Math.max(area.left, Math.min(x, area.right - r.width));
    tipEl.style.left = `${Math.round(x)}px`; tipEl.style.top = `${Math.round(y)}px`;
  };
  const hide = () => { clearTimeout(tipTimer); tipFor = null; if (tipEl) tipEl.hidden = true; };
  // Any older `title` in the app is adopted on first contact: same tooltip everywhere, no OS bubble.
  const adopt = (el) => {
    const t = el.getAttribute('title');
    if (t == null) return el;
    el.removeAttribute('title');
    if (!t) return el;
    el.dataset.tip = t;
    if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.textContent.trim()) el.setAttribute('aria-label', t);
    else if (!el.hasAttribute('aria-description') && el.getAttribute('aria-label') !== t) el.setAttribute('aria-description', t);
    return el;
  };
  const target = (e) => { const el = e.target.closest?.('[data-tip], [title]'); return el && !(el instanceof SVGElement) ? adopt(el) : null; };
  document.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el === tipFor) return;
    hide();
    if (el) tipTimer = setTimeout(() => show(el), 400);
  });
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    hide();
    if (el && e.target.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipFor) hide(); }, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
/**
 * Give an element a tooltip. A focusable trigger also gets the text as its accessible description;
 * on a plain chip the tooltip is a visual extra (the same facts are in the inspector).
 */
export function tip(el, text) {
  if (!text) return el;
  el.dataset.tip = text;
  el.removeAttribute('title');
  if (el.matches('a[href], a[download], button, [tabindex]') && el.getAttribute('aria-label') !== text) el.setAttribute('aria-description', text);
  return el;
}
