// One scrape of one connection, shared by the in-process path and the isolated sync worker
// (sync-worker.js). Read-only: it only calls israeli-bank-scrapers' scrape().
import { launchScrapeBrowser } from './browser.js';
import { scrub } from './errors.js';
import { wrapLoginForCodes } from './login-wait.js';

export const CONNECTION_TIMEOUT_MS = 8 * 60 * 1000;

function withTimeout(promise, ms, signal) {
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ success: false, errorType: 'TIMEOUT', errorMessage: 'overall timeout' }), ms);
    }),
    new Promise((resolve) => {
      onAbort = () => resolve({ success: false, errorType: 'ABORTED', errorMessage: 'aborted' });
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
}

/** Every literal / escaped form of the secrets, for scrubbing (see errors.secretVariants). */
const secretsOf = (credentials) => Object.values(credentials || {}).filter((v) => typeof v === 'string');

/**
 * @param {{ companyId, startDate: string, executablePath, credentials: object, timeoutMs?, onProgress?,
 *   interactive?: boolean (visible window; the user types a one-time code into the site itself),
 *   profileDir?: string (this connection's persistent browser profile, so the site recognises the device),
 *   onBrowser?: (pid) => void, signal?: AbortSignal }} job
 * @returns {Promise<{ success, accounts?, errorType?, errorMessage?, loggedIn }>} errorMessage is scrubbed.
 */
export async function runScrape(job) {
  const secrets = secretsOf(job.credentials);
  let credentials = job.credentials;
  let scraper = null;
  let session = null;
  let loggedIn = false;
  let result;
  try {
    if (job.signal?.aborted) throw new Error('aborted');
    session = await launchScrapeBrowser(job.executablePath, { visible: !!job.interactive, profileDir: job.profileDir || null, lite: job.lite === true });
    const pid = session.browser?.process()?.pid;
    if (pid) job.onBrowser?.(pid);
    const { createScraper } = await import('israeli-bank-scrapers');
    scraper = createScraper({
      companyId: job.companyId,
      startDate: new Date(`${job.startDate}T00:00:00`),
      combineInstallments: false, // one row per instalment, dated in its own month, per-instalment amount
      // Our own pipe-only, off-the-record context. Because the key is present the library never
      // launches a browser of its own (a null context makes it fail closed instead).
      browserContext: session.context,
      verbose: false,
      timeout: 60000,
      defaultTimeout: 60000,
      navigationRetryCount: 1,
      // A visible login window takes the size of the window instead of a fixed 1024x768 viewport.
      ...(job.interactive ? { viewportSize: { width: 1100, height: 800 } } : {}),
    });
    wrapLoginForCodes(scraper, { companyId: job.companyId, interactive: !!job.interactive });
    scraper.onProgress((_company, payload) => {
      if (payload?.type === 'LOGIN_SUCCESS') loggedIn = true;
      job.onProgress?.(payload?.type);
    });
    result = await withTimeout(scraper.scrape(credentials), job.timeoutMs || CONNECTION_TIMEOUT_MS, job.signal);
  } catch (e) {
    result = { success: false, errorType: 'GENERIC', errorMessage: e?.message || String(e) };
  } finally {
    credentials = null;
  }
  // After our overall timeout the scrape promise is still running: close everything now so a
  // logged-in session does not linger.
  if (['TIMEOUT', 'ABORTED'].includes(result?.errorType) && typeof scraper?.terminate === 'function') {
    try { await scraper.terminate(false); } catch { /* ignore */ }
  }
  if (session) await session.close();
  if (result?.success) return { success: true, accounts: result.accounts || [], loggedIn };
  return {
    success: false,
    errorType: String(result?.errorType || 'GENERIC'),
    errorMessage: scrub(result?.errorMessage, secrets),
    loggedIn,
  };
}
