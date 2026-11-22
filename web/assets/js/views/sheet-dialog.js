// Add a Google Sheets link: pulled now, and again on every open and every "sync now".
import { h, icon, nextId } from '../dom.js';
import { api } from '../api.js';
import { openDialog, toast } from '../layers.js';
import { loadReference, loadStatus, state } from '../store.js';
import { resumeIfRunning } from '../sync.js';

const KINDS = [
  ['signed', 'הסכום כבר עם סימן (הוצאה במינוס)'],
  ['income', 'כל השורות הן הכנסות'],
  ['expense', 'כל השורות הן הוצאות'],
];
const SCOPES = [['business', 'של העסק'], ['private', 'פרטי'], ['mixed', 'מעורב']];

export function openSheetDialog({ onAdded } = {}) {
  const urlId = nextId('sh');
  const url = h('input', { id: urlId, type: 'url', dir: 'ltr', class: 'input', placeholder: 'docs.google.com/spreadsheets/d/…', autocomplete: 'off', spellcheck: 'false', required: true });
  const name = h('input', { type: 'text', class: 'input', maxlength: '40', placeholder: 'למשל: הכנסות 2026' });
  const kind = h('select', { class: 'input' }, KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const scope = h('select', { class: 'input' }, SCOPES.filter(([v]) => state.business?.enabled || v === 'private').map(([v, l]) => h('option', { value: v }, l)));
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const add = h('button', { class: 'btn primary', type: 'button' }, icon('link'), 'לחבר את הגיליון');
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'ביטול');
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);
  const dlg = openDialog({
    title: 'חיבור גיליון Google',
    className: 'sheet-dlg',
    body: [
      h('ol', { class: 'sheet-steps' },
        h('li', null, 'בגיליון: שיתוף ← "כל מי שיש לו את הקישור" ← צופה.'),
        h('li', null, 'מעתיקים את הקישור ומדביקים כאן.')),
      field('קישור לגיליון', url, 'רק קישורים של docs.google.com. אפשר קישור לגיליון מסוים (עם gid=).'),
      field('שם', name),
      field('איך לקרוא את הסכומים', kind, 'אם יש עמודת "הכנסה" ועמודת "הוצאה" נפרדות, הן נקראות לבד.'),
      state.business?.enabled ? field('השורות שייכות ל', scope) : null,
      h('p', { class: 'notice' }, icon('info'), h('span', null,
        'מי שמחזיק בקישור יכול לראות את הגיליון. MoneyCash רק קורא ממנו, ושומר את הקישור מוצפן במחשב שלך. גיליון בלי עמודות תאריך וסכום ישמש לדשבורד בלבד.')),
      err,
    ],
    actions: [add, cancel],
    initialFocus: () => url,
  });
  cancel.addEventListener('click', () => dlg.close());
  add.addEventListener('click', async () => {
    err.hidden = true;
    if (!url.value.trim()) { err.textContent = 'חסר קישור לגיליון.'; err.hidden = false; url.focus(); return; }
    add.disabled = true;
    try {
      const c = await api.addSheet({ nickname: name.value.trim() || undefined,
        sheet: { url: url.value.trim(), kind: kind.value, scope: state.business?.enabled ? scope.value : 'private' } });
      dlg.close();
      toast('הגיליון חובר. הנתונים נמשכים עכשיו.');
      await Promise.all([loadStatus(), loadReference()]);
      resumeIfRunning();
      onAdded?.(c);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      add.disabled = false;
    }
  });
}

/** Replace the link (or how the amounts are read) of a sheet that is already connected. */
export function openSheetLinkDialog(conn) {
  const url = h('input', { type: 'url', dir: 'ltr', class: 'input', placeholder: 'docs.google.com/spreadsheets/d/…', autocomplete: 'off', spellcheck: 'false' });
  // The current setting is sealed with the link and not shown, so "as now" is the default.
  const kind = h('select', { class: 'input' }, [h('option', { value: '' }, 'כמו עכשיו'), ...KINDS.map(([v, l]) => h('option', { value: v }, l))]);
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'button' }, icon('check'), 'שמירה ומשיכה');
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'ביטול');
  const dlg = openDialog({
    title: `הקישור של "${conn.nickname}"`,
    body: [
      h('p', null, 'הקישור הקודם שמור מוצפן ולא מוצג. מדביקים קישור חדש כדי להחליף אותו.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'קישור חדש'), url),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'איך לקרוא את הסכומים'), kind),
      err],
    actions: [save, cancel],
    initialFocus: () => url,
  });
  cancel.addEventListener('click', () => dlg.close());
  save.addEventListener('click', async () => {
    err.hidden = true;
    save.disabled = true;
    try {
      await api.updateConnection(conn.id, { sheet: { url: url.value.trim(), ...(kind.value ? { kind: kind.value } : {}) } });
      dlg.close();
      await loadReference();
      await api.sync(conn.id).catch(() => {});
      resumeIfRunning();
      toast('הקישור הוחלף. הגיליון נמשך מחדש.');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      save.disabled = false;
    }
  });
}
