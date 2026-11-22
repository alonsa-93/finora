// Add-account flow: choose institution → credentials form built from loginFields → saved → offer to sync.
import { h, icon, nextId, avatarOf } from '../dom.js';
import { api } from '../api.js';
import { state, loadReference, loadStatus, emit } from '../store.js';
import { openDialog, toast } from '../layers.js';
import { startSync, resumeIfRunning } from '../sync.js';

let companiesCache = null;

export function trustNote(level = 3) {
  return h('div', { class: 'trust' },
    h(`h${level}`, { class: 'trust-h' }, icon('lock'), 'מה קורה עם פרטי הכניסה'),
    h('ul', null,
      h('li', null, 'הפרטים נשמרים מוצפנים, רק במחשב הזה, ונפתחים רק בחשבון Windows שלך. הם לא נשלחים לשום שרת חוץ מהאתר של הבנק או חברת האשראי עצמם.'),
      h('li', null, 'התוכנה רק קוראת תנועות ויתרות. היא לא יכולה להעביר כסף או לשנות שום דבר בחשבון.'),
      h('li', null, 'הבנקים וחברות האשראי לא תומכים רשמית בגישה אוטומטית כזו. לפעמים הכניסה תיכשל או תבקש אימות נוסף, ואז פשוט מנסים שוב או נכנסים פעם אחת לאתר עצמו.')));
}

/** Inputs for a company's loginFields. clear() wipes values and re-hides passwords. */
function credentialFields(c) {
  const fields = [];
  const rows = [];
  for (const f of c.loginFields || []) {
    const id = nextId('f');
    const input = h('input', { class: 'input', id, type: f.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', dir: 'ltr', required: true, 'aria-required': 'true' });
    input.setAttribute('autocorrect', 'off'); input.setAttribute('autocapitalize', 'off');
    let control = input, eye = null;
    if (f.secret) {
      eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'הצגת הסיסמה', 'aria-pressed': 'false', 'aria-controls': id }, icon('eye'));
      input.classList.remove('input');
      eye.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.setAttribute('aria-pressed', String(show));
        eye.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
        eye.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
      });
      control = h('div', { class: 'input-group pw' }, input, eye);   // the show/hide button sits inside the field
    }
    fields.push({ key: f.key, input, eye });
    rows.push(h('div', { class: 'field' }, h('label', { for: id }, f.label), control));
  }
  const clear = () => {
    for (const f of fields) {
      f.input.value = '';
      if (f.eye) {
        f.input.type = 'password';
        f.eye.setAttribute('aria-pressed', 'false'); f.eye.setAttribute('aria-label', 'הצגת הסיסמה'); f.eye.replaceChildren(icon('eye'));
      }
    }
  };
  return { fields, rows, clear };
}

/** Re-enter credentials (clears "wrong password, retries paused") or rename a connection. */
export async function openEditConnectionDialog(conn) {
  const body = h('div', { class: 'connect' }, h('p', { class: 'muted', role: 'status' }, 'טוען…'));
  const dlg = openDialog({ title: `עדכון פרטי התחברות: ${conn.nickname || conn.companyName}`, body, wide: true, className: 'connect-dlg' });
  try { companiesCache = companiesCache || await api.companies(); } catch (e) {
    body.replaceChildren(h('div', { class: 'state error', role: 'alert' }, h('h3', null, 'לא הצלחנו לטעון את פרטי המוסד'), h('p', null, e.message)));
    return dlg;
  }
  const c = companiesCache.find((x) => x.id === conn.companyId) || { name: conn.companyName, type: conn.type, loginFields: [] };
  const { fields, rows, clear } = credentialFields(c);
  const nick = h('input', { class: 'input', id: nextId('f'), type: 'text', maxlength: '40', value: conn.nickname || '', autocomplete: 'off' });
  const err = h('p', { class: 'error-text', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'שמירה');
  const cancel = h('button', { class: 'btn', type: 'button' }, 'ביטול');
  cancel.addEventListener('click', () => dlg.close());
  const form = h('form', { class: 'co-form', autocomplete: 'off', novalidate: true },
    conn.lastError ? h('p', { class: 'insp-note' }, conn.lastError) : null,
    h('div', { class: 'field' }, h('label', { for: nick.id }, 'שם לחיבור'), nick),
    h('p', { class: 'hint' }, 'כדי לעדכן את פרטי הכניסה ממלאים את כל השדות. כדי לשנות רק את השם, משאירים אותם ריקים.'),
    rows, err,
    h('div', { class: 'co-actions' }, save, cancel));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const filled = fields.filter((f) => f.input.value.trim());
    if (filled.length && filled.length < fields.length) {
      const miss = fields.find((f) => !f.input.value.trim());
      err.textContent = 'כדי לעדכן פרטי כניסה צריך למלא את כל השדות.'; miss.input.focus(); return;
    }
    const patch = {};
    if (nick.value.trim() !== (conn.nickname || '')) patch.nickname = nick.value.trim();
    if (filled.length) patch.credentials = Object.fromEntries(fields.map((f) => [f.key, f.input.value]));
    clear();
    if (!Object.keys(patch).length) { dlg.close(); return; }
    save.disabled = true; save.textContent = 'שומר…';
    try {
      await api.updateConnection(conn.id, patch);
      await Promise.all([loadReference(), loadStatus()]);
      dlg.close();
      toast(patch.credentials ? 'פרטי ההתחברות עודכנו. אפשר לסנכרן שוב.' : 'השם עודכן.', patch.credentials ? { action: { label: 'לסנכרן עכשיו', onSelect: () => startSync(conn.id) } } : {});
    } catch (ex) {
      err.textContent = patch.credentials ? `${ex.message} הפרטים נמחקו מהטופס.` : ex.message;
      save.disabled = false; save.textContent = 'שמירה';
    }
  });
  body.replaceChildren(form);
  (fields[0]?.input || nick).focus();
  return dlg;
}

export async function openConnectDialog() {
  let step = 'pick';
  const body = h('div', { class: 'connect' });
  const dlg = openDialog({ title: 'חיבור בנק או כרטיס אשראי', body, wide: true, className: 'connect-dlg' });

  async function showPick() {
    step = 'pick';
    body.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'טוען את רשימת הבנקים וחברות האשראי…'));
    try {
      companiesCache = companiesCache || await api.companies();
    } catch (e) {
      const retry = h('button', { class: 'btn', type: 'button' }, 'לנסות שוב');
      retry.addEventListener('click', showPick);
      body.replaceChildren(h('div', { class: 'state error', role: 'alert' }, h('h3', null, 'לא הצלחנו לטעון את הרשימה'), h('p', null, e.message), retry));
      return;
    }
    const q = h('input', { type: 'search', placeholder: 'חיפוש: פועלים, לאומי, מקס, כאל…', 'aria-label': 'חיפוש מוסד', autocomplete: 'off' });
    const qField = h('label', { class: 'pill-field co-search' }, icon('search'), q);
    const lists = h('div', { class: 'co-lists' });
    const paint = () => {
      const needle = q.value.trim();
      const match = (c) => !needle || c.name.includes(needle) || c.id.toLowerCase().includes(needle.toLowerCase());
      const group = (type, title) => {
        const cos = companiesCache.filter((c) => c.type === type && match(c));
        const id = nextId('co');
        return h('section', { class: 'co-group', 'aria-labelledby': id },
          h('h3', { id }, title),
          cos.length ? h('ul', { class: 'rows' }, cos.map((c) => h('li', null, coButton(c)))) : h('p', { class: 'empty-line' }, 'אין התאמות'));
      };
      lists.replaceChildren(group('bank', 'בנקים'), group('card', 'כרטיסי אשראי'));
    };
    q.addEventListener('input', paint);
    q.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); lists.querySelector('button:not([disabled])')?.focus(); } });
    lists.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const btns = [...lists.querySelectorAll('button:not([disabled])')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0) q.focus(); else btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
    paint();
    body.replaceChildren(h('p', null, 'בוחרים את הבנק או חברת האשראי, ואז מזינים את אותם פרטים שמשמשים לכניסה לאתר שלהם.'), qField, lists);
    q.focus();
  }

  function coButton(c) {
    const b = h('button', { class: 'row-btn co-btn', type: 'button', disabled: !c.supported },
      avatarOf(c.name, { size: 'av-sm' }),
      h('span', { class: 'cell-t' }, h('span', { class: 'cell-n co-name' }, c.name), !c.supported ? h('span', { class: 'cell-sub co-note' }, c.note || 'לא נתמך כרגע') : null),
      c.supported ? icon('chevron') : h('span', { 'aria-hidden': 'true' }));
    b.addEventListener('click', () => showForm(c));
    return b;
  }

  function showForm(c) {
    step = 'form';
    const { fields, rows: credRows, clear } = credentialFields(c);
    const nick = h('input', { class: 'input', id: nextId('f'), type: 'text', maxlength: '40', placeholder: c.name, autocomplete: 'off' });
    const rows = [h('div', { class: 'field' }, h('label', { for: nick.id }, 'שם לחיבור (לא חובה)'), nick, h('span', { class: 'hint' }, 'כך החיבור יופיע ברשימות, למשל "העו״ש המשותף".')), ...credRows];
    const err = h('p', { class: 'error-text', role: 'alert' });
    const back = h('button', { class: 'btn', type: 'button' }, 'חזרה לרשימה');
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'שמירת החיבור');
    back.addEventListener('click', showPick);
    const form = h('form', { class: 'co-form', autocomplete: 'off', novalidate: true },
      h('div', { class: 'co-form-head' }, h('h3', null, c.name), h('span', { class: 'muted' }, c.type === 'bank' ? 'בנק' : 'כרטיס אשראי')),
      rows, err, trustNote(),
      h('div', { class: 'co-actions' }, save, back));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const missing = fields.find((f) => !f.input.value.trim());
      for (const f of fields) f.input.setAttribute('aria-invalid', String(!f.input.value.trim()));
      if (missing) { err.textContent = 'צריך למלא את כל השדות.'; missing.input.focus(); return; }
      const credentials = Object.fromEntries(fields.map((f) => [f.key, f.input.value]));
      clear();   // nothing stays in the page after submit
      save.disabled = true; save.textContent = 'שומר…'; save.setAttribute('aria-busy', 'true');
      try {
        const conn = await api.addConnection({ companyId: c.id, nickname: nick.value.trim() || undefined, credentials });
        await Promise.all([loadReference(), loadStatus()]);
        emit('data-changed');
        resumeIfRunning();   // the server may start the first sync by itself
        showDone(conn, c);
      } catch (ex) {
        err.textContent = `${ex.message} הפרטים נמחקו מהטופס, צריך להזין אותם שוב.`;
        save.disabled = false; save.textContent = 'שמירת החיבור'; save.removeAttribute('aria-busy');
        fields[0]?.input.focus();
      }
    });
    body.replaceChildren(form);
    (fields[0]?.input || nick).focus();
  }

  function showDone(conn, c) {
    step = 'done';
    const demo = state.status?.demoMode;
    const syncNow = h('button', { class: 'btn primary', type: 'button' }, icon('sync'), demo ? 'לצאת מההדגמה ולסנכרן' : 'לסנכרן עכשיו');
    const later = h('button', { class: 'btn', type: 'button' }, 'אחר כך');
    syncNow.addEventListener('click', async () => {
      syncNow.disabled = true;
      try {
        if (demo) { await api.setDemo(false); await Promise.all([loadStatus(), loadReference()]); emit('data-changed'); }
        dlg.close();
        startSync(conn?.id);
      } catch (e) { toast(e.message, { kind: 'error' }); syncNow.disabled = false; }
    });
    later.addEventListener('click', () => dlg.close());
    body.replaceChildren(h('div', { class: 'co-done' },
      h('h3', null, icon('check'), `החיבור ל${c.name} נשמר`),
      h('p', null, 'הסנכרון הראשון מושך תנועות מהחודשים האחרונים ולוקח בדרך כלל דקה או שתיים. אפשר להמשיך לעבוד בזמן שהוא רץ.'),
      demo ? h('p', { class: 'insp-note' }, 'כרגע מוצגים נתוני הדגמה. כדי לראות את הנתונים האמיתיים צריך לצאת ממצב ההדגמה.') : null,
      h('div', { class: 'co-actions' }, syncNow, later)));
    syncNow.focus();
  }

  showPick();
  return dlg;
}
