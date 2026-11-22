// Israeli business figures, by the date they apply from. One place to update when the law changes.
// Sources (checked 2026-11-20): VAT 18% from 2025-01-01; exempt-dealer (עוסק פטור) ceiling 122,833 ₪
// for 2026 (120,000 ₪ in 2025); invoice allocation number (מספר הקצאה) needed above 10,000 ₪ before
// VAT from 2026-01-01 and above 5,000 ₪ from 2026-06-01.

const VAT = [
  { from: '2015-10-01', rate: 0.17 },
  { from: '2025-01-01', rate: 0.18 },
];

const EXEMPT_CEILING = [ // agorot, per calendar year
  { year: 2025, amount: 120000_00 },
  { year: 2026, amount: 122833_00 },
];

const ALLOCATION_THRESHOLD = [ // agorot, before VAT
  { from: '2025-01-01', amount: 20000_00 },
  { from: '2026-01-01', amount: 10000_00 },
  { from: '2026-06-01', amount: 5000_00 },
];

const byDate = (table, date) => {
  let hit = table[0];
  for (const r of table) if (r.from <= date) hit = r;
  return hit;
};

/** VAT rate on a date (0.18 = 18%). */
export const vatRate = (date) => byDate(VAT, date).rate;

/** Exempt-dealer ceiling for a year, in agorot (the latest known year for later years). */
export function exemptCeiling(year) {
  let hit = EXEMPT_CEILING[0];
  for (const r of EXEMPT_CEILING) if (r.year <= year) hit = r;
  return hit.amount;
}

/** Above this pre-VAT amount (agorot) an expense invoice needs an allocation number to claim VAT. */
export const allocationThreshold = (date) => byDate(ALLOCATION_THRESHOLD, date).amount;

export const BUSINESS_TYPES = ['exempt', 'licensed', 'company'];
export const VAT_PERIODS = ['monthly', 'bimonthly'];
/** VAT report and payment due on this day of the month after the period (an estimate shown as such). */
export const VAT_DUE_DAY = 15;
