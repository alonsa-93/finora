// Minimal file logger. Never pass credentials, raw scraper errors, merchant names, amounts,
// user names or paths here - callers must scrub first (see errors.js). Messages are single-line.
//
// Retention: the active file rotates at 2 MB or when it is older than a day; rotated files
// (finora-<date>.log) are deleted after 30 days.
// Security events (securityEvent) are rate-limited per key to one line per minute, with a count of
// what was suppressed.
import { appendFileSync, statSync, renameSync, readdirSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 24 * 3600 * 1000;
export const RETENTION_DAYS = 30;

let dir = null;
let file = null;
let checked = 0;
function target() {
  if (!file) {
    dir = join(dataDir(), 'logs');
    file = join(dir, 'finora.log');
    pruneLogs();
  }
  return file;
}

/** Delete rotated log files older than RETENTION_DAYS. */
export function pruneLogs(now = Date.now()) {
  try {
    const d = dir || join(dataDir(), 'logs');
    for (const f of readdirSync(d)) {
      if (!/^(finora|moneycash)(-[\dT-]+)?\.log(\.1)?$/.test(f) || f === 'finora.log') continue; // moneycash*: before 1.1
      const p = join(d, f);
      try { if (now - statSync(p).mtimeMs > RETENTION_DAYS * 24 * 3600 * 1000) unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* no log dir yet */ }
}

/** Time of the first line of a log file (its ISO prefix), else the fallback. */
export function firstLineTime(f, fallback) {
  try {
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(24);
    try { readSync(fd, buf, 0, 24, 0); } finally { closeSync(fd); }
    const t = Date.parse(buf.toString('utf8'));
    return Number.isFinite(t) ? t : fallback;
  } catch { return fallback; }
}

function rotateIfNeeded(f) {
  const now = Date.now();
  if (now - checked < 10000) return;
  checked = now;
  try {
    const st = statSync(f);
    // The age comes from the first line's timestamp, not the file's creation time: Windows gives a
    // file re-created under the same name within seconds the old creation time ("tunnelling"), so
    // birthtime made it rotate every 10 seconds, one log file per line.
    if (st.size > MAX_BYTES || now - firstLineTime(f, st.mtimeMs) > MAX_AGE_MS) {
      const stamp = new Date(now).toISOString().slice(0, 19).replace(/:/g, '-');
      renameSync(f, join(dir, `finora-${stamp}.log`));
      pruneLogs(now);
    }
  } catch { /* file does not exist yet */ }
}

function write(level, msg) {
  const line = `${new Date().toISOString()} ${level} ${String(msg).replace(/[\r\n]+/g, ' ')}\n`;
  try {
    const f = target();
    rotateIfNeeded(f);
    appendFileSync(f, line, 'utf8');
  } catch { /* logging must never crash the app */ }
  if (level !== 'DEBUG' && !process.env.FINORA_QUIET) process.stdout.write(line);
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};

const limiter = new Map(); // key -> { until, suppressed }
const SECURITY_WINDOW_MS = 60 * 1000;

/**
 * Security-relevant event: `security event=<name> <detail>`.
 * detail must be free of PII (ids, codes and counts only).
 * rateKey: events sharing a key are logged at most once a minute (default: the event name);
 * null = never rate-limited (rare, user-initiated events).
 */
export function securityEvent(event, detail = '', { rateKey = event, level = 'warn' } = {}) {
  const safeEvent = String(event).replace(/[^\w.-]/g, '_').slice(0, 40);
  if (rateKey !== null) {
    const now = Date.now();
    const st = limiter.get(rateKey);
    if (st && now < st.until) { st.suppressed += 1; return; }
    const suppressed = st?.suppressed || 0;
    limiter.set(rateKey, { until: now + SECURITY_WINDOW_MS, suppressed: 0 });
    if (limiter.size > 500) limiter.clear();
    write(level === 'info' ? 'INFO' : 'WARN', `security event=${safeEvent} ${detail}${suppressed ? ` suppressed=${suppressed}` : ''}`.trim());
    return;
  }
  write(level === 'info' ? 'INFO' : 'WARN', `security event=${safeEvent} ${detail}`.trim());
}

/** Forget the cached log path (after a wipe). */
export function resetLog() { file = null; dir = null; checked = 0; limiter.clear(); }
