// Categories, normalisation and auto-categorisation.
// Priority: user rule > (bank) credit-card-debit detection > provider category > keyword rules > fallback,
// except fuel / bills / car merchants, which outrank the card company's vehicle and utility categories.

// Colours: mid-tone, saturated hues chosen to keep >= 3:1 contrast against both white (#fff)
// and a dark surface (#1a1b1e) so chart segments stay visible in light and dark themes.
export const CATEGORIES = [
  { id: 'groceries', name: 'סופר ומכולת', color: '#2f9e77', kind: 'expense' },
  { id: 'restaurants', name: 'מסעדות ובתי קפה', color: '#e8590c', kind: 'expense' },
  { id: 'fuel', name: 'דלק', color: '#b08900', kind: 'expense' },
  { id: 'transport', name: 'תחבורה ציבורית ומוניות', color: '#1c7ed6', kind: 'expense' },
  { id: 'car', name: 'רכב וחניה', color: '#7048e8', kind: 'expense' },
  { id: 'housing', name: 'דיור (שכירות/משכנתא)', color: '#c2255c', kind: 'expense' },
  { id: 'bills', name: 'חשבונות (חשמל, מים, ארנונה)', color: '#e67700', kind: 'expense' },
  { id: 'communication', name: 'תקשורת וסלולר', color: '#1098ad', kind: 'expense' },
  { id: 'health', name: 'בריאות ופארם', color: '#e03131', kind: 'expense' },
  { id: 'kids', name: 'ילדים וחינוך', color: '#9c36b5', kind: 'expense' },
  { id: 'shopping', name: 'קניות והלבשה', color: '#d6336c', kind: 'expense' },
  { id: 'leisure', name: 'פנאי ובילויים', color: '#5c940d', kind: 'expense' },
  { id: 'travel', name: 'חופשות וטיסות', color: '#3b5bdb', kind: 'expense' },
  { id: 'subscriptions', name: 'מנויים', color: '#ae3ec9', kind: 'expense' },
  { id: 'insurance', name: 'ביטוחים', color: '#0b7285', kind: 'expense' },
  { id: 'fees', name: 'עמלות וריבית', color: '#a0522d', kind: 'expense' },
  { id: 'cash', name: 'משיכת מזומן', color: '#8d7b68', kind: 'expense' },
  { id: 'other', name: 'אחר', color: '#868e96', kind: 'expense' },
  { id: 'salary', name: 'משכורת והכנסות', color: '#2b8a3e', kind: 'income' },
  { id: 'transfers', name: 'העברות', color: '#4c6ef5', kind: 'neutral' },
  { id: 'card-payment', name: 'חיוב כרטיס אשראי', color: '#748ffc', kind: 'neutral' },
];

// Not a choice in the category lists: business mode forces it on money moved between the user's own
// business and private accounts (business.js OWNER_TRANSFER), which is never income or spending.
export const HIDDEN_CATEGORIES = [
  { id: 'owner-transfer', name: 'העברה בין העסק לפרטי', color: '#868e96', kind: 'neutral', hidden: true },
];
export const CATEGORY_BY_ID = new Map([...CATEGORIES, ...HIDDEN_CATEGORIES].map((c) => [c.id, c]));
export const isValidCategory = (id) => typeof id === 'string' && CATEGORY_BY_ID.has(id) && !CATEGORY_BY_ID.get(id).hidden;
export const kindOf = (id) => CATEGORY_BY_ID.get(id)?.kind || 'expense';

/** Normalised merchant key: used for user rules, recurring detection and grouping. */
export function normalizeDescription(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '') // Hebrew niqqud
    .replace(/[״"'`׳]/g, '')
    .replace(/\d{3,}/g, ' ') // reference / card / phone numbers
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Bank lines that are the monthly credit-card debit -----------------------------------------
const CARD_PAYMENT_PATTERNS = [
  /ישראכרט/, /isracard/i, /אמריקן\s*אקספרס/, /אמקס/, /\bamex\b/i, /american\s*express/i,
  /מקס\s*איט/, /\bmax\s*it\b/i, /לאומי\s*קארד/, /leumi\s*card/i, /^מקס(?![א-ת])/, /^max\b/i,
  /ויזה\s*כאל/, /visa\s*cal/i, /כ\.א\.ל/, /^כאל(?![א-ת])/, /כרטיסי\s*אשראי/, /\bcal\b/i,
  /דיינרס/, /diners/i, /חיוב\s*(?:ל)?כרטיס/, /חיוב\s*חודשי\s*(?:ל)?כרטיס/, /כרטיס\s*אשראי/,
  /^ויזה(?![א-ת])/, /^visa\b/i, /מסטרקארד/, /mastercard/i, /^אשראי(?![א-ת])/,
];

export function isCardPaymentDescription(desc) {
  const s = String(desc || '').trim();
  return CARD_PAYMENT_PATTERNS.some((re) => re.test(s));
}

// ---- Provider (card company) category mapping -------------------------------------------------
const PROVIDER_MAP = [
  [/מזון|סופר|מרכול|מכולת|grocer|supermarket/i, 'groceries'],
  [/מסעד|קפה|בתי אוכל|מזון מהיר|food|restaurant|cafe/i, 'restaurants'],
  // Card companies lump fuel with electricity and gas ("דלק, חשמל וגז"): such a mixed category says
  // nothing on its own, so the merchant decides (see categorize).
  [/(?:דלק|fuel).*(?:חשמל|גז|electric)|(?:חשמל|electric).*(?:דלק|fuel)/i, 'fuel-or-bills'],
  [/דלק|fuel|gas station/i, 'fuel'],
  [/תחבור|transport/i, 'transport'],
  [/רכב|מוסך|חניה|automotive|parking/i, 'car'],
  [/חשמל|מים|גז|ארנונה|עירי|utilit/i, 'bills'],
  [/תקשורת|סלולר|טלפון|אינטרנט|telecom/i, 'communication'],
  [/רפוא|בריאות|פארם|קופ.ח|health|pharm|medical/i, 'health'],
  [/חינוך|ילדים|צעצוע|education|school/i, 'kids'],
  [/אופנה|הלבשה|הנעלה|ביגוד|ריהוט|בית|חשמל ואלקטרוניקה|מחשבים|קניות|כלבו|shopping|cloth|fashion|electronics/i, 'shopping'],
  [/פנאי|בילוי|ספורט|תרבות|קולנוע|leisure|entertainment|sport/i, 'leisure'],
  [/תיירות|טיס|מלונ|נופש|travel|airline|hotel/i, 'travel'],
  [/ביטוח|insurance/i, 'insurance'],
];

export function mapProviderCategory(cat) {
  if (!cat || typeof cat !== 'string') return null;
  for (const [re, id] of PROVIDER_MAP) if (re.test(cat)) return id;
  return null;
}

// ---- Keyword rules for well-known Israeli merchants (Hebrew + English) -------------------------
const KEYWORD_RULES = [
  ['card-payment', []], // handled by isCardPaymentDescription for bank lines
  ['salary', [/משכורת/, /תקבול/, /\bsalary\b/i, /שכר\s*עבודה/, /ביטוח\s*לאומי.*(?:קצב|גמלה)/, /קצבת/, /דמי\s*אבטלה/, /החזר\s*מס/, /מס\s*הכנסה\s*החזר/]],
  ['fees', [/עמל(?:ה|ת)/, /דמי\s*(?:ניהול|כרטיס)/, /ריבית/, /\bfee\b/i, /interest/i, /דמי\s*טיפול/]],
  ['transfers', [/\bbit\b/i, /^ביט(?![א-ת])/, /ביט\s*-/, /paybox/i, /פייבוקס/, /pepper\s*pay/i, /העברה/, /העב\.?\s/, /הפקדה\s*עצמית/, /העברת\s*כספים/]],
  ['cash', [/משיכ(?:ה|ת)\s*(?:מזומן|כספומט)/, /כספומט/, /\batm\b/i, /משיכה\s*מבנקט/, /בנקט/]],
  ['housing', [/שכר\s*דירה/, /שכירות/, /משכנתא/, /משכנתה/, /ועד\s*בית/, /\brent\b/i, /mortgage/i, /טפחות\s*משכ/]],
  ['kids', [/גן\s*ילדים/, /גן\s*חובה/, /צהרון/, /מעון/, /בית\s*ספר/, /חוג/, /קייטנה/, /תלמוד\s*תורה/, /אוניברסיט/, /מכללה/, /סטימצקי/, /steimatzky/i, /צומת\s*ספרים/, /טויס\s*אר\s*אס|toys\s*r\s*us/i, /שילב/, /שגב\s*קידס/, /kidz|kids/i]],
  ['bills', [/חברת\s*החשמל/, /חשמל\s*לישראל/, /\biec\b/i, /ארנונה/, /עיריית/, /מועצה\s*(?:אזורית|מקומית)/, /מי\s*אביבים/, /הגיחון/, /מי\s*(?:שבע|כרמל|רעננה|נתניה|מודיעין|הרצליה)/, /תאגיד\s*מים/, /סופרגז/, /אמישראגז/, /פזגז/, /דור\s*גז/, /electric/i]],
  ['communication', [/פרטנר/, /partner/i, /סלקום/, /cellcom/i, /פלאפון/, /pelephone/i, /הוט\s*מובייל/, /hot\s*mobile/i, /גולן\s*טלקום/, /golan/i, /(?<![א-ת])הוט(?![א-ת])/, /\bhot\b/i, /בזק/, /bezeq/i, /\byes\b/i, /^יס(?![א-ת])(?!\s*פלאנט)/, /012\s*(?:סמייל|smile)/i, /019\s*(?:מובייל|טלזר)/, /רמי\s*לוי\s*תקשורת/, /we4g|we\s*com/i, /אקספון/, /xphone/i]],
  ['subscriptions', [/netflix/i, /נטפליקס/, /spotify/i, /ספוטיפיי/, /apple\.com|itunes|icloud/i, /google\s*(?:play|storage|one)/i, /youtube/i, /disney/i, /amazon\s*prime/i, /chatgpt|openai/i, /microsoft|office\s*365/i, /adobe/i, /dropbox/i, /סלקום\s*tv|cellcom\s*tv/i, /partner\s*tv/i, /next\s*tv/i, /הולמס\s*פלייס/, /holmes\s*place/i, /גו\s*אקטיב|go\s*active/i, /שופרסל\s*אונליין\s*מנוי/, /מנוי/]],
  ['insurance', [/ביטוח/, /insurance/i, /הראל/, /\bharel\b/i, /מגדל/, /migdal/i, /הפניקס/, /phoenix/i, /כלל\s*(?:ביטוח|חברה)/, /מנורה/, /menora/i, /איילון/, /ayalon/i, /ליברה/, /libra/i, /\b9\s*מיליון/, /wesure/i, /שירביט/]],
  ['health', [/סופר[\s-]*פארם/, /super[\s-]*pharm/i, /\bbe\b\s*פארם|בי\s*פארם/, /good\s*pharm|גוד\s*פארם/, /מכבי/, /maccabi/i, /כללית/, /clalit/i, /מאוחדת/, /meuhedet/i, /לאומית/, /leumit/i, /בית\s*מרקחת/, /pharm/i, /רופא/, /מרפאה/, /שיניים/, /dental/i, /אופטיקה|optic/i, /עיניים/]],
  ['groceries', [/שופרסל/, /shufersal/i, /רמי\s*לוי/, /rami\s*levy/i, /יוחננוף/, /yochananof/i, /ויקטורי/, /victory/i, /מגה\s*בעיר/, /יינות\s*ביתן/, /אושר\s*עד/, /osher\s*ad/i, /חצי\s*חינם/, /טיב\s*טעם/, /tiv\s*taam/i, /am:?pm/i, /פרש\s*מרקט|fresh\s*market/i, /קרפור|carrefour/i, /מחסני\s*השוק/, /סטופ\s*מרקט/, /ברקת/, /זול\s*ובגדול/, /קשת\s*טעמים/, /מכולת/, /מינימרקט/, /סופרמרקט/, /(?<![א-ת])שוק(?![א-ת])/, /מאפי/, /קצביה|אטליז/, /פירות\s*וירקות/, /ירקן/, /wolt\s*market/i]],
  ['restaurants', [/ארומה/, /aroma/i, /קפה\s*קפה/, /קפה\s*גרג|greg/i, /לנדוור|landwer/i, /רולדין|roladin/i, /מקדונלד|mcdonald/i, /בורגר\s*קינג|burger\s*king/i, /בורגראנץ|burgeranch/i, /דומינו|domino/i, /פיצה\s*האט|pizza\s*hut/i, /פאפא\s*ג.ונס/, /\bkfc\b/i, /וולט|wolt/i, /תן\s*ביס|10bis|tenbis/i, /סיבוס|cibus/i, /japanika|ג.פניקה/, /מסעד/, /restaurant/i, /קפה/, /cafe|coffee/i, /פיצ/, /pizza/i, /שווארמה|פלאפל|חומוס|סושי|sushi|בורגר|burger|שיפודי|גריל|grill|\bbar\b|פאב|\bpub\b/i, /starbucks/i, /cofix|קופיקס/, /אגדיר/, /מוזס/]],
  ['fuel', [/(?<![א-ת])פז(?![א-ת])|\bpaz\b/i, /(?<![א-ת])דלק(?![א-ת])/, /\bdelek\b/i, /סונול|sonol/i, /\bten\b|דור\s*אלון|\balon\b/i, /yellow|יילו/i, /תחנת\s*דלק/, /\bfuel\b/i, /תדלוק/]],
  ['transport', [/רב[\s-]*קו|rav[\s-]*kav/i, /רכבת\s*ישראל|israel\s*railways/i, /אגד|egged/i, /דן\s*(?:תחבורה|באר)|\bdan\b/i, /מטרופולין|אפיקים|קווים|נתיב\s*אקספרס|superbus|סופרבוס/i, /moovit|מוביט/i, /gett|גט\s*טקסי/i, /\buber\b/i, /מונית|taxi/i, /הרכבת\s*הקלה/]],
  ['car', [/פנגו|pango/i, /סלופארק|cellopark/i, /חניון|חניה|parking/i, /אחוזות\s*החוף/, /כביש\s*6|כביש\s*חוצה|derech\s*eretz/i, /מנהרות\s*הכרמל/, /נתיב\s*מהיר/, /מוסך|garage/i, /צמיגים|tire/i, /טסט|רישוי/, /שטיפת\s*רכב|car\s*wash/i, /שלמה\s*(?:sixt|סיקסט)|sixt|hertz|הרץ|באדג.ט|budget|אלדן|eldan/i, /ליסינג|leasing/i]],
  ['travel', [/אל\s*על|el\s*al/i, /ישראייר|israir/i, /ארקיע|arkia/i, /booking\.com|בוקינג/i, /airbnb/i, /expedia/i, /agoda/i, /hotels?\.com/i, /מלון|hotel/i, /ryanair|wizz|easyjet|lufthansa|turkish\s*air|aegean|airlines?|airways/i, /נתב.?ג|ben\s*gurion|duty\s*free|james\s*richardson|ג.יימס\s*ריצ/i, /איסתא|issta/i, /דיזנהויז|diesenhaus/i, /שירותי\s*תיירות|travel/i]],
  ['leisure', [/סינמה\s*סיטי|cinema\s*city/i, /יס\s*פלאנט|yes\s*planet/i, /רב\s*חן|lev\s*cinema|לב\s*סמדר/i, /סינמטק|cinematheque/i, /קולנוע|cinema/i, /תיאטרון|הבימה|הקאמרי|theater|theatre/i, /זאפה|zappa/i, /לאן|eventim|tixwise|leaan|כרטיסים/i, /הופעה|concert/i, /ספא|spa\b/i, /פארק|park/i, /מוזיאון|museum/i, /באולינג|bowling/i, /steam|playstation|xbox|nintendo/i, /חדר\s*כושר|gym/i, /ספורט|sport/i, /דקאתלון|decathlon/i, /בריכה/]],
  ['shopping', [/זארה|zara/i, /h\s*&\s*m|\bhm\b/i, /קסטרו|castro/i, /פוקס|fox\b/i, /גולף|golf\b/i, /רנואר|renuar/i, /תמנון|טרמינל\s*x|terminal\s*x/i, /נייקי|nike|אדידס|adidas/i, /אמזון|amazon/i, /עלי\s*אקספרס|aliexpress/i, /shein|שיין/i, /temu|טמו/i, /ebay|איביי/i, /איקאה|ikea/i, /ace\b|אייס/i, /הום\s*סנטר|home\s*center/i, /ksp/i, /באג|bug\b/i, /ivory|אייבורי/i, /מחסני\s*חשמל/, /שקם\s*אלקטריק/, /ביתילי|beitili/i, /המשביר|hamashbir/i, /מקס\s*סטוק|max\s*stock/i, /ניו\s*פארם/, /next\b/i, /אופנה|fashion/i, /נעליים|shoes/i, /פנדורה|pandora/i, /apple\s*store|istore|אייסטור/i, /etsy/i]],
];

function keywordCategory(desc) {
  const s = String(desc || '');
  for (const [cat, patterns] of KEYWORD_RULES) {
    for (const re of patterns) if (re.test(s)) return cat;
  }
  return null;
}

/**
 * Decide category for a transaction.
 * @param {object} t - { description, memo, amount (agorot), providerCategory }
 * @param {object} ctx - { accountType: 'bank'|'card', rules: Map<normalizedDesc, category> }
 * @returns {{category:string, source:'user'|'provider'|'auto', isCardPayment:boolean}}
 */
export function categorize(t, ctx) {
  const key = normalizeDescription(t.description);
  const isBank = ctx.accountType === 'bank';
  const cardPay = isBank && t.amount < 0 && isCardPaymentDescription(t.description);

  const rule = ctx.rules?.get(key);
  if (rule && isValidCategory(rule)) {
    return { category: rule, source: 'user', isCardPayment: isBank && rule === 'card-payment' };
  }
  if (cardPay) return { category: 'card-payment', source: 'auto', isCardPayment: true };

  const text = `${t.description || ''} ${t.memo || ''}`;
  const kw = keywordCategory(t.description) ?? keywordCategory(text);

  // Income/transfer keywords outrank the card provider's generic category.
  if (kw === 'salary' || kw === 'transfers' || kw === 'cash' || kw === 'fees') {
    if (!(kw === 'salary' && t.amount < 0)) return { category: kw, source: 'auto', isCardPayment: false };
  }
  let prov = mapProviderCategory(t.providerCategory);
  // Fuel is fuel only: a known merchant (electricity company, parking / toll road, station) outranks
  // the card company's category here, and a mixed "fuel, electricity and gas" category follows it.
  if (kw && ['fuel', 'bills', 'car'].includes(kw) && (prov === 'fuel-or-bills' || ['fuel', 'bills', 'car', 'transport'].includes(prov))) {
    return { category: kw, source: 'auto', isCardPayment: false };
  }
  if (prov === 'fuel-or-bills') prov = kw ? null : 'fuel'; // unknown merchant there: most often a station
  if (prov) return { category: prov, source: 'provider', isCardPayment: false };
  if (kw && kw !== 'salary') return { category: kw, source: 'auto', isCardPayment: false };

  // Fallbacks: money coming into a bank account is income unless recognised otherwise.
  if (isBank && t.amount > 0) return { category: 'salary', source: 'auto', isCardPayment: false };
  return { category: 'other', source: 'auto', isCardPayment: false };
}
