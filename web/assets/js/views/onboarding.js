// First run: no connections, demo off. A short, useful start, not a splash screen.
import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { state, loadStatus, loadReference, emit } from '../store.js';
import { setWhere } from '../shell.js';
import { toast } from '../layers.js';
import { openConnectDialog, trustNote } from './connect.js';

export function mountOnboarding(container) {
  setWhere('overview', 'התחלה');
  const connect = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), 'חיבור בנק או כרטיס אשראי');
  connect.addEventListener('click', () => openConnectDialog());
  const demo = h('button', { class: 'btn', type: 'button' }, 'להסתכל קודם על נתוני הדגמה');
  demo.addEventListener('click', async () => {
    demo.disabled = true;
    try {
      state.status = await api.setDemo(true);
      await Promise.all([loadStatus(), loadReference()]);
      emit('status', state.status);
      emit('data-changed');
      emit('first-run-done');
    } catch (e) { toast(e.message, { kind: 'error' }); demo.disabled = false; }
  });
  const el = h('div', { class: 'page onb-page' }, h('div', { class: 'onb' },
    h('div', { class: 'onb-main' },
      h('h1', null, 'מתחילים בחיבור החשבון הראשון'),
      h('p', { class: 'onb-lead' }, 'התוכנה מושכת את התנועות מהבנק ומכרטיסי האשראי שלך, מסדרת אותן בקטגוריות, ואומרת לך במילים פשוטות מה השתנה ומה כדאי לבדוק.'),
      h('ol', { class: 'onb-steps' },
        h('li', null, h('span', null, h('strong', null, 'מחברים בנק או כרטיס.'), ' עם אותם פרטים שבהם נכנסים לאתר שלהם. אפשר להוסיף עוד חיבורים בהמשך.')),
        h('li', null, h('span', null, h('strong', null, 'מחכים לסנכרון הראשון.'), ' בדרך כלל דקה או שתיים. הוא מביא כמה חודשים אחורה.')),
        h('li', null, h('span', null, h('strong', null, 'קוראים את המסקנות.'), ' בסקירה: כמה הוצאת, אם זה רגיל, מה צפוי לרדת, ומה כדאי לבדוק.'))),
      h('div', { class: 'onb-actions' }, connect, demo)),
    h('aside', { class: 'onb-side', 'aria-label': 'פרטיות ואבטחה' }, trustNote(2))));
  container.replaceChildren(el);
  connect.focus();
  return { destroy() {} };
}
