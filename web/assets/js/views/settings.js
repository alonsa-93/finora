// חשבונות והגדרות: connections with status and per-connection sync, auto-sync, demo mode, theme, trust note.
import { h, icon, sevGlyph, mount, nextId, avatarOf } from '../dom.js';
import { selectBox } from '../listbox.js';
import { emptyState, pageHead } from './common.js';
import { api } from '../api.js';
import { state, on, loadStatus, loadReference, emit } from '../store.js';
import { setWhere } from '../shell.js';
import { confirmDialog, toast, announce, openDialog } from '../layers.js';
import { startSync } from '../sync.js';
import { themePref, setTheme, THEME_LABEL } from '../theme.js';
import { relativeTime, dateTime } from '../format.js';
import { openConnectDialog, openEditConnectionDialog, trustNote } from './connect.js';
import { openShortcuts } from '../keys.js';
import { openSheetDialog, openSheetLinkDialog } from './sheet-dialog.js';
import { loadBusiness } from '../store.js';
import { go } from '../router.js';

export function mountSettings(container, params) {
  setWhere('settings');
  const view = h('div', { class: 'st' });
  container.replaceChildren(view);
  let wantFocus = null;   // focus key of a row control to return to once it is enabled again
  let lastSig = '';       // the rows are rebuilt only when this changes (not on every progress tick)
  const connBody = h('div', { tabindex: '-1', class: 'st-conn-body', 'aria-label': 'רשימת החיבורים' });
  const offs = [];

  function render() {
    mount(view,
      pageHead('חשבונות והגדרות', 'החיבורים לבנקים ולכרטיסים, הסנכרון האוטומטי והמראה'),
      h('div', { class: 'page st-pad' },
        connectionsSection(),
        businessSection(),
        autoSyncSection(),
        demoSection(),
        desktopSection(),
        themeSection(),
        aboutSection(),
        dangerSection()));
    paintConnections();
  }

  /** A settings section: title and a plain explanation on the start side, the controls beside it. */
  function section(id, title, desc, ...content) {
    return h('section', { class: 'st-sec', 'aria-labelledby': id },
      h('div', { class: 'st-side' }, h('h2', { id }, title), desc ? h('p', { class: 'st-desc' }, desc) : null),
      h('div', { class: 'st-main' }, content));
  }

  /* ---------- connections ---------- */
  function connectionsSection() {
    const add = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), 'חיבור בנק או כרטיס');
    add.addEventListener('click', () => openConnectDialog());
    const syncAll = h('button', { class: 'btn', type: 'button' }, icon('sync'), 'סנכרון של הכול');
    syncAll.addEventListener('click', () => startSync());
    syncAll.dataset.role = 'sync-all';
    return section('st-conn', 'חיבורים', 'הבנקים וכרטיסי האשראי שהתוכנה מושכת מהם תנועות. פרטי הכניסה נשמרים מוצפנים במחשב הזה בלבד.',
      h('div', { class: 'st-tools' }, add,
        h('button', { class: 'btn', type: 'button', onclick: () => openSheetDialog() }, icon('link'), 'גיליון Google'), syncAll),
      state.status?.demoMode ? h('p', { class: 'st-demo-note' }, 'מוצגים כרגע חיבורי הדגמה. חשבון אמיתי שתחבר יישמר בנפרד ויופיע אחרי יציאה ממצב ההדגמה.') : null,
      connBody,
      h('details', { class: 'st-trust' }, h('summary', null, 'איך החיבור עובד ומה עם האבטחה'), trustNote()));
  }

  function paintConnections() {
    const running = Boolean(state.sync?.running);
    const syncAll = view.querySelector('[data-role="sync-all"]');
    // A sync request while one runs joins it (the server queues it), so the button stays usable.
    if (syncAll) { syncAll.disabled = !state.connections.length; syncAll.lastChild.textContent = 'סנכרון של הכול'; }
    if (!state.connections.length) {
      lastSig = '';
      mount(connBody, emptyState({ icon: 'bank', title: 'אין עדיין חיבורים', text: 'מחברים בנק או כרטיס אשראי, ו-MoneyCash מושך את התנועות ומסדר אותן.', small: true, level: 3 }));
      return;
    }
    const items = new Map((state.sync?.items || []).map((i) => [i.connectionId, i]));
    // Rebuilding the table every second (each sync poll) swallowed clicks: a button pressed during a
    // rebuild was gone before the click finished. Rows are rebuilt only when something other than a
    // progress message changed; a new progress message is written into its row in place.
    const sig = JSON.stringify([running, Boolean(state.status?.demoMode),
      state.connections.map((c) => [c.id, c.nickname, c.lastStatus, c.lastError, c.lastSyncAt, c.needsCodeLogin]),
      [...items.values()].map((i) => [i.connectionId, i.state, i.newTransactions])]);
    if (sig === lastSig && connBody.querySelector('table')) {
      for (const el of connBody.querySelectorAll('[data-live-msg]')) {
        const msg = items.get(Number(el.dataset.liveMsg))?.message;
        if (msg && el.textContent !== msg) el.textContent = msg;
      }
      return;
    }
    lastSig = sig;
    // Rows rebuilt: keep keyboard focus on the same control (or the table while it is disabled).
    const inside = connBody.contains(document.activeElement);
    if (inside && document.activeElement.dataset.focusKey) wantFocus = document.activeElement.dataset.focusKey;
    else if (!inside) wantFocus = null;
    queueMicrotask(() => {
      if (!wantFocus) return;
      const el = connBody.querySelector(`[data-focus-key="${CSS.escape(wantFocus)}"]`);
      if (el && !el.disabled) { el.focus(); wantFocus = null; } else connBody.focus({ preventScroll: true });
    });
    mount(connBody, h('table', { class: 'grid-table st-table', 'aria-label': 'חיבורים' },
      h('thead', null, h('tr', null, h('th', { class: 'th-av' }, 'חיבור'), h('th', null, 'סוג'), h('th', null, 'מצב'), h('th', null, 'סנכרון אחרון'), h('th', { class: 'end' }, h('span', { class: 'sr-only' }, 'פעולות')))),
      h('tbody', null, state.connections.map((c) => connRow(c, items.get(c.id), running)))));
  }

  function connRow(c, live, running) {
    let status;
    if (live && running && (live.state === 'running' || live.state === 'pending')) {
      status = h('span', { class: 'cs running' }, icon('sync'),
        h('span', { dataset: { liveMsg: String(c.id) } }, live.message || (live.state === 'pending' ? 'ממתין בתור' : 'מתחבר…')));
    } else if (live && live.state === 'error' && (running || c.lastStatus === 'error')) {
      // A finished sync's error stays in state.sync; once the connection is fixed (credentials
      // re-saved → lastStatus "never") the stale item must not keep showing "failed".
      status = h('span', { class: 'cs error' }, h('span', { class: 'sev', dataset: { sev: 'alert' } }, sevGlyph('alert'), 'נכשל'), h('span', { class: 'cs-msg' }, live.message || c.lastError || ''));
    } else if (c.lastStatus === 'error') {
      status = h('span', { class: 'cs error' }, h('span', { class: 'sev', dataset: { sev: 'alert' } }, sevGlyph('alert'), 'נכשל'), h('span', { class: 'cs-msg' }, c.lastError || 'הסנכרון האחרון נכשל.'));
    } else if (c.lastStatus === 'ok') {
      status = h('span', { class: 'cs ok' }, h('span', { class: 'sev', dataset: { sev: 'good' } }, sevGlyph('good'), 'תקין'),
        live && live.state === 'ok' && live.newTransactions > 0 ? h('span', { class: 'cs-msg' }, `נוספו ${live.newTransactions} תנועות`) : null);
    } else {
      status = h('span', { class: 'cs never' }, 'עוד לא סונכרן');
    }
    // Only the connection being scraped right now is locked; the others can be synced (they join the
    // queue), edited or removed while it runs.
    const busy = running && live?.state === 'running';
    const queued = running && live?.state === 'pending';
    const syncBtn = h('button', { class: 'btn small', type: 'button', disabled: busy || queued, dataset: { focusKey: `sync-${c.id}` }, 'aria-label': `סנכרון ${c.nickname || c.companyName}` },
      icon('sync'), busy ? 'מסתנכרן…' : queued ? 'בתור' : 'סנכרון');
    syncBtn.addEventListener('click', () => startSync(c.id));
    const rm = h('button', { class: 'btn small ghost danger', type: 'button', disabled: busy, dataset: { focusKey: `rm-${c.id}` }, 'aria-label': `הסרת ${c.nickname || c.companyName}` }, icon('trash'), 'הסרה');
    rm.addEventListener('click', () => removeConnection(c));
    const failed = c.lastStatus === 'error' || (running && live?.state === 'error');
    const edit = h('button', { class: ['btn small', failed ? '' : 'ghost'], type: 'button', disabled: busy, dataset: { focusKey: `edit-${c.id}` }, 'aria-label': `עדכון פרטי ההתחברות של ${c.nickname || c.companyName}` },
      icon('lock'), failed ? 'עדכון פרטי התחברות' : 'עריכה');
    edit.addEventListener('click', () => (c.companyId === 'gsheet' ? openSheetLinkDialog(c) : openEditConnectionDialog(c)));
    let codeBtn = null;
    if (c.needsCodeLogin && !state.status?.demoMode) {
      codeBtn = h('button', { class: 'btn small primary', type: 'button', disabled: running, dataset: { focusKey: `code-${c.id}` }, 'aria-label': `התחברות עם קוד SMS ל${c.nickname || c.companyName}` }, icon('lock'), 'התחברות עם קוד');
      codeBtn.addEventListener('click', () => codeLogin(c));
    }
    return h('tr', null,
      h('td', { class: 'wrap' }, h('div', { class: 'cell-m' }, avatarOf(c.companyName, { iconName: c.type === 'bank' ? 'bank' : 'card' }),
        h('span', { class: 'cell-t' }, h('span', { class: 'cell-n' }, c.nickname || c.companyName), c.nickname && c.nickname !== c.companyName ? h('span', { class: 'cell-sub' }, c.companyName) : null))),
      h('td', null, c.companyId === 'gsheet' ? 'גיליון Google' : c.type === 'bank' ? 'בנק' : 'כרטיס אשראי'),
      h('td', { class: 'wrap' }, status),
      h('td', { title: c.lastSyncAt ? dateTime(c.lastSyncAt) : '' }, relativeTime(c.lastSyncAt) || 'אף פעם'),
      h('td', { class: 'end' }, h('span', { class: 'row-actions' }, state.status?.demoMode ? [syncBtn, rm]
        : codeBtn ? [codeBtn, edit, rm] : [failed ? edit : syncBtn, failed ? syncBtn : edit, rm])));
  }

  // The site asked for a one-time code: one login in a visible window of the site itself, where the
  // user types the code. MoneyCash never sees the code.
  async function codeLogin(c) {
    const ok = await confirmDialog({
      title: 'התחברות עם קוד SMS',
      message: `ייפתח חלון של האתר של ${c.companyName}. MoneyCash ימלא בו את שם המשתמש והסיסמה, ואז תקבל קוד ב-SMS. הקלד את הקוד בחלון של האתר, לא כאן. כשההתחברות תסתיים החלון ייסגר והתנועות יורדו. יש לך 5 דקות.`,
      extra: h('p', { class: 'insp-note' }, 'אם החלון לא קופץ, הוא בשורת המשימות. אחרי התחברות אחת כזו האתר בדרך כלל מזהה את המחשב, והסנכרון האוטומטי חוזר לעבוד בלי קוד.'),
      confirmLabel: 'לפתוח את החלון',
    });
    if (ok) startSync(c.id, { interactive: true });
  }

  async function removeConnection(c) {
    const name = nextId('rm');
    const keep = h('input', { type: 'radio', name, value: 'keep', checked: true });
    const del = h('input', { type: 'radio', name, value: 'delete' });
    const extra = h('fieldset', { class: 'rm-choice' },
      h('legend', null, 'מה לעשות עם התנועות שכבר נמשכו?'),
      h('label', { class: 'check' }, keep, 'להשאיר אותן (הן יישארו בסיכומים ובהיסטוריה)'),
      h('label', { class: 'check' }, del, 'למחוק אותן לגמרי מהמחשב'));
    const ok = await confirmDialog({
      title: `הסרת ${c.nickname || c.companyName}`,
      message: 'פרטי הכניסה יימחקו מהמחשב, ולא יימשכו יותר תנועות מהחיבור הזה.',
      confirmLabel: 'הסרת החיבור', danger: true, extra,
    });
    if (!ok) return;
    try {
      await api.removeConnection(c.id, del.checked);
      await Promise.all([loadReference(), loadStatus()]);
      emit('data-changed');
      toast(del.checked ? 'החיבור והתנועות שלו נמחקו.' : 'החיבור הוסר. התנועות שנמשכו נשארו.');
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  /* ---------- auto sync ---------- */
  /* ---------- business mode ---------- */
  const TYPES = [['exempt', 'עוסק פטור'], ['licensed', 'עוסק מורשה'], ['company', 'חברה בע"מ']];
  const PERIODS = [['bimonthly', 'דו-חודשי'], ['monthly', 'חודשי']];
  const SCOPE_CHOICES = [['business', 'עסק'], ['private', 'פרטי'], ['mixed', 'מעורב']];
  function businessSection() {
    const b = state.business || { enabled: false };
    const msg = h('span', { class: 'hint', 'aria-live': 'polite' });
    const save = async (patch, okText) => {
      try {
        await api.saveBusiness(patch);
        await loadBusiness();
        emit('data-changed');
        msg.textContent = okText || 'נשמר.';
      } catch (e) { msg.textContent = e.message; }
    };
    const en = h('input', { type: 'checkbox', role: 'switch', checked: Boolean(b.enabled) });
    en.addEventListener('change', async () => { await save({ enabled: en.checked }, en.checked ? 'מצב עסק פועל. בחר למטה איזה חשבון שייך לעסק.' : 'מצב עסק כבוי.'); render(); });
    const desc = 'לבעלי עסק: כל מספר מוצג לעסק בנפרד, לפרטי בנפרד, וגם ביחד. מע"מ, הפרשה למס, ומה עובר מהעסק הביתה.';
    if (!b.enabled) {
      return section('st-biz', 'מצב עסק', desc, h('label', { class: 'switch' }, en, 'יש לי עסק (עוסק פטור, מורשה או חברה)'), msg);
    }
    const sel = (opts, val, key) => {
      const el = h('select', { class: 'input' }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
      el.addEventListener('change', () => save({ [key]: el.value }).then(render));
      return el;
    };
    const numIn = (val, key, { min, max, step = 1 }) => {
      const el = h('input', { class: 'input num-in', type: 'number', min: String(min), max: String(max), step: String(step), value: String(val ?? 0), dir: 'ltr' });
      el.addEventListener('change', () => {
        const n = Number(el.value);
        if (Number.isFinite(n) && n >= min && n <= max) save({ [key]: n }); else msg.textContent = `ערך בין ${min} ל-${max}.`;
      });
      return el;
    };
    const name = h('input', { class: 'input', type: 'text', maxlength: '60', value: b.name || '', placeholder: 'שם העסק (לא חובה)' });
    name.addEventListener('change', () => save({ name: name.value }));
    const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);
    const scopeRow = (a) => h('tr', null,
      h('td', { class: 'wrap' }, h('div', { class: 'cell-m' }, avatarOf(a.companyName, { iconName: a.type === 'bank' ? 'bank' : 'card' }),
        h('span', { class: 'cell-t' }, h('span', { class: 'cell-n' }, h('bdi', null, a.name)), h('span', { class: 'cell-sub' }, a.companyId === 'gsheet' ? 'גיליון' : a.type === 'bank' ? 'חשבון' : 'כרטיס אשראי')))),
      h('td', { class: 'end' }, h('div', { class: 'seg', role: 'radiogroup', 'aria-label': `${a.name}: של מי` }, SCOPE_CHOICES.map(([v, l]) => {
        const on = (a.scope || 'private') === v;
        const btn = h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : null, dataset: { focusKey: `scope-${a.id}-${v}` } }, l);
        btn.addEventListener('click', async () => {
          if (on) return;
          try {
            await api.setAccountScope(a.id, v);
            await loadReference();
            emit('data-changed');
            render();
            msg.textContent = `${a.name}: ${l}.`;
            view.querySelector(`[data-focus-key="scope-${a.id}-${v}"]`)?.focus();
          } catch (e) { msg.textContent = e.message; }
        });
        return btn;
      }))));
    return section('st-biz', 'מצב עסק', desc,
      h('label', { class: 'switch' }, en, 'מצב עסק פועל'),
      h('div', { class: 'st-biz-grid' },
        field('שם העסק', name),
        field('סוג העסק', sel(TYPES, b.type, 'type')),
        b.type !== 'exempt' ? field('דיווח מע"מ', sel(PERIODS, b.vatPeriod, 'vatPeriod')) : null,
        field('הפרשה למס הכנסה, % מהרווח', numIn(b.setAsidePct, 'setAsidePct', { min: 0, max: 60, step: 0.5 }), 'כמה לשים בצד מכל שקל רווח. רואה החשבון יודע לומר את המספר שלך.'),
        field(`מקדמות מס ששילמת ב-${new Date().getFullYear()} (₪)`, numIn(b.taxPaidYtd, 'taxPaidYtd', { min: 0, max: 1e8 }), 'מקדמות שירדו מחשבון העסק נספרות לבד.')),
      h('h3', { class: 'st-h3' }, 'של מי כל חשבון'),
      h('p', { class: 'st-sub-desc' }, 'עסק: כל התנועות שלו עסקיות. פרטי: כולן פרטיות. מעורב: פרטיות, עד שמסמנים תנועה כעסקית (בתנועה עצמה, ואפשר "תמיד לבית העסק הזה").'),
      state.accounts.length ? h('table', { class: 'grid-table st-table', 'aria-label': 'שיוך חשבונות' }, h('tbody', null, state.accounts.map(scopeRow)))
        : h('p', { class: 'muted' }, 'אין עדיין חשבונות.'),
      msg,
      h('div', { class: 'st-tools' }, h('button', { class: 'btn', type: 'button', onclick: () => go('business') }, icon('briefcase'), 'למסך העסק')));
  }

  function autoSyncSection() {
    const a = state.status?.autoSync || { enabled: false, time: '07:00' };
    const en = h('input', { type: 'checkbox', role: 'switch', checked: a.enabled });
    // The time: the app's own listbox (every 15 minutes, type "07" to jump), not the OS time field.
    const pad = (n) => String(n).padStart(2, '0');
    const times = [];
    for (let m = 0; m < 24 * 60; m += 15) times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    const cur = a.time || '07:00';
    if (!times.includes(cur)) { times.push(cur); times.sort(); }
    const msg = h('span', { class: 'hint', 'aria-live': 'polite' });
    let timeValue = cur;
    const save = async () => {
      time.setDisabled(!en.checked);
      try {
        state.status = await api.saveSettings({ autoSync: { enabled: en.checked, time: timeValue || '07:00' } });
        emit('status', state.status);
        msg.textContent = en.checked ? `נשמר. הסנכרון ירוץ כל יום ב-${timeValue}.` : 'נשמר. הסנכרון האוטומטי כבוי.';
      } catch (e) { msg.textContent = e.message; }
    };
    const time = selectBox({ label: 'שעת הסנכרון היומי', icon: 'clock', className: 'st-time', options: times.map((t) => ({ value: t, label: t })), value: cur, onChange: (v) => { timeValue = v; save(); } });
    time.setDisabled(!a.enabled);
    en.addEventListener('change', save);
    // Sync on open (server/opensync.js): on launch, and when the window returns after 30+ minutes hidden.
    const onOpen = h('input', { type: 'checkbox', role: 'switch', checked: state.status?.syncOnOpen !== false, 'aria-describedby': 'st-open-desc' });
    const openMsg = h('span', { class: 'hint', 'aria-live': 'polite' });
    onOpen.addEventListener('change', async () => {
      try {
        state.status = await api.saveSettings({ syncOnOpen: onOpen.checked });
        emit('status', state.status);
        openMsg.textContent = onOpen.checked ? 'נשמר. התוכנה תתעדכן מיד כשתיפתח.' : 'נשמר. בפתיחה לא יופעל סנכרון.';
      } catch (e) { onOpen.checked = !onOpen.checked; openMsg.textContent = e.message; }
    });
    return section('st-auto', 'סנכרון אוטומטי', 'הסנכרון רץ רק כשהתוכנה פתוחה. אם המחשב היה כבוי, הוא ירוץ זמן קצר אחרי שתפתח אותה.',
      h('div', { class: 'st-line' },
        h('label', { class: 'switch' }, en, 'לסנכרן כל יום'),
        h('span', { class: 'muted', 'aria-hidden': 'true' }, 'בשעה'), time.el),
      msg,
      h('label', { class: 'switch' }, onOpen, 'סנכרון אוטומטי בפתיחת התוכנה'),
      h('p', { class: 'st-sub-desc', id: 'st-open-desc' }, 'כשהתוכנה נפתחת, או חוזרת מהמגש אחרי יותר מחצי שעה, היא מושכת תנועות חדשות מיד. לא ירוץ אם כבר היה סנכרון בחצי השעה האחרונה, ולא ינסה שוב חיבור שהושהה אחרי כניסות שנכשלו.'),
      openMsg);
  }

  /* ---------- demo ---------- */
  function demoSection() {
    // Only before the first real connection: afterwards the real data is always shown.
    if (state.status?.hasConnections) return null;
    const en = h('input', { type: 'checkbox', role: 'switch', checked: Boolean(state.status?.demoMode) });
    en.addEventListener('change', async () => {
      en.disabled = true;
      try {
        state.status = await api.setDemo(en.checked);
        await loadReference();
        emit('status', state.status);
        emit('data-changed');
        announce(en.checked ? 'מצב הדגמה הופעל' : 'מצב הדגמה כובה');
        render();
      } catch (e) { toast(e.message, { kind: 'error' }); en.checked = !en.checked; }
      en.disabled = false;
    });
    return section('st-demo', 'מצב הדגמה', 'נתוני ההדגמה נשמרים בנפרד. הפעלה או כיבוי לא נוגעים בנתונים האמיתיים.',
      h('label', { class: 'switch' }, en, 'להציג נתוני הדגמה במקום הנתונים שלי'));
  }

  /* ---------- desktop app (Electron only) ---------- */
  function desktopSection() {
    const ds = window.moneycash?.settings;
    if (!window.moneycash?.isDesktop || !ds?.get) return null;
    const tray = h('input', { type: 'checkbox', role: 'switch', disabled: true });
    const login = h('input', { type: 'checkbox', role: 'switch', disabled: true });
    const msg = h('span', { class: 'hint', 'aria-live': 'polite' });
    Promise.resolve(ds.get()).then((v) => {
      tray.checked = Boolean(v?.closeToTray); login.checked = Boolean(v?.openAtLogin);
      tray.disabled = false; login.disabled = false;
    }).catch(() => { msg.textContent = 'לא הצלחנו לקרוא את הגדרות החלון.'; });
    const save = (key, el) => async () => {
      try { await ds.set({ [key]: el.checked }); msg.textContent = 'נשמר.'; }
      catch { el.checked = !el.checked; msg.textContent = 'לא הצלחנו לשמור.'; }
    };
    tray.addEventListener('change', save('closeToTray', tray));
    login.addEventListener('change', save('openAtLogin', login));
    return section('st-desk', 'התוכנה ב-Windows', 'במגש התוכנה ממשיכה לרוץ ברקע, כך שהסנכרון היומי יכול לפעול גם כשהחלון סגור.',
      h('label', { class: 'switch' }, tray, 'מזער למגש בסגירה'),
      h('label', { class: 'switch' }, login, 'הפעל עם Windows'),
      msg);
  }

  /* ---------- theme ---------- */
  function themeSection() {
    const name = nextId('theme');
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'ערכת צבעים' },
      ['system', 'light', 'dark'].map((v) => h('label', null, h('input', { type: 'radio', name, value: v, checked: themePref() === v }), THEME_LABEL[v])));
    seg.addEventListener('change', (e) => setTheme(e.target.value));
    return section('st-theme', 'מראה', 'בהיר, כהה, או לפי מה שמוגדר ב-Windows. אפשר להחליף גם מלוח הפקודות.', seg);
  }

  function aboutSection() {
    const keys = h('button', { class: 'link', type: 'button' }, 'קיצורי מקלדת');
    keys.addEventListener('click', openShortcuts);
    return section('st-about', 'על התוכנה', null,
      h('p', { class: 'st-about-line' }, 'גרסה ', h('bdi', { class: 'num' }, state.status?.version || window.moneycash?.version || ''), ' של MoneyCash. כל הנתונים נשמרים במחשב הזה בלבד, מוצפנים.'),
      state.status?.diskEncryption === 'off'
        ? h('p', { class: 'st-demo-note st-disk-note' }, 'הצפנת הכונן (BitLocker או "הצפנת מכשיר") כבויה במחשב הזה. הנתונים של MoneyCash מוצפנים בכל מקרה, אבל כדאי להפעיל אותה דרך הגדרות Windows ← פרטיות ואבטחה ← הצפנת מכשיר, כדי להגן גם על שאר הקבצים אם המחשב יאבד.')
        : null,
      keys);
  }

  /* ---------- danger zone: delete everything ---------- */
  function dangerSection() {
    const btn = h('button', { class: 'btn danger', type: 'button', dataset: { focusKey: 'wipe' } }, icon('trash'), 'מחיקת כל הנתונים');
    btn.addEventListener('click', openWipeDialog);
    return h('section', { class: 'st-sec st-danger', 'aria-labelledby': 'st-danger' },
      h('div', { class: 'st-side' }, h('h2', { id: 'st-danger' }, 'אזור מסוכן'),
        h('p', { class: 'st-desc' }, 'מחיקה מלאה של כל מה ש-MoneyCash שמר במחשב הזה. אי אפשר לבטל אותה.')),
      h('div', { class: 'st-main' }, btn));
  }

  function openWipeDialog() {
    const WORD = 'מחק';
    const inputId = nextId('wipe');
    const hintId = nextId('wipe-hint');
    const input = h('input', { class: 'input', id: inputId, type: 'text', autocomplete: 'off', spellcheck: 'false', dir: 'rtl', 'aria-describedby': hintId });
    const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
    const go = h('button', { class: 'btn danger solid', type: 'button', disabled: true }, 'למחוק הכול');
    const cancel = h('button', { class: 'btn', type: 'button' }, 'ביטול');
    const exportLink = h('a', { class: 'btn', href: api.exportUrl(), download: '' }, icon('download'), 'ייצוא כל התנועות ל-CSV');
    const body = h('div', { class: 'wipe-body' },
      h('p', null, 'הפעולה מוחקת מהמחשב הזה:'),
      h('ul', { class: 'wipe-list' },
        h('li', null, 'את כל התנועות, החשבונות והיתרות, גם של מצב ההדגמה'),
        h('li', null, 'את כל החיבורים לבנקים ולכרטיסים, כולל פרטי ההתחברות המוצפנים'),
        h('li', null, 'את כללי הקטגוריות שלימדת את התוכנה'),
        h('li', null, 'את מפתח ההצפנה, כך שגם עותקים ישנים בגיבוי או בנקודות שחזור לא ייפתחו'),
        h('li', null, 'את יומני הפעילות, הגדרות החלון והמטמון של התוכנה'),
        h('li', null, 'את ההפעלה האוטומטית עם Windows')),
      h('p', { class: 'muted' }, 'קובצי CSV שייצאת בעבר לא נמחקים, כי הם כבר לא בשליטת התוכנה. אחרי המחיקה התוכנה תיפתח מחדש כמו בהתקנה חדשה, ואפשר יהיה לחבר שוב את החשבונות (המשיכה מביאה כ-12 חודשים אחורה).'),
      h('div', { class: 'wipe-export' }, h('p', null, 'רוצה לשמור עותק לפני המחיקה?'), exportLink,
        h('p', { class: 'muted small' }, 'הקובץ לא מוצפן. כדאי לשמור אותו בתיקייה שלא מסונכרנת לענן.')),
      h('label', { for: inputId, class: 'wipe-label' }, 'כדי לאשר, הקלד ', h('strong', null, WORD)),
      input,
      h('p', { id: hintId, class: 'muted small' }, 'הכפתור יופעל רק אחרי שהמילה תוקלד בדיוק.'),
      msg);
    const dlg = openDialog({ title: 'מחיקת כל הנתונים', role: 'alertdialog', body, actions: [go, cancel], initialFocus: () => cancel, className: 'wipe-dlg' });
    cancel.addEventListener('click', () => dlg.close());
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== WORD; });
    go.addEventListener('click', async () => {
      if (input.value.trim() !== WORD) return;
      go.disabled = true; cancel.disabled = true; input.disabled = true;
      msg.textContent = 'מוחק…';
      try {
        const r = await api.wipe(WORD);
        const done = h('div', { class: 'state wipe-done', role: 'status' },
          h('h3', null, 'כל הנתונים נמחקו'),
          h('p', null, r?.restarting
            ? (window.moneycash?.isDesktop ? 'MoneyCash נפתח מחדש כהתקנה חדשה.' : 'MoneyCash מופעל מחדש ויפתח לשונית חדשה. אפשר לסגור את הלשונית הזו.')
            : 'אפשר לסגור את התוכנה. בפתיחה הבאה היא תתחיל כהתקנה חדשה.'));
        body.replaceChildren(done);
        dlg.el.querySelector('.dlg-foot')?.replaceChildren();
        announce('כל הנתונים נמחקו', true);
      } catch (e) {
        msg.textContent = e.message;
        cancel.disabled = false; input.disabled = false; go.disabled = input.value.trim() !== WORD;
      }
    });
  }

  offs.push(on('sync', paintConnections));
  offs.push(on('reference', paintConnections));
  // A new account (a sheet added, a bank's first sync) shows up in the "whose account" list at once.
  offs.push(on('reference', () => {
    const sec = view.querySelector('[aria-labelledby="st-biz"]');
    if (sec && state.business?.enabled && !sec.contains(document.activeElement)) sec.replaceWith(businessSection());
  }));
  let lastDemo = state.status?.demoMode;
  offs.push(on('status', (st) => {
    // demo mode can change elsewhere (palette, onboarding, or the server when a real account is added)
    if (st && st.demoMode !== lastDemo) { lastDemo = st.demoMode; render(); }
  }));
  render();
  if (params.add) queueMicrotask(() => { history.replaceState(null, '', '#/settings'); openConnectDialog(); });
  if (params.tab === 'business') queueMicrotask(() => view.querySelector('[aria-labelledby="st-biz"]')?.scrollIntoView({ block: 'start' }));
  const toBusiness = () => queueMicrotask(() => view.querySelector('[aria-labelledby="st-biz"]')?.scrollIntoView({ block: 'start' }));
  return { destroy() { offs.forEach((f) => f()); }, update(p) { if (p.add) openConnectDialog(); if (p.tab === 'business') toBusiness(); } };
}
