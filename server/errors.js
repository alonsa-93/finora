// Error scrubbing and Hebrew translation for scraper failures.

/** Remove anything that could be a secret or personal identifier from free text. */
export function scrub(text, secrets = []) {
  let s = String(text ?? '').slice(0, 4000);
  const variants = new Set();
  for (const v of secrets) {
    if (typeof v === 'string' && v.length >= 2) for (const x of secretVariants(v)) variants.add(x);
  }
  // Longest first, so an escaped form is removed whole before its literal core.
  for (const v of [...variants].sort((a, b) => b.length - a.length)) s = s.split(v).join('***');
  return s
    // Windows paths carry the user name (C:\Users\<name>\..., also JSON-escaped or with / and
    // spaces in the name) - profile folders first, then UNC / \\?\ paths, then any other drive path.
    .replace(/\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n"'<>|]*/gi, '<path>')
    .replace(/\\\\[^\s"'<>|]+/g, '<path>')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***') // e-mails
    .replace(/\d{5,}/g, '***') // ids, card / account numbers, phones
    .replace(/(password|passwd|pwd|סיסמה|token|otp|userCode|username|card6Digits|nationalID|\bid\b|\bnum\b)\s*[:=]\s*\S+/gi, '$1=***')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

/** The forms in which a secret may be echoed by a scraper / site: literal, JSON-escaped (once and
 * twice), backslash-escaped, URL-encoded (incl. form encoding and lower-case hex), HTML-escaped. */
export function secretVariants(v) {
  const out = new Set([v]);
  const json1 = JSON.stringify(v).slice(1, -1);
  out.add(json1);
  out.add(JSON.stringify(json1).slice(1, -1));
  out.add(v.replace(/\\/g, '\\\\'));
  out.add(v.replace(/(["'\\])/g, '\\$1'));
  const url = encodeURIComponent(v);
  out.add(url);
  out.add(url.replace(/%20/g, '+'));
  out.add(url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  out.add(encodeURI(v));
  out.add(url.replace(/'/g, '%27'));
  out.add(v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  return [...out].filter((x) => x.length >= 2);
}

export const ERROR_MESSAGES = {
  INVALID_PASSWORD: 'פרטי ההתחברות שגויים. כדי לא לגרום לחסימת החשבון לא ננסה שוב עד שתעדכן את הפרטים.',
  CHANGE_PASSWORD: 'האתר מבקש להחליף סיסמה. היכנס לאתר של הבנק או חברת האשראי, החלף סיסמה ועדכן אותה כאן.',
  ACCOUNT_BLOCKED: 'החשבון חסום לגישה מקוונת. פנה לבנק או לחברת האשראי כדי לשחרר את החסימה.',
  TIMEOUT: 'האתר לא הגיב בזמן. ייתכן שהוא עמוס או בתחזוקה - נסה שוב מאוחר יותר.',
  TWO_FACTOR_RETRIEVER_MISSING: 'המוסד דורש קוד אימות חד־פעמי, וזה עדיין לא נתמך.',
  NO_BROWSER: 'לא נמצא דפדפן Chrome או Edge במחשב, ולכן אי אפשר להתחבר. התקן Google Chrome ונסה שוב.',
  DECRYPT_FAILED: 'לא ניתן לפענח את פרטי ההתחברות השמורים (ייתכן שהם נשמרו במשתמש Windows אחר). מחק את החיבור והוסף אותו מחדש.',
  NEEDS_CREDENTIALS: 'פרטי ההתחברות שגויים. עדכן את הפרטים כדי לנסות שוב.',
  PAUSED_AFTER_FAILURES: 'ההתחברות נכשלה כמה פעמים ברצף, ולכן הפסקנו לנסות כדי לא לגרום לחסימת החשבון. בדוק את הפרטים ושמור אותם מחדש כדי לחדש את הסנכרון.',
  UNSUPPORTED: 'המוסד הזה עדיין לא נתמך.',
  CODE_REQUIRED: 'האתר ביקש אימות נוסף, בדרך כלל קוד שנשלח ב-SMS. לחץ על "התחברות עם קוד": ייפתח חלון של האתר, ושם תקליד את הקוד בעצמך.',
  CODE_LOGIN_PENDING: 'החיבור מחכה להתחברות עם קוד SMS. לחץ על "התחברות עם קוד" כדי להתחבר פעם אחת בחלון של האתר.',
  WINDOW_CLOSED: 'חלון ההתחברות נסגר לפני שההתחברות הסתיימה. אפשר לנסות שוב.',
  CODE_TIMEOUT: 'ההתחברות בחלון לא הושלמה בזמן. אפשר לנסות שוב.',
  GENERIC: 'המשיכה נכשלה בגלל תקלה באתר של המוסד. נסה שוב מאוחר יותר.',
};

/** Map a scraper result / thrown error to { code, message } (Hebrew). */
export function translateScraperError(errorType, errorMessage = '') {
  const type = String(errorType || '').toUpperCase();
  if (ERROR_MESSAGES[type] && type !== 'GENERIC') return { code: type, message: ERROR_MESSAGES[type] };
  const msg = String(errorMessage || '');
  // Raised by our own login wait (scrape.js), before the generic "timeout" rule below.
  if (/\bCODE_REQUIRED\b/.test(msg)) return { code: 'CODE_REQUIRED', message: ERROR_MESSAGES.CODE_REQUIRED };
  if (/\bCODE_TIMEOUT\b/.test(msg)) return { code: 'CODE_TIMEOUT', message: ERROR_MESSAGES.CODE_TIMEOUT };
  if (/target closed|session closed|browser has disconnected|page has been closed|detached frame/i.test(msg)) {
    return { code: 'WINDOW_CLOSED', message: ERROR_MESSAGES.WINDOW_CLOSED };
  }
  if (/timeout|timed out|navigation/i.test(msg)) return { code: 'TIMEOUT', message: ERROR_MESSAGES.TIMEOUT };
  if (/invalid.*password|wrong.*password|סיסמה שגויה|פרטים שגויים/i.test(msg)) {
    return { code: 'INVALID_PASSWORD', message: ERROR_MESSAGES.INVALID_PASSWORD };
  }
  if (/blocked|חסום|נחסם/i.test(msg)) return { code: 'ACCOUNT_BLOCKED', message: ERROR_MESSAGES.ACCOUNT_BLOCKED };
  if (/change.*password|החלפת סיסמה/i.test(msg)) return { code: 'CHANGE_PASSWORD', message: ERROR_MESSAGES.CHANGE_PASSWORD };
  if (/could not find.*(chrome|browser)|executable doesn't exist|failed to launch/i.test(msg)) {
    return { code: 'NO_BROWSER', message: ERROR_MESSAGES.NO_BROWSER };
  }
  return { code: 'GENERIC', message: ERROR_MESSAGES.GENERIC };
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
