// Boot: shell, data, router, global keyboard.
import { h, icon } from './dom.js';
import { state, on, emit, loadStatus, loadReference, isFirstRun, rememberMerchants, loadBusiness, setLensState } from './store.js';
import { SECTIONS, parseHash, go, route } from './router.js';
import { buildShell, setActiveSection, toggleSidebar, closeInspector, renderStatusChrome, setNavBadge, renderBusinessChrome } from './shell.js';
import { openPalette, paletteOpen } from './palette.js';
import { hasOpenLayer, toast, announce, initTooltips } from './layers.js';
import { openShortcuts } from './keys.js';
import { undoLast } from './undo.js';
import { startSync, resumeIfRunning, watchSync } from './sync.js';
import { cycleTheme, THEME_LABEL } from './theme.js';
import { getPref } from './prefs.js';
import { api, downloadApiFile } from './api.js';
import { mountOverview } from './views/overview.js';
import { mountTransactions } from './views/transactions.js';
import { mountRecurring } from './views/recurring.js';
import { mountAnnual } from './views/annual.js';
import { mountSettings } from './views/settings.js';
import { mountChat } from './views/chat.js';
import { mountBusiness } from './views/business.js';
import { mountDashboards } from './views/dashboards.js';
import { mountOnboarding } from './views/onboarding.js';
import { openConnectDialog } from './views/connect.js';
import { errorState } from './views/common.js';

const root = document.getElementById('root');
let main, current = null, currentKey = null;

const MOUNTS = { overview: mountOverview, transactions: mountTransactions, recurring: mountRecurring, annual: mountAnnual, settings: mountSettings, chat: mountChat, business: mountBusiness, dashboards: mountDashboards };

function viewKey(section) { return section === 'overview' && isFirstRun() ? 'onboarding' : section; }

function show({ section, params }) {
  if (!section) { go(getPref('lastSection', 'overview') || 'overview', {}, { replace: true }); return; }
  if (section === 'business' && !state.business?.enabled) { go('settings', { tab: 'business' }, { replace: true }); return; }
  setActiveSection(section);
  const key = viewKey(section);
  if (current && currentKey === key && current.update) { current.update(params); return; }
  current?.destroy?.();
  closeInspector(true);
  const container = h('div', { class: 'view', dataset: { view: key } });
  main.replaceChildren(container);
  currentKey = key;
  current = key === 'onboarding' ? mountOnboarding(container) : MOUNTS[section](container, params);
}

const actions = [
  { label: 'סנכרון עכשיו', icon: 'sync', kbd: 'Ctrl+Shift+S', run: () => startSync() },
  { label: 'חיבור בנק או כרטיס אשראי', icon: 'plus', run: () => openConnectDialog() },
  { label: 'ייצוא תנועות ל-CSV', icon: 'download', match: 'ייצוא csv אקסל export', run: () => { if (currentKey === 'transactions') current.exportCsv(); else { go('transactions'); setTimeout(() => current?.exportCsv?.(), 50); } } },
  { label: 'החלפת ערכת צבעים', icon: 'moon', match: 'ערכת צבעים כהה בהיר מראה theme', run: () => toast(`ערכת צבעים: ${THEME_LABEL[cycleTheme()]}`) },
  { label: 'מצב הדגמה: הפעלה או כיבוי', icon: 'eye', match: 'הדגמה demo', run: toggleDemo },
  { label: 'כיווץ או הרחבה של סרגל הצד', icon: 'sidebar', kbd: 'Ctrl+B', run: () => toggleSidebar() },
  { label: 'קיצורי מקלדת', icon: 'keyboard', kbd: '?', run: openShortcuts },
  { label: 'הצג: הכול (עסק ופרטי)', icon: 'wallet', match: 'עסק פרטי הכול צד lens', when: () => state.business?.enabled, run: () => setLensState('all') },
  { label: 'הצג: רק העסק', icon: 'briefcase', match: 'עסק business', when: () => state.business?.enabled, run: () => setLensState('business') },
  { label: 'הצג: רק הפרטי', icon: 'home', match: 'פרטי בית private', when: () => state.business?.enabled, run: () => setLensState('private') },
  { label: 'דשבורד מגיליון Google', icon: 'grid', match: 'דשבורד גיליון שיטס sheets google', run: () => go('dashboards') },
];

async function toggleDemo() {
  try {
    state.status = await api.setDemo(!state.status?.demoMode);
    await loadReference();
    emit('status', state.status);
    emit('data-changed');
    toast(state.status.demoMode ? 'מוצגים נתוני הדגמה.' : 'מוצגים הנתונים שלך.');
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

/* ---------------- keyboard ---------------- */
// Physical key (works on the Hebrew layout) with a fallback to the produced character.
const isKey = (e, letter) => e.code === `Key${letter.toUpperCase()}` || (!e.code && (e.key || '').toLowerCase() === letter);
const typing = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

// A chart takes focus on click so the arrow keys work, but a plain focus scrolls a half-visible
// chart into view and the page jumps under the pointer. Focus it in place instead.
document.addEventListener('mousedown', (e) => {
  const chart = e.button === 0 ? e.target.closest?.('svg[tabindex]') : null;
  if (!chart) return;
  e.preventDefault();
  chart.focus({ preventScroll: true });
}, true);

// Export links (<a href="/api/…csv" download>): /api needs the token header, which a navigation
// cannot send, so every such link downloads through fetch instead (api.js downloadApiFile).
document.addEventListener('click', (e) => {
  const a = e.button === 0 && !e.defaultPrevented ? e.target.closest?.('a[href^="/api/"]') : null;
  if (!a) return;
  e.preventDefault();
  downloadApiFile(a.getAttribute('href')).catch((err) => toast(err.message, { kind: 'error' }));
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const t = e.target;
  if (mod && !e.shiftKey && isKey(e, 'k')) { e.preventDefault(); if (!paletteOpen()) openPalette(actions); return; }
  if (hasOpenLayer() || paletteOpen()) return;   // dialogs and menus own the keyboard

  if (mod && !e.shiftKey && (/^Digit[1-8]$/.test(e.code) || (!e.code && /^[1-8]$/.test(e.key)))) {
    e.preventDefault();
    const digit = e.code ? e.code.slice(5) : e.key;
    const sec = SECTIONS.find((x) => x.key === digit);
    if (sec && !(sec.business && !state.business?.enabled)) go(sec.id);
    main.focus({ preventScroll: true });
    return;
  }
  if (mod && !e.shiftKey && isKey(e, 'b')) { e.preventDefault(); toggleSidebar(); return; }
  if (mod && e.shiftKey && isKey(e, 's')) { e.preventDefault(); startSync(); return; }
  if (mod && !e.shiftKey && isKey(e, 'e')) { e.preventDefault(); actions[2].run(); return; }
  if (e.key === 'F5' || (mod && isKey(e, 'r'))) { e.preventDefault(); current?.refresh?.(); announce('מרענן'); return; }
  if (e.key === 'Escape') {
    if (closeInspector()) { e.preventDefault(); return; }
    if (typing(t)) { t.blur(); main.focus({ preventScroll: true }); }
    return;
  }
  if (typing(t)) return;   // inside a field Ctrl+Z is the field's own undo
  if (mod && !e.shiftKey && !e.altKey && isKey(e, 'z')) { e.preventDefault(); undoLast(); return; }
  if (!mod && !e.altKey && (e.key === '?' || (e.code === 'Slash' && e.shiftKey))) { e.preventDefault(); openShortcuts(); return; }
  if (!mod && !e.altKey && ((e.code === 'Slash' && !e.shiftKey) || (!e.code && e.key === '/'))) {
    e.preventDefault();
    if (currentKey !== 'transactions') go('transactions', state.month ? { month: state.month } : {});
    queueMicrotask(() => current?.focusSearch?.());
    return;
  }
  if ((currentKey === 'overview' || currentKey === 'annual') && !t.closest?.('svg, table, [role="tablist"]')) {
    if (e.key === 'PageDown') { e.preventDefault(); current.prevMonth(); }
    else if (e.key === 'PageUp') { e.preventDefault(); current.nextMonth(); }
  }
});

/* ---------------- boot ---------------- */
async function boot() {
  initTooltips();
  main = buildShell(root, {
    onCommand: () => openPalette(actions),
    onSync: () => (state.sync?.running || state.connections.some((c) => c.lastStatus === 'error') ? go('settings') : startSync()),
    onDemo: () => go('settings'),
    onLens: (l) => setLensState(l),
  });
  main.replaceChildren(h('div', { class: 'boot', role: 'status' }, 'טוען…'));
  try {
    await Promise.all([loadStatus(), loadReference(), loadBusiness({ silent: true })]);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'ov-pad' }, errorState('אין חיבור לשרת של MoneyCash', e.message, () => location.reload()))));
    return;
  }
  renderStatusChrome();
  renderBusinessChrome();
  on('business', () => {
    renderBusinessChrome();
    const r = parseHash();
    if (r.section === 'business' && !state.business?.enabled) go('settings', { tab: 'business' }, { replace: true });
  });
  on('lens', () => { renderBusinessChrome(); announce(state.lens === 'business' ? 'מוצג העסק בלבד' : state.lens === 'private' ? 'מוצג הפרטי בלבד' : 'מוצג הכול'); });
  // A demo toggle swaps the database: its business settings come with it.
  on('status', () => loadBusiness());
  // Sync on open: the server started it before this page loaded; show it at once (no click).
  resumeIfRunning();
  watchSync();
  // Back after a long time in the background (tray / another tab): same rules as on launch (server side).
  let hiddenAt = document.hidden ? Date.now() : null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const long = hiddenAt !== null && Date.now() - hiddenAt > 30 * 60 * 1000;
    hiddenAt = null;
    if (long) api.openSync().catch(() => {}).finally(() => resumeIfRunning());
    else resumeIfRunning();
  });
  // merchant names for the command palette (most recent first)
  const loadMerchants = () => api.transactions({ limit: 500 }).then((r) => { state.merchants = []; rememberMerchants((r.items || []).map((t) => t.description)); }).catch(() => {});
  loadMerchants();
  on('data-changed', loadMerchants);
  paintBadges();
  on('route', show);
  on('reference', paintBadges);
  on('status', () => {
    // demo toggled or first connection added: the overview may switch between onboarding and data
    const r = parseHash();
    if (r.section === 'overview' && viewKey('overview') !== currentKey) { currentKey = null; show(r); }
  });
  on('first-run-done', () => { currentKey = null; show(parseHash()); });
  route();
}

function paintBadges() {
  const errors = state.connections.filter((c) => c.lastStatus === 'error').length;
  setNavBadge('settings', errors ? '!' : '', errors === 1 ? 'חיבור אחד נכשל' : errors ? `${errors} חיבורים נכשלו` : '');
}

boot();
export { icon };
