// One-time codes (SMS / app) at login. israeli-bank-scrapers types the user name and password and
// then waits ~20 s for the site to redirect. When the site asks for a one-time code instead, the
// page never moves and the library reports a plain timeout, which looks like "site busy".
// This wraps a scraper's login options:
// - automatic (headless) sync: a redirect timeout on a site known to ask for codes becomes
//   CODE_REQUIRED, so the app stops retrying (every retry sends the user another SMS) and offers a
//   login in a visible window instead;
// - visible ("interactive") login: the user types the code into the site's own page; we only wait,
//   up to CODE_WAIT_MS, until the page reaches one of the scraper's known login-result URLs.
// The code itself never passes through MoneyCash.

export const CODE_WAIT_MS = 5 * 60 * 1000;

/** Sites that ask for a one-time code on a new device, where a stuck login page means "code needed". */
export const CODE_COMPANIES = new Set(['hapoalim']);

/** Same rules as the library's own check (base-scraper-with-browser getKeyByValue), plus: a string
 * also matches with a query / hash appended, so the wait does not miss a decorated success URL. */
export async function matchLoginResult(possibleResults, url, page) {
  const value = String(url || '');
  const bare = value.split(/[?#]/)[0].toLowerCase();
  for (const [key, conditions] of Object.entries(possibleResults || {})) {
    for (const c of conditions || []) {
      let hit = false;
      if (c instanceof RegExp) hit = c.test(value);
      else if (typeof c === 'function') {
        try { hit = await c({ page, value }); } catch { hit = false; }
      } else {
        const s = String(c).toLowerCase();
        hit = value.toLowerCase() === s || bare === s.split(/[?#]/)[0];
      }
      if (hit) return key;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param scraper an israeli-bank-scrapers scraper instance (BaseScraperWithBrowser)
 * @param {{ companyId: string, interactive?: boolean, waitMs?: number, pollMs?: number }} opts
 */
export function wrapLoginForCodes(scraper, { companyId, interactive = false, waitMs = CODE_WAIT_MS, pollMs = 1000 } = {}) {
  if (typeof scraper?.getLoginOptions !== 'function') return scraper;
  const original = scraper.getLoginOptions.bind(scraper);
  scraper.getLoginOptions = (credentials) => {
    const opts = original(credentials);
    const originalPost = opts.postAction;
    if (interactive) {
      opts.postAction = async () => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          const page = scraper.page;
          if (!page || page.isClosed?.()) throw new Error('page has been closed');
          let url = '';
          try { url = await page.evaluate(() => window.location.href); } catch (e) {
            // Mid-navigation the context is briefly gone; a closed window is reported as such.
            if (/closed|disconnected|detached/i.test(String(e?.message))) throw e;
          }
          if (url && await matchLoginResult(opts.possibleResults, url, page)) {
            await sleep(1500); // let the landing page settle before the library reads it
            return;
          }
          await sleep(pollMs);
        }
        throw new Error('CODE_TIMEOUT');
      };
    } else if (CODE_COMPANIES.has(companyId) && typeof originalPost === 'function') {
      opts.postAction = async () => {
        try {
          await originalPost();
        } catch (e) {
          if (/waiting for redirect/i.test(String(e?.message))) throw new Error('CODE_REQUIRED');
          throw e;
        }
      };
    }
    return opts;
  };
  return scraper;
}
