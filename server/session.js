// CLI / browser-mode login: the server prints/opens http://127.0.0.1:<port>/auth#<bootstrap token>.
// The fragment never reaches the server logs or a Referer; /assets/js/auth.js POSTs it once to
// /api/session, which answers with the HttpOnly SameSite=Strict mc_auth cookie and, in the body, the
// API token for X-MoneyCash (config.js). The bootstrap token
// is separate from the session token, single-use, compared in constant time, burnt after 5 wrong
// attempts, and void after BOOTSTRAP_TTL_MS (a link left in a terminal or history stays useless).
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const BOOTSTRAP_TTL_MS = 120 * 1000;

let bootstrap = null;
let armedAt = 0;
let failures = 0;

/** Create a fresh one-time bootstrap token and return it. */
export function armBootstrap(now = Date.now()) {
  bootstrap = randomBytes(32).toString('base64url');
  armedAt = now;
  failures = 0;
  return bootstrap;
}

/** True exactly once for the right token, within BOOTSTRAP_TTL_MS of arming it. */
export function consumeBootstrap(given, now = Date.now()) {
  if (bootstrap && now - armedAt > BOOTSTRAP_TTL_MS) bootstrap = null;
  if (!bootstrap || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(bootstrap);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) {
    bootstrap = null;
    return true;
  }
  failures += 1;
  if (failures >= 5) bootstrap = null;
  return false;
}

export function bootstrapPage() {
  return '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>MoneyCash</title>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
    + '<body><p id="msg">מתחבר ל-MoneyCash…</p><script src="/assets/js/auth.js"></script></body></html>';
}
