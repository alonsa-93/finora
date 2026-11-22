// Shortcut list (single source for the cheat sheet) + the cheat sheet dialog.
import { h } from './dom.js';
import { openDialog } from './layers.js';

const isMac = /Mac/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

export const SHORTCUTS = [
  { group: 'כללי' },
  { keys: [MOD, 'K'], label: 'חיפוש, מעבר ופקודות' },
  { keys: ['?'], label: 'רשימת הקיצורים' },
  { keys: ['/'], label: 'חיפוש בתנועות' },
  { keys: ['Esc'], label: 'סגירת חלון, תפריט או חלונית' },
  { keys: [MOD, 'B'], label: 'כיווץ או הרחבה של סרגל הצד' },
  { keys: ['F5'], label: 'רענון הנתונים במסך' },
  { keys: [MOD, 'Z'], label: 'ביטול השינוי האחרון (קטגוריה או הוצאה מהסיכומים)' },
  { keys: [MOD, 'Shift', 'S'], label: 'סנכרון עכשיו' },
  { group: 'מעבר בין אזורים' },
  { keys: [MOD, '1'], label: 'סקירה' },
  { keys: [MOD, '2'], label: 'תנועות' },
  { keys: [MOD, '3'], label: 'חיובים קבועים' },
  { keys: [MOD, '4'], label: 'חשבונות והגדרות' },
  { keys: [MOD, '5'], label: 'סיכום שנתי' },
  { keys: [MOD, '6'], label: 'שאלות על הכסף שלך' },
  { group: 'סקירה' },
  { keys: ['PageDown'], label: 'החודש הקודם' },
  { keys: ['PageUp'], label: 'החודש הבא' },
  { group: 'סיכום שנתי' },
  { keys: ['←', '→'], label: 'מעבר בין "סיכום השנה" ל"מגמות מחירים" (בלשוניות)' },
  { keys: ['PageDown'], label: 'התקופה הקודמת (חודש אחורה)' },
  { keys: ['PageUp'], label: 'התקופה הבאה' },
  { group: 'טבלת התנועות' },
  { keys: ['↑', '↓'], label: 'מעבר בין שורות' },
  { keys: ['Enter'], label: 'פרטי התנועה' },
  { keys: ['C'], label: 'שינוי קטגוריה' },
  { keys: ['X'], label: 'הוצאה מהסיכומים או החזרה' },
  { keys: ['M'], label: 'כל התנועות מאותו בית עסק' },
  { keys: [MOD, 'C'], label: 'העתקת הסכום' },
  { keys: ['Shift', 'F10'], label: 'תפריט פעולות לשורה' },
  { keys: [MOD, 'E'], label: 'ייצוא ל-CSV' },
];

export function openShortcuts() {
  const grid = h('div', { class: 'keys-grid' }, SHORTCUTS.map((s) => (s.group
    ? h('h3', null, s.group)
    : h('div', { class: 'keys-row' }, h('span', null, s.label), h('span', { dir: 'ltr' }, s.keys.map((k) => h('kbd', null, k)))))));
  openDialog({ title: 'קיצורי מקלדת', body: grid, wide: true });
}
