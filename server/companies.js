// Hebrew metadata for every institution in israeli-bank-scrapers' SCRAPERS list.
// loginFields come from the library at runtime (source of truth); we only add Hebrew labels.

const FIELD_LABELS = {
  userCode: { label: 'קוד משתמש', secret: false },
  username: { label: 'שם משתמש', secret: false },
  id: { label: 'מספר תעודת זהות', secret: false },
  nationalID: { label: 'מספר תעודת זהות', secret: false },
  num: { label: 'קוד מזהה', secret: false },
  card6Digits: { label: '6 הספרות האחרונות של הכרטיס', secret: false },
  email: { label: 'דוא״ל', secret: false },
  phoneNumber: { label: 'מספר טלפון', secret: false },
  password: { label: 'סיסמה', secret: true },
  otpLongTermToken: { label: 'אסימון אימות ארוך טווח', secret: true },
};

// Per-company Hebrew names, short names for account labels, type, retrieval window.
const META = {
  hapoalim: { name: 'בנק הפועלים', short: 'פועלים', type: 'bank' },
  leumi: { name: 'בנק לאומי', short: 'לאומי', type: 'bank' },
  mizrahi: { name: 'בנק מזרחי טפחות', short: 'מזרחי', type: 'bank' },
  discount: { name: 'בנק דיסקונט', short: 'דיסקונט', type: 'bank', maxDays: 364 },
  mercantile: { name: 'בנק מרכנתיל', short: 'מרכנתיל', type: 'bank', maxDays: 364 },
  otsarHahayal: { name: 'בנק אוצר החייל', short: 'אוצר החייל', type: 'bank' },
  union: { name: 'בנק איגוד', short: 'איגוד', type: 'bank' },
  beinleumi: { name: 'הבנק הבינלאומי', short: 'בינלאומי', type: 'bank' },
  massad: { name: 'בנק מסד', short: 'מסד', type: 'bank' },
  yahav: { name: 'בנק יהב', short: 'יהב', type: 'bank', maxDays: 180 },
  pagi: { name: 'בנק פאג״י', short: 'פאג״י', type: 'bank' },
  oneZero: {
    name: 'וואן זירו', short: 'וואן זירו', type: 'bank', supported: false,
    note: 'הבנק דורש קוד חד־פעמי ב-SMS בכל התחברות, ולכן עדיין לא נתמך.',
  },
  max: { name: 'מקס', short: 'מקס', type: 'card' },
  visaCal: { name: 'כאל (ויזה כאל)', short: 'כאל', type: 'card' },
  isracard: { name: 'ישראכרט', short: 'ישראכרט', type: 'card' },
  amex: { name: 'אמריקן אקספרס', short: 'אמקס', type: 'card' },
  beyahadBishvilha: { name: 'ביחד בשבילך (כרטיס הטבות)', short: 'ביחד בשבילך', type: 'card' },
  behatsdaa: { name: 'בהצדעה (כרטיס הטבות)', short: 'בהצדעה', type: 'card' },
  // Not a scraper: a Google Sheets link pulled by sheet-sync.js (added from Settings, not the company list).
  gsheet: { name: 'גיליון Google', short: 'גיליון', type: 'bank' },
};

const ORDER = ['hapoalim', 'leumi', 'discount', 'mizrahi', 'beinleumi', 'mercantile', 'otsarHahayal',
  'massad', 'yahav', 'union', 'pagi', 'oneZero', 'max', 'visaCal', 'isracard', 'amex',
  'beyahadBishvilha', 'behatsdaa'];

let scrapersMeta = null;
// Fields that the library lists but that are part of an interactive OTP flow, not user input.
const NON_INPUT_FIELDS = new Set(['otpCodeRetriever']);

/** Load SCRAPERS from the library lazily (it pulls in puppeteer). Falls back to a static copy. */
export async function loadScrapersMeta() {
  if (scrapersMeta) return scrapersMeta;
  try {
    const lib = await import('israeli-bank-scrapers');
    scrapersMeta = (lib.SCRAPERS || lib.default?.SCRAPERS);
  } catch {
    scrapersMeta = null;
  }
  if (!scrapersMeta) scrapersMeta = STATIC_FALLBACK;
  return scrapersMeta;
}

// Snapshot of israeli-bank-scrapers@6.13.0 SCRAPERS, used only if the import fails.
const STATIC_FALLBACK = {
  hapoalim: { loginFields: ['userCode', 'password'] },
  leumi: { loginFields: ['username', 'password'] },
  mizrahi: { loginFields: ['username', 'password'] },
  discount: { loginFields: ['id', 'password', 'num'] },
  mercantile: { loginFields: ['id', 'password', 'num'] },
  otsarHahayal: { loginFields: ['username', 'password'] },
  max: { loginFields: ['username', 'password'] },
  visaCal: { loginFields: ['username', 'password'] },
  isracard: { loginFields: ['id', 'card6Digits', 'password'] },
  amex: { loginFields: ['id', 'card6Digits', 'password'] },
  union: { loginFields: ['username', 'password'] },
  beinleumi: { loginFields: ['username', 'password'] },
  massad: { loginFields: ['username', 'password'] },
  yahav: { loginFields: ['username', 'nationalID', 'password'] },
  beyahadBishvilha: { loginFields: ['id', 'password'] },
  oneZero: { loginFields: ['email', 'password', 'otpCodeRetriever', 'phoneNumber', 'otpLongTermToken'] },
  behatsdaa: { loginFields: ['id', 'password'] },
  pagi: { loginFields: ['username', 'password'] },
};

export async function listCompanies() {
  const lib = await loadScrapersMeta();
  const ids = [...ORDER.filter((id) => lib[id]), ...Object.keys(lib).filter((id) => !ORDER.includes(id))];
  return ids.map((id) => companyInfo(id, lib));
}

function companyInfo(id, lib) {
  const meta = META[id] || { name: lib[id]?.name || id, short: lib[id]?.name || id, type: 'bank',
    supported: false, note: 'מוסד זה עדיין לא נבדק באפליקציה.' };
  const fields = (lib[id]?.loginFields || [])
    .filter((k) => !NON_INPUT_FIELDS.has(k))
    .map((key) => ({ key, label: FIELD_LABELS[key]?.label || key, secret: FIELD_LABELS[key]?.secret ?? /pass|token|secret/i.test(key) }));
  return {
    id, name: meta.name, type: meta.type, loginFields: fields,
    supported: meta.supported !== false, note: meta.note ?? null,
  };
}

/** Synchronous lookup (static metadata only) for display purposes. */
export function companyMeta(id) {
  const m = META[id];
  return {
    id,
    name: m?.name || id,
    short: m?.short || m?.name || id,
    type: m?.type || 'bank',
    // Library docs: most scrapers allow "up to one year"; stay one day inside that.
    maxDays: m?.maxDays || 364,
  };
}

export async function getCompany(id) {
  if (typeof id !== 'string' || !Object.hasOwn(META, id)) return null;
  const lib = await loadScrapersMeta();
  if (!lib[id]) return null;
  return companyInfo(id, lib);
}
