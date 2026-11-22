// Small, pure statistics used by the annual review and the price trends (server/annual.js,
// server/prices.js). Everything here works on plain numbers (callers pass agorot) and is
// deterministic. The rules of thumb that keep the conclusions honest live here as constants:
// minimum sample sizes, robust centres (median, trimmed mean) and "flat" bands.

/** A series needs at least this many months before we fit a trend line or compare quarters. */
export const MIN_TREND_MONTHS = 6;
/** Fitted change over the period below this share of the starting level is called "flat". */
export const FLAT_PCT = 5;
/** ...and so is a line that explains less than this share of the month-to-month variance. */
export const MIN_R2 = 0.2;

export function median(nums) {
  const s = nums.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(nums) {
  const s = nums.filter((v) => Number.isFinite(v));
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

/** (cur - prev) / prev in %, one decimal. null when there is no positive baseline. */
export function pctChange(cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/**
 * Least-squares line through (i, values[i]); null entries are skipped (months without data).
 * @returns {{slope, intercept, r2, n, x0, x1}|null} slope is per step (per month)
 */
export function linearFit(values) {
  const pts = [];
  values.forEach((v, i) => { if (Number.isFinite(v)) pts.push([i, v]); });
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (const [x, y] of pts) ssRes += (y - (intercept + slope * x)) ** 2;
  const r2 = syy === 0 ? 0 : Math.max(0, 1 - ssRes / syy);
  return { slope, intercept, r2, n, x0: pts[0][0], x1: pts[n - 1][0] };
}

export const DIRECTION_HE = { up: 'במגמת עלייה', down: 'במגמת ירידה', flat: 'יציב' };

/**
 * Trend of a monthly series. null below `minN` points (no claims from a handful of months).
 * Relative mode (money): the change is judged against the fitted starting level.
 * Absolute mode (a rate in percentage points): judged against `flatAbs` points.
 * @returns {{slope, start, end, change, pct, r2, n, direction, label}|null}
 */
export function trend(values, { minN = MIN_TREND_MONTHS, flatPct = FLAT_PCT, minR2 = MIN_R2, absolute = false, flatAbs = 3 } = {}) {
  const fit = linearFit(values);
  if (!fit || fit.n < minN) return null;
  const start = fit.intercept + fit.slope * fit.x0;
  const end = fit.intercept + fit.slope * fit.x1;
  const change = end - start;
  const avg = mean(values);
  const base = start > 0 ? start : avg > 0 ? avg : null;
  const pct = base ? (change / base) * 100 : null;
  let direction = 'flat';
  const big = absolute ? Math.abs(change) >= flatAbs : pct != null && Math.abs(pct) >= flatPct;
  if (big && fit.r2 >= minR2 && change !== 0) direction = change > 0 ? 'up' : 'down';
  return {
    slope: fit.slope, start, end, change,
    pct: pct == null ? null : Math.round(pct * 10) / 10,
    r2: Math.round(fit.r2 * 100) / 100, n: fit.n, direction, label: DIRECTION_HE[direction],
  };
}

/**
 * First three vs last three months that have data (needs `minN` such months, so the two groups
 * never overlap). Averages, difference and % change of the averages.
 */
export function compareFirstLast(values, { size = 3, minN = MIN_TREND_MONTHS } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < Math.max(minN, size * 2)) return null;
  const first = mean(v.slice(0, size));
  const last = mean(v.slice(-size));
  return { first, last, diff: last - first, pct: pctChange(last, first) };
}

/** Coefficient of variation (population sd / mean). null under 3 points or a non-positive mean. */
export function coefficientOfVariation(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 3) return null;
  const m = mean(v);
  if (!(m > 0)) return null;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  return sd / m;
}

/**
 * Robust outliers: |x - median| above max(k * 1.4826 * MAD, minRel * median, minAbs).
 * A constant series (MAD 0) still needs to clear the relative and absolute floors.
 * @returns indexes into `values` (nulls are never outliers)
 */
export function robustOutliers(values, { k = 3, minRel = 0.15, minAbs = 0, minN = MIN_TREND_MONTHS } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < minN) return [];
  const med = median(v);
  const mad = median(v.map((x) => Math.abs(x - med)));
  const limit = Math.max(k * 1.4826 * mad, minRel * Math.abs(med), minAbs);
  const out = [];
  values.forEach((x, i) => { if (Number.isFinite(x) && Math.abs(x - med) > limit) out.push(i); });
  return out;
}

/**
 * Mean that ignores outliers: values beyond 3x / below a third of the median are dropped, then
 * 10% is trimmed from each end once there are 10 or more values.
 */
export function robustMean(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const med = median(v);
  let kept = med > 0 ? v.filter((x) => x <= med * 3 && x >= med / 3) : v;
  if (!kept.length) kept = v;
  const cut = kept.length >= 10 ? Math.floor(kept.length * 0.1) : 0;
  return mean(kept.slice(cut, kept.length - cut));
}

const nearLevel = (a, b, rel, abs) => Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

/**
 * Price levels and change points of a recurring charge (amounts in charge order).
 * - A level is a run of charges within `rel` (1%) or `abs` (1 ILS = 100 agorot) of the run's first one.
 * - A one-off charge between two runs (a pro-rated month, a one-time fee) is ignored.
 * - A change point needs the old level seen at least twice; the new level is `confirmed` once it
 *   has been charged twice (a single new charge is still reported, flagged unconfirmed).
 * - Bills that move every time (electricity, water) are `variable`: no change points are claimed.
 * @returns {{variable:boolean, levels:[{value,from,to,count}], changes:[{index, from, to, diff, pct, confirmed}]}}
 */
export function priceLevels(amounts, { rel = 0.01, abs = 100, minCharges = 3 } = {}) {
  const n = amounts.length;
  const empty = { variable: false, levels: [], changes: [] };
  if (n < minCharges) return empty;
  const runs = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && nearLevel(amounts[i], last.value, rel, abs)) { last.to = i; last.count++; } else runs.push({ value: amounts[i], from: i, to: i, count: 1 });
  }
  const glitches = runs.filter((r, i) => r.count === 1 && i > 0 && i < runs.length - 1);
  if (glitches.length > 1 || runs.length > Math.max(4, Math.ceil(n / 2))) return { ...empty, variable: true, levels: runs };
  // drop a single in-between charge, then merge neighbours that are the same level
  const kept = runs.filter((r, i) => !(r.count === 1 && i > 0 && i < runs.length - 1));
  const levels = [];
  for (const r of kept) {
    const last = levels[levels.length - 1];
    if (last && nearLevel(r.value, last.value, rel, abs)) { last.to = r.to; last.count += r.count; } else levels.push({ ...r });
  }
  // the level's value: the most recent charge in it (a price is what is charged now)
  for (const l of levels) {
    for (let i = l.to; i >= l.from; i--) { if (nearLevel(amounts[i], l.value, rel, abs)) { l.value = amounts[i]; break; } }
  }
  const changes = [];
  for (let k = 1; k < levels.length; k++) {
    const a = levels[k - 1];
    const b = levels[k];
    if (a.count < 2) continue;
    changes.push({ index: b.from, from: a.value, to: b.value, diff: b.value - a.value, pct: pctChange(b.value, a.value), confirmed: b.count >= 2 });
  }
  return { variable: false, levels, changes };
}

/**
 * Mann-Whitney U test (normal approximation with tie correction): are the values in `b` typically
 * larger (z > 0) or smaller (z < 0) than in `a`? |z| >= 1.96 ~ two-sided p < 0.05. Rank based, so a
 * single huge receipt cannot carry it. null when either sample has fewer than 3 values.
 */
export function mannWhitneyZ(a, b) {
  const x = a.filter(Number.isFinite); const y = b.filter(Number.isFinite);
  const n1 = x.length; const n2 = y.length;
  if (n1 < 3 || n2 < 3) return null;
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((p, q) => p[0] - q[0]);
  const ranks = new Array(all.length);
  let tie = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tie += t ** 3 - t;
    i = j + 1;
  }
  let r2 = 0;
  all.forEach((p, i) => { if (p[1] === 1) r2 += ranks[i]; });
  const u2 = r2 - (n2 * (n2 + 1)) / 2;
  const n = n1 + n2;
  const sd = Math.sqrt((n1 * n2 / 12) * ((n + 1) - tie / (n * (n - 1))));
  if (sd === 0) return 0;
  return (u2 - (n1 * n2) / 2) / sd;
}

/**
 * Did the number of visits really change between two equally long periods? Conditional on the
 * total, under "no change" each visit falls in either period with p = 1/2, so
 * z = (v2 - v1) / sqrt(v1 + v2). |z| >= 1.96 ~ p < 0.05.
 */
export function countChangeZ(v1, v2) {
  const n = v1 + v2;
  return n > 0 ? (v2 - v1) / Math.sqrt(n) : 0;
}

/**
 * Split a change in spending at one merchant into "more visits" and "bigger tickets":
 *   S1 = v1 * t1, S2 = v2 * t2, S2 - S1 = (v2 - v1) * t1  +  v2 * (t2 - t1)   (exact).
 * v = visits in the period, t = average ticket.
 */
export function decomposeSpend({ v1, t1, v2, t2 }) {
  const frequency = (v2 - v1) * t1;
  const ticket = v2 * (t2 - t1);
  return { total: frequency + ticket, frequency, ticket };
}
