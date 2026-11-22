// שאלות: ask about your own money in Hebrew. The server answers locally (POST /api/chat, server/chat.js);
// nothing leaves the computer. Every answer quotes exact amounts and opens the matching transactions.
import { h, icon, mount, avatarOf } from '../dom.js';
import { api } from '../api.js';
import { on } from '../store.js';
import { go } from '../router.js';
import { setWhere } from '../shell.js';
import { announce } from '../layers.js';
import { money } from '../format.js';
import { pageHead } from './common.js';

const MAX = 300;
const STARTERS = [
  'כמה הוצאתי על סופר ב-3 החודשים האחרונים?',
  'מה המנויים הקבועים שלי?',
  'כמה הוצאתי החודש לעומת החודש שעבר?',
  'מה ההוצאות הגדולות החודש?',
  'על מה הוצאתי הכי הרבה השנה?',
  'מה היתרה שלי?',
];

// The conversation lives only in memory for this window (never stored, gone on restart). It outlives
// the view, so an answer that arrives after switching screens is there when you come back.
const history = [];
let busy = false;
let repaint = null;   // the mounted view's paint()

export function mountChat(container) {
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'השיחה' });
  const input = h('textarea', {
    class: 'chat-input', rows: '1', maxlength: String(MAX), dir: 'rtl', 'aria-label': 'שאלה על הכסף שלך',
    placeholder: 'למשל: כמה הוצאתי על מסעדות בחודש שעבר?', autocomplete: 'off', spellcheck: 'false',
  });
  const send = h('button', { class: 'btn primary chat-send', type: 'submit', 'aria-label': 'שליחה' }, h('span', null, 'לשאול'), icon('chevron'));
  const form = h('form', { class: 'chat-form', 'aria-label': 'שאלה חדשה' },
    h('span', { class: 'chat-field' }, icon('search', 'ico'), input), send);
  const clearBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('trash'), 'ניקוי השיחה');
  clearBtn.addEventListener('click', () => { history.length = 0; paint(); input.focus(); });

  const view = h('div', { class: 'chat' });
  container.replaceChildren(view);
  setWhere('chat');

  function head() {
    return pageHead('שאלות', 'שאלות בעברית על הכסף שלך. התשובות מחושבות כאן במחשב מהנתונים של Finora, ושום דבר לא יוצא ממנו.',
      history.length ? clearBtn : null);
  }

  function paint(focus = false) {
    send.disabled = busy;
    const msgs = history.length ? history.map(renderMsg) : [intro()];
    log.replaceChildren(...msgs);
    mount(view, head(), h('div', { class: 'page chat-page' }, h('div', { class: 'panel chat-panel' }, log, form)));
    scrollEnd();
    if (focus) input.focus({ preventScroll: true });
  }

  function scrollEnd() {
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  }

  function intro() {
    return h('div', { class: 'chat-intro' },
      h('span', { class: 'empty-ico', 'aria-hidden': 'true' }, icon('search')),
      h('h2', null, 'מה תרצה לדעת?'),
      h('p', null, 'סכומים לפי קטגוריה, בית עסק או תקופה, השוואה לתקופה קודמת, ההוצאות הגדולות, הכנסות, יתרה, חיובים צפויים, חיובים קבועים ומה התייקר. כל תשובה מראה את הסכום המדויק ומקשרת לתנועות.'),
      chips(STARTERS));
  }

  function chips(list) {
    return h('div', { class: 'chat-chips', role: 'group', 'aria-label': 'שאלות לדוגמה' }, list.map((q) => {
      const b = h('button', { class: 'btn small pchip', type: 'button' }, q);
      b.addEventListener('click', () => ask(q));
      return b;
    }));
  }

  function linkBtn(l, cls = 'btn small accent') {
    const b = h('button', { class: cls, type: 'button' }, l.label);
    b.addEventListener('click', () => go(l.section, l.params || {}));
    return b;
  }

  function partsEl(parts) {
    return (parts || []).map((p) => (typeof p === 'string' ? p : money(p.amount, { className: 'chat-amt' })));
  }

  function understoodEl(u) {
    if (!u) return null;
    const tags = [];
    if (u.period) tags.push(`תקופה: ${u.period.label.replace(/^ב-?/, '')}`);
    if (u.comparedTo) tags.push(`לעומת: ${u.comparedTo.label.replace(/^ב-?/, '')}`);
    if (u.category) tags.push(`קטגוריה: ${u.category.name}`);
    if (u.merchant) tags.push(`בית עסק: ${u.merchant}`);
    if (!tags.length) return null;
    return h('div', { class: 'chat-tags', 'aria-label': 'מה הבנתי מהשאלה' }, tags.map((t) => h('span', { class: 'badge' }, t)));
  }

  function itemRow(it) {
    const body = [
      avatarOf(it.label || ''),
      h('span', { class: 'cell-t' }, h('bdi', { class: 'cell-n' }, it.label || ''), it.sub ? h('span', { class: 'cell-sub' }, it.sub) : null),
      typeof it.amount === 'number' ? h('span', { class: 'row-amt' }, money(it.amount)) : h('span'),
    ];
    if (!it.link) return h('div', { class: 'row-btn chat-row', role: 'listitem' }, body);
    const b = h('button', { class: 'row-btn chat-row', type: 'button', title: it.link.label }, body);
    b.addEventListener('click', () => go(it.link.section, it.link.params || {}));
    return h('div', { role: 'listitem' }, b);
  }

  function renderMsg(m) {
    if (m.role === 'user') return h('div', { class: 'chat-me' }, h('div', { class: 'chat-msg me' }, h('span', { class: 'sr-only' }, 'שאלת: '), h('p', null, m.text)));
    if (m.pending) {
      return h('div', { class: 'chat-msg bot', 'aria-busy': 'true' },
        h('span', { class: 'sr-only' }, 'מחשב תשובה…'),
        h('span', { class: 'chat-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')));
    }
    if (m.error) return h('div', { class: 'chat-msg bot is-error', role: 'alert' }, h('p', null, m.error));
    const a = m.answer;
    return h('div', { class: 'chat-msg bot' },
      h('span', { class: 'sr-only' }, 'תשובה: '),
      understoodEl(a.understood),
      h('p', { class: 'chat-text' }, partsEl(a.parts)),
      a.note ? h('p', { class: 'chat-note' }, a.note) : null,
      a.items?.length ? [
        a.itemsTitle ? h('h3', { class: 'chat-sub' }, a.itemsTitle) : null,
        h('div', { class: 'rows chat-rows', role: 'list' }, a.items.map(itemRow)),
      ] : null,
      a.links?.length ? h('div', { class: 'chat-links' }, a.links.map((l) => linkBtn(l))) : null,
      a.suggestions?.length ? chips(a.suggestions) : null);
  }

  async function ask(text) {
    const q = String(text || '').trim().slice(0, MAX);
    if (!q || busy) return;
    busy = true;
    send.disabled = true;
    const done = () => { busy = false; repaint?.(true); };
    input.value = '';
    fit();
    history.push({ role: 'user', text: q });
    const pending = { role: 'bot', pending: true };
    history.push(pending);
    paint();
    try {
      const answer = await api.chat(q);
      Object.assign(pending, { pending: false, answer });
      if (repaint) announce(answer.text);
    } catch (e) {
      Object.assign(pending, { pending: false, error: e.message || 'משהו השתבש. אפשר לנסות שוב.' });
    } finally {
      done();
    }
  }

  function fit() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  input.addEventListener('input', fit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });

  // demo toggled / new sync: earlier answers may be stale; say so instead of silently keeping them
  const offs = [on('data-changed', () => {
    const last = history[history.length - 1];
    if (history.length && !last.notice) {
      history.push({ role: 'bot', notice: true, answer: { parts: ['הנתונים התעדכנו. התשובות שלמעלה חושבו מהנתונים הקודמים.'], items: [], links: [] } });
      paint();
    }
  })];

  repaint = paint;
  paint(true);
  return {
    destroy() { if (repaint === paint) repaint = null; offs.forEach((f) => f()); },
    refresh() { paint(); },
    focusSearch() { input.focus(); },
  };
}
