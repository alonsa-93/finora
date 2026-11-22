// Sync control: start a sync, poll /api/sync/status while it runs, announce progress, refresh data when done.
import { api } from './api.js';
import { state, emit, loadStatus, loadReference } from './store.js';
import { announce, toast } from './layers.js';

let timer = null;
let lastMessages = '';
const announced = new Set();

export const isSyncing = () => Boolean(state.sync?.running);

function summarize(items = []) {
  const done = items.filter((i) => i.state === 'ok' || i.state === 'error').length;
  return { done, total: items.length };
}

async function poll() {
  let s;
  try { s = await api.syncStatus(); } catch { s = null; }
  if (s) {
    state.sync = s;
    emit('sync', s);
    // Screen readers: one short line when a connection finishes ("מקס: הסתיים. 2 מתוך 3"), not
    // every progress message the scraper reports.
    const items = s.items || [];
    const { done, total } = summarize(items);
    const key = `${done}/${total}`;
    if (s.running && total && key !== lastMessages) {
      const fresh = items.filter((i) => (i.state === 'ok' || i.state === 'error') && !announced.has(i.connectionId ?? i.companyName));
      for (const i of fresh) announced.add(i.connectionId ?? i.companyName);
      const what = fresh.map((i) => `${i.companyName}: ${i.state === 'error' ? 'נכשל' : 'הסתיים'}`).join(', ');
      if (lastMessages || what) announce(`${what ? `${what}. ` : ''}${done} מתוך ${total}`);
      lastMessages = key;
    }
  }
  if (s && s.running) { timer = setTimeout(poll, 1000); return; }
  timer = null;
  lastMessages = '';
  announced.clear();
  if (s) finish(s);
}

async function finish(s) {
  const items = s.items || [];
  const failed = items.filter((i) => i.state === 'error');
  const added = items.reduce((n, i) => n + (Number.isFinite(i.newTransactions) ? i.newTransactions : 0), 0);
  await Promise.all([loadStatus().catch(() => {}), loadReference().catch(() => {})]);
  emit('data-changed');
  if (!items.length) return;
  if (failed.length) {
    toast(`הסנכרון הסתיים עם ${failed.length === 1 ? 'שגיאה בחיבור אחד' : `שגיאות ב-${failed.length} חיבורים`}. הפרטים במסך החשבונות.`, {
      kind: 'error', timeout: 9000,
      action: { label: 'לפרטים', onSelect: () => { location.hash = '#/settings'; } },
    });
  } else {
    toast(added > 0 ? `הסנכרון הסתיים. נוספו ${added.toLocaleString('he-IL')} תנועות חדשות.` : 'הסנכרון הסתיים. אין תנועות חדשות.');
  }
}

export async function startSync(connectionId, { interactive = false } = {}) {
  const wasRunning = isSyncing();
  try {
    const s = await api.sync(connectionId, { interactive });
    state.sync = s || { running: true, items: [] };
    emit('sync', state.sync);
    announce(wasRunning ? 'נוסף לסנכרון שרץ עכשיו' : 'הסנכרון התחיל');
  } catch (e) {
    if (e.code === 'SYNC_RUNNING') toast('התחברות עם קוד אפשרית רק כשאין סנכרון אחר. נסה שוב בסיומו.');
    else { toast(e.message, { kind: 'error' }); return; }
  }
  if (!timer) timer = setTimeout(poll, 600);
}

/** Pick up a sync that was already running when the app opened (e.g. the daily auto-sync). */
export async function resumeIfRunning() {
  try {
    const s = await api.syncStatus();
    const changed = JSON.stringify(s) !== JSON.stringify(state.sync);
    state.sync = s;
    if (changed) emit('sync', s);
    if (s.running && !timer) timer = setTimeout(poll, 1000);
  } catch { /* ignore */ }
}

/** Background watch: notices syncs started elsewhere (daily auto-sync, the server after a new connection). */
export function watchSync(every = 15000) {
  setInterval(() => { if (!timer && !document.hidden) resumeIfRunning(); }, every);
}

export { summarize as syncProgress };
