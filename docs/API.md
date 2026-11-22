# Finora HTTP API

Local-only personal finance app. Node server on `http://127.0.0.1:4580` serves the
static dashboard from `web/` (plain ES modules, no build step) and a JSON API under `/api`.
Data is pulled read-only with `israeli-bank-scrapers`. UI language: Hebrew, RTL.

## Static routes (served by server)

- `/` → `web/index.html`, `/assets/*` → `web/assets/*` (no third-party scripts:
  the UI draws its own charts and ships the Rubik font in `web/assets/fonts`)
- `/auth` → one-time login page for browser mode (see Authentication)
- Any path containing an encoded or literal dot-segment, a dotfile segment, a backslash, `%25`,
  `%00`, `;` or an empty segment is answered with a plain 404 before static resolution.
- Headers on every response: the CSP below, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, COOP/CORP `same-origin`, and a `Permissions-Policy` that
  denies camera, microphone, geolocation, USB, serial, HID, Bluetooth, payment, clipboard-read,
  display-capture and fullscreen.
- CSP: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'`
  → **no inline scripts, no inline `style=""` attributes set from HTML, no external URLs**.
  (Setting `element.style.x` from JS is allowed.)

## Conventions

- All money is ILS numbers (not strings). In **transactions** `amount` is signed:
  negative = money out, positive = money in. In **summary/insights** `expenses` and
  `income` are positive magnitudes.
- Dates: ISO `YYYY-MM-DD`. Months: `YYYY-MM`. Timestamps: ISO 8601.
- Errors: non-2xx with `{ "error": { "code": "STRING", "message": "Hebrew, user-facing" } }`.
- Every `/api/*` request must send header `X-Finora: <apiToken>` (see Authentication); only
  `POST /api/session` sends `X-Finora: 1`. Mutating requests (POST/PATCH/DELETE) also need
  `Content-Type: application/json`. Server rejects otherwise (CSRF guard).
- Credentials go **in** via `POST /api/connections` only and are **never** returned.
- `/api/*` refuses requests whose `Sec-Fetch-Site` is `cross-site`/`same-site` (403 `FORBIDDEN`).
- After `POST /api/wipe`, every `/api/*` call answers 503 `WIPED` until the app has restarted.

## Authentication (every mode)

Every `/api/*` call needs the per-launch `mc_auth_<port>` cookie (e.g. `mc_auth_4580`). Cookies are not
port-bound and `__Host-` needs https, so the name carries the listening port: another instance on
another 127.0.0.1 port never sends or accepts it. It is 256-bit random, `HttpOnly;
SameSite=Strict; Path=/`, compared in constant time and never written to disk. Without it → 401
`UNAUTHORIZED`.

The cookie alone is not enough: other services on 127.0.0.1 can receive it, because browsers ignore
ports for cookies. Every `/api/*` call must also carry a per-launch API token in `X-Finora`
(compared in constant time). The page holds it only in memory or `sessionStorage`, never in a URL.
File downloads (CSV exports) are fetched with the header and saved through a `blob:` URL.
- **Desktop (Electron):** the shell sets the cookie for its own window and hands the API token to
  the page over IPC (`window.finora.apiToken`).
- **Browser mode (`npm start`):** the server opens `http://127.0.0.1:<port>/auth#<one-time token>`.
  The page (`/assets/js/auth.js`) removes the fragment from the address bar, POSTs it to
  `POST /api/session` (→ 200 `{ "apiToken": "..." }` + `Set-Cookie`), keeps the API token in
  `sessionStorage`, then loads `/`. The bootstrap token is separate from the session token,
  single-use, valid for 2 minutes, and burnt after 5 wrong attempts. To log in again, restart.
  A tab opened by typing the address has no API token and gets 401; use the login link.
- **Edge app window (`--app-window`):** same flow as browser mode, in an Edge `--app` window.
  If the port is taken, the CLI exits with an error and never opens whatever listens there.
- Denials (401, and 403 `BAD_HOST` / `FORBIDDEN`) are logged as rate-limited
  `security event=deny_<status> reason=...` lines, with no header values and no data.

### POST /api/session `{ "token": "<one-time bootstrap token>" }` → 200 `{ "apiToken": "..." }` + `Set-Cookie: mc_auth_<port>=...`
The only `/api` call accepted without the cookie and API token (send `X-Finora: 1`). 401 if the
token is wrong, already used or expired.

## Endpoints

### GET /api/status
```json
{ "demoMode": true, "hasConnections": false, "lastSyncAt": "2026-11-13T07:00:00Z",
  "syncing": false, "autoSync": { "enabled": true, "time": "07:00" }, "syncOnOpen": true, "version": "1.0.0",
  "diskEncryption": "on", "dataDirProtected": true }
```
`dataDirProtected`: `true | false | null`. Whether the data folder's owner-only permissions were
applied at start (`null` off Windows). `false` is also logged as `security event=acl_failed`.

`diskEncryption`: `"on" | "off" | null`. It reports BitLocker / Device Encryption of the system and
data drives, read without admin rights shortly after start. `null` means unknown or not checked yet.

`syncOnOpen` (boolean, default `true`): sync as soon as Finora opens (see *Sync on open*).

### POST /api/demo  `{ "enabled": true }` → status object
Demo data lives in a separate DB; real data is never touched by demo mode. The demo covers 25 months
(two full years before the current month) so the annual review and price trends have a previous year.
Demo is only for before the first real connection: once one exists, `demoMode` is always false and
`{ "enabled": true }` → 409 `HAS_CONNECTIONS`.

### PATCH /api/settings `{ "autoSync"?: { "enabled": true, "time": "07:00" }, "syncOnOpen"?: true }` → status object
At least one of the two keys; each is validated (400 otherwise).

### Sync on open
When the server starts (Electron launch, `npm start`, also a `--hidden` start with Windows) it runs one
check (`server/opensync.js`, `decideOpenSync`) and, when due, starts a background sync of the real
connections; the dashboard that loads next shows it through `/api/sync/status`, with no click. The same
check runs when the window comes back after being hidden for more than 30 minutes
(`RESTORE_AFTER_HIDDEN_MS`): the Electron shell on the window's `show` event, the page on
`visibilitychange` (browser mode) via `POST /api/sync/open`. Nothing starts when:
- `syncOnOpen` is off → reason `disabled`;
- there are no real connections (demo mode with nothing connected) → `no-connections`;
- a sync is running → `running`;
- every connection is paused after failed logins (`needs_credentials`) → `paused`. Paused connections
  are always left out (`startSync(..., { skipPaused: true })`); the lockout rules are unchanged;
- every remaining connection finished a sync (ok or failed) within 30 minutes
  (`OPEN_SYNC_MIN_INTERVAL_MS`) → `recent`.
Otherwise → `stale`, and the sync starts.

### POST /api/sync/open `{}` → `{ "started": true, "reason": "stale", "status": <sync-status object> }`
Runs the sync-on-open check now (the page calls it after 30+ minutes in the background).

### GET /api/companies
Institutions supported by the scraper library.
```json
[{ "id": "hapoalim", "name": "בנק הפועלים", "type": "bank",
   "loginFields": [{ "key": "userCode", "label": "קוד משתמש", "secret": false },
                   { "key": "password", "label": "סיסמה", "secret": true }],
   "supported": true, "note": null }]
```
`type`: `"bank" | "card"`. `supported:false` + Hebrew `note` when it needs an SMS code each login.

### GET /api/connections
```json
[{ "id": 1, "companyId": "max", "companyName": "מקס", "type": "card", "nickname": "מקס שלי",
   "createdAt": "…", "lastSyncAt": "…", "lastStatus": "ok", "lastError": null,
   "needsCodeLogin": false }]
```
`lastStatus`: `"never" | "ok" | "error"`. `lastError` is a Hebrew user-facing string.
`needsCodeLogin`: the site asked for a one-time code (SMS). Automatic syncs skip the connection
(each attempt would send another SMS) until one interactive sync succeeds.

### POST /api/connections
`{ "companyId": "max", "nickname": "מקס שלי", "credentials": { "username": "…", "password": "…" } }`
→ 201 connection object (no credentials).

### PATCH /api/connections/:id
`{ "nickname"?: "…", "credentials"?: { … } }` → updated connection object. Re-saving
credentials clears the "invalid password — retries paused" block. 409 `DEMO_MODE` in demo mode.

### DELETE /api/connections/:id?deleteData=true|false → 204
Always deletes the connection and its sealed credentials. With `deleteData=true` it also deletes
the connection's accounts and transactions, and every merchant `rule` that no remaining transaction
uses. Deleted rows are zeroed in memory (`secure_delete`) and the DB is `VACUUM`ed. The encrypted
snapshot is then rewritten with the previous generation dropped, so no copy of the deleted rows
stays in Finora's files. 409 `SYNC_RUNNING`.

### POST /api/wipe `{ "confirm": "מחק" }` → 200 `{ "ok": true, "restarting": true, "leftovers": 0 }`
Deletes everything Finora stores, in this order:
1. Stops a running sync, which closes its browser.
2. **Crypto-shreds** the data key: `keys/dek.json` is overwritten and deleted, and the key is zeroed
   in memory. From then on, every copy of the encrypted data anywhere (backups, restore points, SSD
   remnants) is undecryptable. This step is the only guarantee for old physical blocks.
3. Deletes the encrypted DBs (both generations), any legacy plaintext DB files, the logs,
   `desktop.json`, and scraper profiles (`run/`, `%TEMP%\puppeteer_dev_*`).
4. Desktop app: clears Electron's storage and cache, turns "Start with Windows" off, relaunches, and
   deletes the Electron profile folder on that start (`wipe-pending` marker).
   Browser mode: restarts the server, which opens a new login tab.

The app then starts in first-run state (new key, demo mode). 400 `CONFIRM_REQUIRED` unless
`confirm` is exactly `מחק`; 409 `WIPE_RUNNING`. CSV files the user exported earlier are not touched.

### POST /api/sync  `{ "connectionId": 1 }` (omit for all) → 202 sync-status object
409 `SYNC_RUNNING` if already running.
`{ "connectionId": 1, "interactive": true }`: real mode only, one connection. Opens a visible window
of the site; Finora fills in the user name and password and the user types the one-time code
into the site's own page (it never passes through Finora). Waits up to 5 minutes for the login.
Sites that ask for codes keep a per-connection browser profile (`profiles/conn-<id>` in the data
folder, deleted with the connection) so the site recognises the computer on later syncs.
400 `BAD_REQUEST` without `connectionId`, in demo mode, or when `interactive` is not a boolean.
- A connection whose login failed as wrong password / blocked, or failed 3 times in a row without
  reaching a confirmed login, is not retried until its credentials are re-saved
  (`PATCH /api/connections/:id`); its `lastError` explains why.

### GET /api/sync/status
```json
{ "running": true, "startedAt": "…", "finishedAt": null,
  "items": [{ "connectionId": 1, "companyName": "מקס", "state": "running",
              "message": "מתחבר…", "newTransactions": 0 }] }
```
`state`: `"pending" | "running" | "ok" | "error"`.

### GET /api/accounts
```json
[{ "id": 3, "connectionId": 1, "companyId": "max", "companyName": "מקס", "type": "card",
   "accountNumber": "1234", "name": "מקס •1234", "balance": null, "lastSyncAt": "…" }]
```
`balance` is the current balance for bank accounts, `null` for cards.

### GET /api/categories
```json
[{ "id": "groceries", "name": "סופר ומכולת", "color": "#2f9e77", "kind": "expense" }]
```
`kind`: `"expense" | "income" | "neutral"`. `neutral` (transfers, card payments) never counts as spending.

### GET /api/transactions
Query: `from`, `to`, `month`, `accountId`, `category`, `q` (text search; a number also matches the
amount: `249` = 249.00–249.99, `249.90` exactly), `direction` (`in|out`), `kind` (`spending|income`), `months` (`YYYY-MM,YYYY-MM`: several months together), `sort` (`date|amount`), `order` (`asc|desc`), `limit` (default 50, max 500), `offset`.
```json
{ "total": 812, "sumOut": 14320.5, "sumIn": 21000,
  "items": [{ "id": 991, "date": "2026-11-02", "processedDate": "2026-12-10",
    "description": "שופרסל דיל", "memo": null, "amount": -412.3,
    "originalAmount": -412.3, "originalCurrency": "ILS",
    "category": "groceries", "categorySource": "auto",
    "accountId": 3, "accountName": "מקס •1234", "accountType": "card",
    "installments": { "number": 2, "total": 6 }, "status": "completed",
    "isCardPayment": false, "excluded": false }] }
```
`sumOut`/`sumIn` cover all matching rows except `excluded` ones and `isCardPayment` rows while
card accounts are connected (the same rows the UI labels as not counted); `total` counts every row.
`sumNet` = `sumIn − sumOut` (computed in agorot on the server, so the UI never does money arithmetic).
With `sort=date` (the default) the response also has `"days": [{ "date": "2026-11-02", "count": 7,
"sumOut": 1240.5, "sumIn": 0 }]`: one entry per day that appears in this page's `items`, totalling
**every** matching row of that day (also rows on other pages), with the same counted rule as
`sumOut`/`sumIn`. The transactions screen shows it in the sticky day headers. No `days` with `sort=amount`.
`categorySource`: `"auto" | "user" | "provider"`. `status`: `"completed" | "pending"`.
`isCardPayment`: a bank-account line that is the monthly credit-card debit. It is excluded
from spending totals when card accounts are connected (prevents double counting).
`excluded`: user chose to leave it out of totals.
`kind=spending` returns exactly the rows behind the overview / annual expense figure (purchases and
their refunds, no transfers, no card debit while cards are connected) and adds
`"net": { "kind": "spending", "gross": 14227.15, "offsets": 199.9, "total": 14027.25 }`: `total`
equals the headline (per category and month, refunds subtract and a category never goes below 0).
`kind=income` likewise for income (`offsets` = reversals).

### PATCH /api/transactions/:id
`{ "category": "groceries", "applyToSimilar": true, "excluded": false }` → updated transaction.
`applyToSimilar` (default **false**: only this row) saves a rule so the same merchant is categorised
this way from now on (and re-categorises existing non-user rows). Response adds `"affected": 14` and
`"undoId": "…"`.

### GET /api/transactions/:id/similar?category=<id>
`{ "count": 30, "merchant": "שופרסל דיל", "hasRule": false }`: how many other rows `applyToSimilar`
would change, so the UI asks ("להחיל גם על 30 תנועות דומות מ-שופרסל דיל?") before doing it.

### POST /api/transactions/undo `{ "undoId": "…" }` → `{ "restored": 31, "ruleReverted": true }`
Reverts one PATCH: the rows it changed (category, source, card-payment flag, exclusion) and the merchant
rule as it was before (deleted if there was none). Rows edited again since are left alone. Ids live in
memory (newest 30, 30 minutes, the database they came from); unknown / expired → 410 `UNDO_EXPIRED`.

### GET /api/summary?month=YYYY-MM  (default: current month)
```json
{ "month": "2026-11", "isCurrentMonth": true, "daysInMonth": 30, "dayOfMonth": 13,
  "availableMonths": ["2026-11", "2026-10"],
  "totals": { "income": 21000, "expenses": 9120, "net": 11880,
              "prevIncome": 20800, "prevExpenses": 13900,
              "prevExpensesSameDay": 8100, "expensesChangePct": 12.6 },
  "balances": { "bankTotal": 18250.4, "upcomingCardCharges": 6240,
                "accounts": [{ "accountId": 1, "name": "פועלים •5521", "type": "bank",
                               "balance": 18250.4, "monthSpend": null },
                             { "accountId": 3, "name": "מקס •1234", "type": "card",
                               "balance": null, "monthSpend": 4120 }] },
  "byCategory": [{ "category": "groceries", "name": "סופר ומכולת", "color": "#2f9e77",
                   "amount": 2310, "prevAmount": 2890, "avg3m": 2700, "count": 14 }],
  "daily": [{ "date": "2026-11-01", "expenses": 320, "cumulative": 320, "prevCumulative": 410 }],
  "monthly": [{ "month": "2025-12", "income": 20500, "expenses": 13100 }],
  "forecast": { "projectedExpenses": 13800, "low": 12900, "high": 14900 },
  "upcoming": [{ "description": "נטפליקס", "amount": 54.9, "expectedDate": "2026-11-18",
                 "kind": "recurring" }],
  "topMerchants": [{ "description": "שופרסל דיל", "amount": 1240, "count": 6 }] }
```
- `expensesChangePct` compares to `prevExpensesSameDay` for the current month
  (same day-of-month last month), to `prevExpenses` for past months. `null` if no baseline.
- `daily` covers every day of the month; for the current month, days after today have
  `expenses: null, cumulative: null` but keep `prevCumulative`.
- `monthly` is the last 12 months ascending, including the selected one.
- `forecast` is `null` for past months or when there is under 5 days of data.
- `upcoming.kind`: `"recurring" | "installment" | "cardCharge"`.
- `byCategory` is expenses only, sorted by amount desc.

#### Longer periods: `GET /api/summary?period=m1|m3|ytd|y1` · `?months=YYYY-MM,YYYY-MM` · `?from=YYYY-MM-DD&to=YYYY-MM-DD`
`m1` / `m3` / `y1`: the last month / 3 months / 12 months up to today (rolling); `ytd`: from 1 January.
`months`: any set of months picked together (up to 36, not in the future; need not be consecutive).
`from`/`to`: a date range (`to` is capped at today). The response has the same blocks as the month
view plus `"mode": "period"`, `period` `{ kind, from, to, months? }`, `previous` (what it is compared
with: the same months a year earlier for `months`, otherwise the equally long window right before),
`isCurrent` (ends today), `days`, `periodMonthly` (each month in the period, clipped to it).
Differences: `totals` has no `prevExpensesSameDay`; `byCategory[].prevAmount` is the previous
period's amount and there is no `avg3m`; `daily` is `null` for a set of months or a window over 62
days (indexes align with `previous`); `forecast` is always `null`; `upcoming` only when `isCurrent`;
`accounts[].monthSpend` is the card's spending in the period. 400 for an invalid or empty period.

### GET /api/insights?month=YYYY-MM
Plain-language conclusions, most important first (max ~8).
```json
[{ "id": "cat-spike-restaurants", "type": "categorySpike", "severity": "warning",
   "title": "ההוצאה על מסעדות גבוהה ב-38% מהרגיל",
   "body": "הוצאת 1,240 ₪ החודש, לעומת ממוצע של 900 ₪ בשלושת החודשים האחרונים.",
   "amount": 340, "category": "restaurants",
   "action": { "label": "הצג תנועות", "filter": { "category": "restaurants", "month": "2026-11" } } }]
```
`type`: `categorySpike | categoryDrop | subscription | duplicateCharge | unusualCharge |
forecast | newMerchant | feeCharge | lowBalance | savingsRate | priceIncrease`.
`severity`: `"good" | "info" | "warning" | "alert"`.
`action.filter` uses the same keys as the `/api/transactions` query (plus optional `ids: [..]`,
which `/api/transactions` also accepts as `ids=1,2,3`).

### GET /api/position?months=YYYY-MM,YYYY-MM,...
The overview's first screen: where the user stands now. `months` (optional, at most 36, future months
dropped) picks the months of the trends; default: the last 6 up to the current one.
```json
{ "today": "2026-11-20", "months": ["2026-06", "...", "2026-11"], "afterCards": 4500,
  "bank": { "hasData": true, "current": 10000, "asOf": "2026-11-20T08:00:00Z",
            "accounts": [{ "id": 1, "name": "פועלים •1234", "balance": 10000 }],
            "monthStart": 12000, "changeThisMonth": -2000, "historyFrom": "2026-06-01",
            "months": [{ "month": "2026-10", "label": "אוקטובר 2026", "complete": true,
                         "open": 1000, "close": 12000, "low": 1000, "high": 16000, "in": 15000, "out": 4000,
                         "series": [{ "date": "2026-10-01", "balance": 16000 }] }] },
  "cards": { "hasData": true, "current": 5500, "nextChargeDate": "2026-12-10", "nextChargeAmount": 5000,
             "cards": [{ "id": 2, "name": "מקס •1111", "current": 4000, "nextChargeDate": "2026-12-10" }],
             "average": 3000, "averageMonths": 5, "thisMonth": 2500,
             "months": [{ "month": "2026-11", "label": "נובמבר 2026", "complete": false, "total": 2500,
                          "byCard": [{ "id": 2, "amount": 2500 }] }] },
  "redFlags": [{ "type": "cardAboveNormal", "severity": "alert", "title": "…", "body": "…", "tip": "…",
                 "action": { "label": "הצג תנועות", "filter": { "ids": [1, 2] } } }],
  "insights": [] }
```
- `bank.current`: the sum of the bank accounts' balances. The daily `series` is rebuilt **backwards**
  from it with completed bank rows only; `balance` is `null` before the first known movement.
- `cards.current`: card charges not yet taken from the bank (pending, or processed after today);
  `months[].total` is the bill by charge (processed) month; `average` is over complete months.
- `afterCards`: `bank.current - cards.current` (`null` without both).
- `redFlags`: `alert`/`warning` items, the most serious first: the month's insights (as in
  `/api/insights`) plus `cardAboveNormal` (the upcoming bill > 1.2 × `average` and ≥ 500 ₪ above it, at least 3 complete months; `alert` above 1.5 ×) and `bankDecline`
  (the bank balance fell three complete months running). `insights`: the rest. Every item has a `tip`
  ("מה לעשות").

### GET /api/recurring
```json
[{ "description": "נטפליקס", "category": "subscriptions", "amount": 54.9, "cadence": "monthly",
   "lastDate": "2026-10-18", "nextDate": "2026-11-18", "monthsSeen": 9, "yearlyCost": 658.8,
   "variable": false,
   "priceChange": { "from": 49.9, "to": 54.9, "pct": 10, "date": "2026-10-18", "confirmed": false, "yearly": 60 } }]
```
`priceChange` is THE shared definition (`analytics.latestPriceChange`): the latest change point (see
price trends) dated from the first day of the month 12 months back up to today; `null` for `variable`
bills. `/api/price-trends` `recurring[].latestChange` uses the same function, so both screens agree.

### Annual window (shared by the three endpoints below)
`end=YYYY-MM` is the last month of a 12-month window. **Default: the last complete month** (the month
before today's), because the current month is partial and would make the year look cheaper. Any
complete month may be chosen; a month after the last complete one → 400 `BAD_REQUEST`.
- A month counts as *covered* from the first full month of data on (a first month that starts after the
  3rd is partial and left out) up to the last complete month. Uncovered months are `null`, never 0.
- The **previous year** (the 12 months before the window) is reported only when all 12 of its months
  and all 12 of the window's are covered; otherwise `previous` and `change` are `null`. Banks give
  about 12 months back (Yahav 6); history builds up locally with every sync.
- Trends and first-vs-last comparisons need **6 covered months** (`null` below that).
- Trend = least-squares line over the covered months. `direction` is `"up" | "down" | "flat"` with a
  Hebrew `label` (`במגמת עלייה` / `במגמת ירידה` / `יציב`): flat when the fitted change over the period is
  under 5% of the fitted start, or the line explains under 20% of the variance (r² < 0.2). The savings
  rate uses percentage points (flat under 3 points).

### GET /api/annual?end=YYYY-MM
```json
{ "end": "2026-10", "start": "2025-11", "months": ["2025-11", "…", "2026-10"], "from": "2025-11-01", "to": "2026-10-31",
  "coverage": { "months": 12, "firstDataMonth": "2024-11", "historyMonths": 24, "previousMonths": 12 },
  "totals": { "income": 230910, "expenses": 166907.12, "net": 64002.88, "savingsRate": 27.7, "months": 12,
              "avgMonthlyIncome": 19242.5, "avgMonthlyExpenses": 13908.93 },
  "previous": { "…same keys…" },
  "change": { "expensesPct": 6.5, "incomePct": 8.1, "netDiff": 7110.48, "savingsRatePts": 1.1 },
  "monthly": [{ "month": "2025-11", "covered": true, "income": 18450, "expenses": 12010.4, "net": 6439.6, "savingsRate": 34.9 }],
  "trends": { "income": { "slopePerMonth": 37.03, "start": 19038.85, "end": 19446.15, "changeOverPeriod": 407.31,
                          "pctOverPeriod": 2.1, "direction": "flat", "label": "יציב", "r2": 0, "months": 12 },
              "expenses": { "…" }, "net": { "…" }, "savingsRate": { "…in percentage points…" } },
  "categories": [{ "category": "restaurants", "name": "מסעדות ובתי קפה", "color": "#e8590c", "total": 11733, "share": 7,
                   "count": 86, "avgMonthly": 977.75, "monthly": [612.5, "…12 values, null when uncovered"],
                   "quarters": { "firstAvg": 785, "lastAvg": 1309, "diff": 524, "pct": 66.8 },
                   "trend": { "…" }, "prevTotal": 9120, "yoyPct": 28.7 }],
  "growers": ["restaurants"], "shrinkers": ["transport"],
  "extremes": { "median": 13325.85,
                "most":  [{ "month": "2026-07", "expenses": 19471.53, "income": 18450,
                            "driver": { "category": "travel", "name": "חופשות וטיסות", "amount": 3802.7, "avg": 845.19 } }],
                "least": [{ "…" }] },
  "fixed": { "count": 13, "monthlyNow": 7780, "yearlyNow": 93359, "avgMonthly": 7776.15, "monthly": ["…"],
             "quarters": { "…" },
             "priceChanges": { "increasesYearly": 402, "decreasesYearly": 240, "netYearly": 162,
                               "items": [{ "description": "הראל חברה לביטוח", "category": "insurance", "from": 186.4, "to": 204.9,
                                           "pct": 9.9, "yearly": 222, "date": "2026-03-15", "confirmed": true }] } },
  "instalments": { "count": 2, "remainingAmount": 3381.33, "monthlyNow": 2082.33, "lastDate": "2026-12-20",
                   "plans": [{ "description": "KSP מחשבים", "category": "shopping", "monthly": 1299, "paid": 1, "of": 3, "remaining": 2,
                               "remainingAmount": 2598, "nextDate": "2026-11-20", "lastDate": "2026-12-20", "filter": { "ids": [986] } }],
                   "byMonth": [{ "month": "2026-11", "amount": 1299 }, { "month": "2026-12", "amount": 2082.33 }] },
  "incomeStability": { "cv": 0.106, "level": "variable", "median": 18450,
                       "unusual": [{ "month": "2026-04", "income": 25950, "diff": 7500 }] },
  "availableEnds": ["2026-10", "2026-09", "…"] }
```
- `categories[].quarters` / `trend` (and `growers` / `shrinkers`) leave instalment plans out: a purchase
  in payments is not a habit that grew. `total`, `share`, `monthly` keep everything.
- Grower: first-vs-last-3-months average up ≥ 100 ₪/month and ≥ 20%, trend `up`, year total ≥ 1,200 ₪
  (shrinker: mirrored, trend `down`).
- `fixed`: recurring charges active today (`/api/recurring`); `monthlyNow` = monthly equivalent of their
  current price; `priceChanges` = change points inside the window (see price trends).
- `instalments`: plans with payments left, whose latest payment is ≤ 62 days old; forward-looking (not
  limited to the window). `byMonth`: from the current month, payments after today.
- `incomeStability`: needs 6 covered months. `level` by coefficient of variation: `stable` < 0.10 ≤
  `variable` < 0.25 ≤ `irregular`. `unusual`: |income − median| > max(3 × 1.4826 × MAD, 15% of the
  median, 1,000 ₪).
- `extremes`: needs 6 covered months; `driver` = the category furthest above (most) / below (least) its
  monthly average.

### GET /api/annual/insights?end=YYYY-MM
Year-level conclusions, same shape as `/api/insights`, in a fixed narrative order (max 10). Titles always
start with a Hebrew word; every one has an `action.filter` (`from`/`to`, `category`, `direction`, `month`
or `ids`, at most 500).

| `type` | when (thresholds) | `amount` |
|---|---|---|
| `yearCoverage` | under 6 covered months (then only this, plus the two below that don't need history) | expenses so far |
| `yearSpending` | always from 6 months: total spent, vs the previous year when it exists, with the income change | expenses |
| `yearSavings` | income ≥ 1,000 ₪ per covered month: what was left, % of income, vs previous year | net |
| `yearIncome` | median of the first 3 vs last 3 covered months differs by ≥ 300 ₪ and ≥ 3% | monthly difference |
| `fixedCostsChange` | recurring price increases in the window ≥ 100 ₪/year (or only decreases ≥ 100 ₪/year → `good`) | yearly increase |
| `merchantTicket` | a frequent merchant's average purchase moved (see price trends) and the yearly effect ≥ 200 ₪; max 2. Always "הקנייה הממוצעת", never "המחירים" | yearly effect |
| `categoryTrendUp` | a grower (see above); max 2 | monthly difference |
| `expensiveMonth` | the costliest month ≥ 1.2 × the median month and ≥ 1,500 ₪ above it | excess over median |
| `unusualIncome` | an `incomeStability.unusual` month (one insight; several months → one combined) | difference |
| `merchantFrequency` | visits changed (ticket flat) with a yearly effect ≥ 500 ₪ | yearly effect |
| `categoryTrendDown` | a shrinker; max 1 | monthly saving |
| `instalmentsAhead` | open instalments ≥ 500 ₪ | remaining amount |

Every item also carries `tip`: what to do about it (`ANNUAL_TIPS` in `server/annual.js`; `null` for `yearCoverage`).

### GET /api/price-trends?end=YYYY-MM
```json
{ "start": "2025-11", "end": "2026-10", "changesFrom": "2025-11-01", "changesTo": "2026-11-14",
  "dataStart": "2025-11", "dataMonths": 12, "compare": { "first": ["2025-11", "2026-01"], "last": ["2026-08", "2026-10"] },
  "rules": { "minVisits": 10, "minMonths": 6, "minQuarterVisits": 5, "ticketPct": 10, "ticketAbs": 15,
             "medianAgree": 0.05, "ticketZ": 1.96, "freqPct": 25, "freqAbs": 3, "freqZ": 1.96 },
  "totals": { "recurringIncreasesYearly": 402, "recurringDecreasesYearly": 240, "recurringNetYearly": 162 },
  "increases": [{ "kind": "merchant", "key": "mer:שופרסל דיל", "description": "שופרסל דיל", "category": "groceries",
                  "from": 278.47, "to": 346.22, "pct": 24.3, "yearly": 3252, "date": null, "confirmed": true },
                { "kind": "recurring", "key": "rec:הראל חברה לביטוח", "from": 186.4, "to": 204.9, "pct": 9.9, "yearly": 222,
                  "date": "2026-03-15", "confirmed": true, "…": "…" }],
  "decreases": [{ "…yearly negative…" }],
  "recurring": [{ "key": "rec:…", "description": "NETFLIX.COM", "category": "subscriptions", "cadence": "monthly", "amount": 54.9,
                  "yearlyCost": 658.8, "variable": false, "levelChange": null,
                  "history": [{ "date": "2024-11-18", "amount": 49.9 }],
                  "changes": [{ "date": "2026-10-18", "from": 49.9, "to": 54.9, "pct": 10, "yearly": 60, "confirmed": false, "inWindow": true }],
                  "latestChange": { "date": "2026-10-18", "from": 49.9, "to": 54.9, "pct": 10, "yearly": 60, "confirmed": false },
                  "filter": { "ids": [] } }],
  "merchants": [{ "key": "mer:…", "description": "שופרסל דיל", "category": "groceries", "visits": 48, "months": 12, "total": 14923,
                  "driver": "ticket", "enoughData": true,
                  "ticket": { "from": 278.47, "to": 346.22, "medianFrom": 278, "medianTo": 346.15, "pct": 24.3, "direction": "up" },
                  "frequency": { "from": 4, "to": 4, "pct": 0, "direction": "flat" },
                  "yearlyEffect": { "total": 3252, "frequency": 0, "ticket": 3252 },
                  "monthly": [{ "month": "2025-11", "visits": 4, "avgTicket": 279.35, "medianTicket": 279.1, "total": 1117.4 }],
                  "filter": { "ids": [] } }] }
```
- **Recurring** (`/api/recurring`'s detection): one charge per period; a *level* is a run of charges
  within 1% / 1 ₪; a one-off charge between two runs is ignored. A change point needs the old price
  charged at least twice; `confirmed` once the new price was charged twice. Bills that move every time
  (≥ 2 one-offs, or more than max(4, n/2) levels) are `variable`: no change points, only `levelChange`
  (first 3 vs last 3 charges, when ≥ 6 charges and ≥ 10%). `yearly` = (to − from) × charges per year.
  Changes count toward totals when dated from the window start up to `changesTo` (today for the latest
  window, the window's last day otherwise).
- **Merchants**: expense rows in the window, excluding instalments, refunds, card payments, recurring
  merchants and the categories card-payment, transfers, cash, housing, fees, salary. Qualify with ≥ 10
  visits over ≥ 6 months. First vs last 3 months **that have data** inside the window (`compare`; null
under 6 such months, then nothing is compared); claims need ≥ 5 visits in each. `dataStart` is the
first month with data, so the UI never names an empty month.
  Ticket = robust mean (receipts beyond 3× / under ⅓ of the median dropped, 10% trimmed from 10
  receipts). A ticket change needs ≥ 10%, ≥ 15 ₪, the median moving the same way by ≥ 5%, and a
  Mann-Whitney rank test |z| ≥ 1.96. A visit change needs ≥ 25%, ≥ 3 visits a quarter and a Poisson check
  |z| ≥ 1.96. `yearlyEffect` splits the spending change exactly: frequency = (v₂ − v₁) × t₁, ticket = v₂ ×
  (t₂ − t₁), per quarter × 4. `driver`: `ticket | frequency | both | none`.
- `increases` / `decreases`: recurring change points in the window plus merchants whose ticket moved,
  ranked by |`yearly`| (max 8 each). `key` is stable for a UI selection (`rec:` / `mer:` + merchant key).

### POST /api/chat `{ "question": "כמה הוצאתי על סופר ב-3 החודשים האחרונים?" }` → answer
שאלות: a Hebrew question about the user's own money, answered **locally** (`server/chat.js`): no model and no
network call. The question is parsed into a fixed set of question types and answered by the same functions
the screens use, so the numbers agree with them. The question is never logged or stored (the client keeps
the conversation in memory only). POST so the question stays out of URLs; the usual `X-Finora` / JSON /
Origin guards apply. 400 `BAD_REQUEST` for a missing, empty or non-string `question` or one over 300
characters.
```json
{ "intent": "spending",
  "understood": { "period": { "from": "2026-09-01", "to": "2026-11-14", "label": "ב-3 החודשים האחרונים (1.9.2026–14.11.2026)" },
                  "comparedTo": null, "category": { "id": "groceries", "name": "סופר ומכולת" }, "merchant": null },
  "text": "הוצאת על סופר ומכולת ב-3 החודשים האחרונים (1.9.2026–14.11.2026) 5,331.40 ₪ ב-17 תנועות.",
  "parts": ["הוצאת על סופר ומכולת ב-3 החודשים האחרונים (1.9.2026–14.11.2026) ", { "amount": 5331.4 }, " ב-17 תנועות."],
  "items": [{ "label": "שופרסל דיל", "sub": "10.11.2026 · סופר ומכולת", "amount": 389.1,
              "link": { "label": "לתנועה", "section": "transactions", "params": { "ids": "797" } } }],
  "itemsTitle": "התנועות הגדולות בסכום הזה",
  "links": [{ "label": "הצג את התנועות", "section": "transactions",
              "params": { "from": "2026-09-01", "to": "2026-11-14", "category": "groceries", "kind": "spending" } }],
  "note": null, "suggestions": [] }
```
- `intent`: `spending | compare | top-expenses | categories | merchants | income | net | balances | upcoming |
  recurring | price-changes | insights | annual | help` (`help` also when the question was not understood;
  then `suggestions` holds example questions).
- `parts` is the answer sentence: strings and `{ "amount": ILS }` (magnitude, exact to the agora) for the
  client to render as numbers; `text` is the same sentence with the amounts written out ("5,331.40 ₪").
- **Links are the contract for "show me":** `section` is a dashboard screen (`transactions | recurring |
  annual | overview`) and `params` its hash parameters, all strings. For `transactions` they are
  `/api/transactions` query keys (`month` or `from`/`to`, `category`, `q`, `kind`, `accountId`, `ids`). An
  amount answer equals what that filter nets to: `spending` / `compare` / `categories` = `net.total` with
  `kind=spending` (refunds subtract, a category never below zero per month); `income` = `net.total` with
  `kind=income`; `balances` = the sum of `/api/accounts` bank balances; `recurring` / `price-changes` come
  from `/api/recurring` (the same `priceChange` definition).
- **Periods** understood: החודש, החודש שעבר / הקודם, a month name with or without a year (the most recent
  one), N החודשים / הימים האחרונים (numbers or Hebrew number words), חודשיים, רבעון, חצי שנה, השנה האחרונה,
  השבוע, שבועיים, היום, אתמול, השנה / מתחילת השנה, השנה שעברה, a year (ב-2025). Rolling windows count whole
  months back from the first of the month, up to today (like the transactions "3 חודשים" preset). No period
  → the current month, and `note` says so.
- **Comparisons** (לעומת, בהשוואה, מול, יותר מ…): two named periods, or one period against the one before
  it of the same length; the running month is compared with the same days of the previous month.
- **Subjects:** an expense category by its name or everyday words (סופר, מסעדות, דלק, חניה, שכר דירה,
  ביטוח…; the longest phrase wins, so "סופר פארם" is health), otherwise a merchant: the remaining words, with
  a one-letter Hebrew prefix removed and a few Hebrew spellings of English names (נטפליקס → netflix), are
  looked up in the transaction descriptions like the `q` search. A name that matches nothing is said in
  the answer, and the total is for all spending.

### GET /api/export.csv?from&to → CSV download (UTF-8 with BOM, Hebrew headers)
The file is plaintext. The UI suggests saving it outside cloud-synced folders, and the desktop app's
save dialog defaults to Downloads.

## Business mode

### The lens: `?lens=all|business|private`
Accepted by every read endpoint: summary (all forms), insights, position, recurring, annual, annual/insights,
price-trends, transactions, export.csv. `POST /api/chat` takes `lens` in the body. While business mode is
off the lens is ignored and everything is `all`.

- A row's scope is its own `scope`, else the merchant rule (`scope_rules`), else its account's scope
  (`business`, otherwise private). `mixed` accounts are private until a row is marked.
- A business row with `businessShare` 1–99 is split: its business part in `business`, the rest in
  `private`; the two parts always add up to the full amount (`fullAmount` is set on the part).
- Owner transfers (`transferKind` `owner_draw` / `owner_injection`) are category `owner-transfer` and are
  never income or expense of either side. They are found after every sync; a kind set by hand is kept.
- Payments to the tax authority (מע"מ, מס הכנסה, מקדמות) are not business expenses and not VAT input.
  Income-tax advances count as tax paid.

### GET /api/business · PATCH /api/business
`{ enabled, type: exempt|licensed|company, vatPeriod: monthly|bimonthly, setAsidePct (0–60), taxPaidYtd (₪), name }`.

### PATCH /api/accounts/:id `{ "scope": "business" | "private" | "mixed" }`

### PATCH /api/transactions/:id (business fields)
`scope` (`business` | `private` | null), `applyToMerchant` (bool: also set the merchant rule),
`businessShare` (0–100 or null), `transferKind` (`owner_draw` | `owner_injection` | `none`), `invoice`, `noVat`.

### GET /api/business/overview
How much of the business money is really yours (bank − cards still to come − VAT owed − tax set-aside),
VAT for the period to pay and the open one (or the exempt-ceiling meter), this month and the year so far,
12 months of income / expenses / profit / owner draws, unsorted mixed-card rows, and flags.
`409 BUSINESS_OFF` while business mode is off (as are the two below).

### GET /api/business/flow?months=6
Per month: business profit, owner draws and injections, home spending, how much of the home the business
paid for (`homeFundedPct`), and what stayed in the business; plus averages.

### GET /api/business/export.csv?from&to
Business rows only, with VAT, invoice and the business share, for the accountant.

## Google Sheets and dashboards

### POST /api/connections `{ "companyId": "gsheet", "nickname", "sheet": { "url", "kind": signed|income|expense, "scope" } }`
Only `docs.google.com` links. The link is sealed like a password. The sheet is pulled now, on every open and
on every sync, as CSV (5 MB, 20 s). A sheet with date and amount columns is mirrored as transactions (tags
added here survive a pull; lines deleted from the sheet are deleted here). Any sheet is kept as a table for
dashboards. `PATCH /api/connections/:id { "sheet": {...} }` replaces the link.

### GET /api/sheets → `{ sheets, dashboards }` · GET /api/sheets/:id/table → `{ columns: [{index,name,type}], rows, fetchedAt }`
Column types: `date` (ISO), `number` (₪ and commas removed), `text`. The first pull of a sheet makes a
dashboard from what it holds (count, sums, the first number by month, top groups, a pie, recent rows; ID-like
columns such as invoice numbers are not summed).

### POST /api/dashboards `{ name, source: "sheet:<id>", widgets }` · PATCH /api/dashboards/:id `{ name?, widgets? }` · DELETE /api/dashboards/:id
Widgets are computed in the page from the table, so editing is live. Each widget:
`{ id, type: kpi|bar|line|pie|table, title, size: s|m|l, measure: { op: sum|count|avg|min|max, col },
groupBy?, dateCol?, bucket?: day|month|year, filter?: { col, op: eq|neq|contains|gt|lt, value }, limit }`.
At most 24 widgets; columns are checked against the table width. Deleting a sheet deletes its dashboards.

## Data at rest (server)

- `%LOCALAPPDATA%\Finora` gets a protected DACL (current user + SYSTEM, no inheritance) when it
  is created and again on every start.
- **Data key:** one random 256-bit key per install, stored in `keys/dek.json`.
  - It is wrapped with DPAPI CurrentUser, plus Electron `safeStorage` in the desktop app.
  - The DPAPI wrap uses a random per-install entropy stored next to it. That entropy is not a
    secret: it only binds the blob to this install and defeats generic "unprotect everything"
    tools.
  - Same-user malware can still unwrap the key. Only a user passphrase or Windows Hello would stop
    that, and either would break unattended daily sync.
- **Subkeys** (HKDF-SHA256): `mc/db/v1` for DB snapshots, `mc/cred/v2` for credentials,
  `mc/index/v1` for the account-number HMAC.
- **Databases** live in memory and are persisted as AES-256-GCM snapshots `real.db.enc` /
  `demo.db.enc`.
  - Each write goes temp file → fsync → rename. The previous generation is kept as `.enc.1`.
  - They are persisted about 1 s after a change, immediately after deletions, and on shutdown.
  - No WAL or journal ever reaches the disk.
- **Credentials:** `cred_blob = "v2:" + AES-256-GCM`, with AAD = `cred|v2|<connection UUID>|<company>`,
  so a blob does not decrypt in another row.
- **Accounts:** only `last4` plus `HMAC-SHA256(index key, full number)` are stored. Luhn-valid card
  numbers in descriptions and memos are reduced to their last 4 digits on ingest.
- **Migration from pre-release data** (plaintext databases written by early development builds)
  runs transparently on the first start:
  - the plaintext `real.db` / `demo.db` (incl. `-wal` / `-shm`) are imported;
  - v1 DPAPI credential blobs are re-sealed and account numbers reduced;
  - the encrypted copy is verified, then the plaintext files are overwritten and deleted.
- **Key cannot be unwrapped** (e.g. a Windows password reset by an admin, or the profile moved to
  another PC): the app explains this in Hebrew and offers to start over. Desktop shows a dialog; in
  the CLI, run `npm start -- --reset-data`. The bank history can be re-scraped about 12 months back.

## Sync isolation

Each scrape runs in a short-lived worker process (`server/sync-worker.js`): an Electron
`utilityProcess`, or `child_process.fork` in browser mode.
- The worker gets the decrypted credentials of one connection over IPC, as bytes.
- It launches Chrome / Edge itself: `--remote-debugging-pipe` (no DevTools TCP port), headless,
  sandbox on.
- It scrapes in an off-the-record browser context, with a private profile under `run/` that is
  deleted afterwards.
- It exits after the scrape.
