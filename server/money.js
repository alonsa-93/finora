// Money helpers. Internally all amounts are integer agorot (1/100 ILS) so sums never drift;
// conversion to ILS numbers happens only at the API boundary.

export const toAgorot = (ils) => {
  const n = Number(ils);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const toILS = (agorot) => (agorot == null ? null : Math.round(agorot) / 100);


/** Format for Hebrew user-facing text: "1,240 ₪", "54.90 ₪". Uses magnitude. */
/** Approximate figure ("כ-79 ₪"): always whole shekels, never agorot. */
export function fmtApprox(ils) {
  return `${Math.round(Math.abs(Number(ils) || 0)).toLocaleString('en-US')} ₪`;
}

export function fmtILS(ils) {
  const v = Math.abs(Number(ils) || 0);
  if (v >= 100) {
    return `${Math.round(v).toLocaleString('en-US')} ₪`;
  }
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? `${r} ₪` : `${r.toFixed(2)} ₪`;
}

export const fmtPct = (p) => `${Math.round(Math.abs(p))}%`;
