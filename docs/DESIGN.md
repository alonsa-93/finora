# MoneyCash UI: design spec

## Who
One Israeli household member, on their own Windows PC, who wants to know where the
money went without opening four bank sites. Opens the program a few times a week,
for a few minutes. Not an accountant; reads Hebrew, thinks in shekels, wants a
straight answer and a way to check it.

## Principles
One screen of summaries and exceptions, overview first and details on demand, amounts shown as
length (not rings of many colours), and the answer in the top right (the mirrored F-pattern of RTL
reading): one figure, one picture of how things move, a short list to act on, the rest one click away.

## Direction: Warm Glass
A warm, softly blurred backdrop; frosted panels with big radii, a light inner edge and diffuse
shadows; one saturated coral card that carries the headline; a slim dark icon rail; a header
with pill controls; a soft lift on hover.

### Backdrop
`body::before` paints six layered gradients (window light top-right, terracotta top-left,
apricot bottom, dusty rose bottom-right, a soft centre light, a peach linear base);
`body::after` tiles a 220px `assets/img/grain.svg` (feTurbulence noise, multiply at 22%) so
the field reads as an out-of-focus photograph rather than a CSS gradient. All local; no
image requests beyond the 1 KB SVG. Dark theme: espresso/aubergine base lit by an ember
coral glow top-right and a plum glow bottom-left, grain in soft-light at 16%.

### Glass recipe (tokens in `tokens.css`)
| surface | light | dark | used for |
|---|---|---|---|
| `--glass` | white-peach at 80% | aubergine at 70% | panels, KPI cards, settings sections |
| `--glass-strong` | 93% | 92% | transactions sheet, inspector, palette, menus, dialogs |
| `--glass-thin` | 55% | 50% | titlebar, pills sitting on the backdrop |
| `--card-in` | white 52% | 4.5% | a card inside a panel |

Each glass surface = `backdrop-filter: blur(22px) saturate(1.35)` + a 1px white border
(78%) + an inset top highlight + a hairline outer edge (`--glass-edge`) + a two-step warm
shadow. Radii: 22px panels, 26px hero, 14-18px inner cards and menus, pills 999px.
**Fallbacks:** `@supports not (backdrop-filter…)` and `prefers-reduced-transparency: reduce`
swap every glass token to an opaque colour (`--glass-solid*`) and drop the grain; layout
does not change. Opacity is chosen so text passes AA *without* relying on blur.

### Colour
- **Ink:** warm espresso `#2b1b15` / `#5a3f34` / `#6f5145` (light), `#f7ede7` / `#dcc9bf` /
  `#bba398` (dark). Never pure black or grey.
- **Coral, the one accent.** `--coral-hero` is a deep terracotta-to-brick gradient
  (`#bf452e → #96302a`) with two orange glows placed in the corners *away* from the text
  (top-left, bottom-left), so the text side stays dark enough for white text. `--coral`
  `#b8402c` is coral as text/interactive on glass; `--coral-ink` for coral text on a coral
  tint; `--coral-bright` for lines, dots and glows; `--coral-pill` for the active rail item,
  primary buttons, today in the calendar, the next charge and the meters.
- **Severity** keeps its own hues (alert brick-red, warn brown-amber, good green), always with
  a glyph and a word, shown as tinted chips.
- **Charts:** income `#3e8466` green, expenses `#d0674a` coral, a month where expenses beat
  income `#8f2a20` (darker, also said in the readout), previous month a dashed warm grey.
  Category colours come from the API. The sheet dashboards use six series hues (`--dch-1` … `--dch-6`
  in `business.css`) that stay apart in both themes.

### Type
**Rubik** (variable 300-900, OFL, vendored as two subsets: `rubik-hebrew-var.woff2` and
`rubik-latin-var.woff2`, licence in `assets/fonts/LICENSE-Rubik.txt`). Its slightly rounded
geometry matches the soft glass. Rubik's digits are proportional by default, so every amount
uses `tabular-nums` (`.num`, `td`, `.amt-r`), which Rubik supports via `tnum`. ₪ is in the
Hebrew subset, U+2212 in the Latin one. Scale: 12 · 12.5 · 14 · 15 · 17 · 20 · 28 · 54, plus 30
for the greeting and 34 for the ring figure. Hebrew is never italic or letter-spaced.

### The ring
Spent so far ÷ the month's projected total (`forecast.projectedExpenses`), labelled
"מהצפי לחודש" with "צפי: 17,500 ₪" under it. Past months, or before there is a forecast:
÷ last month's total, labelled "מכל אוקטובר". The arc caps at a full circle but the figure says
the real percentage (e.g. 102%). It has an `aria-label` sentence; the figure is never colour-only.

## Layout
- **Icon rail** (68px, floating, dark glass, 24px radius) on the right edge, in this order:
  סקירה (Ctrl+1), תנועות (Ctrl+2), חיובים קבועים (Ctrl+3), סיכום שנתי (Ctrl+5), שאלות (Ctrl+6),
  העסק (Ctrl+7, only while business mode is on), דשבורדים (Ctrl+8), and last חשבונות והגדרות
  (Ctrl+4). The keyboard handler looks sections up by `key`, not by position (`router.js`
  `SECTIONS`). The current section is a coral pill with a glow. Labels are tooltips (350ms on
  hover, instant on keyboard focus, with the Ctrl shortcut); they stay in the accessibility tree
  (opacity, not visibility). Ctrl+B toggles to the 200px labelled sidebar (pref `railCollapsed`,
  default rail). The footer keeps the live connection dot.
- **Title bar** is custom and frameless in the desktop window (`app-region: drag`, window controls
  via `window.moneycash.window.*`): a thin glass strip with a pill command trigger and, while
  business mode is on, the lens switch (הכול / עסק / פרטי).
- **KPI cards** that open something lift 5px on hover with a spring ease and a deeper shadow; a
  stretched button carries the click and the focus ring. Cards that open nothing do not lift.
  Under `prefers-reduced-motion` nothing moves.
- **Deltas:** mid-month, income and net are not comparable with a whole previous month, so the
  chip says last month's figure ("אוקטובר: 19,120 ₪") instead of a fake percentage. For closed
  months the chip is "עלייה של 4%" / "ירידה של 5%" with an arrow, green or red by meaning.
- **Recurring:** four glass summary cards, the monthly figure on coral; the table in a glass panel.
  **Settings:** each section is its own glass card (title + explanation | controls); the danger zone
  has a red-tinted edge. **Onboarding:** one glass card.
- **Floating layers** (palette, menus, listboxes, popovers, dialogs, toasts, tooltips) use the strong
  glass; modal ones get a blurred scrim; toasts and tooltips are solid (espresso in light, cream in dark).

## סקירה: the overview
The first screen answers "where do I stand right now?" (`views/position.js`, `css/position.css`,
data from `GET /api/position`):
1. **The bank balance now**, on the coral hero: the figure, how it changed this month, and what is
   left after the card charges still to come.
2. **The credit cards now** (glass, beside it): what is charged and not yet paid from the bank, per
   card, with the next charge.
3. **How both moved** over the picked months: bank and cards apart, each with its own chart. The
   daily bank balance is rebuilt backwards from today's balance (`server/position.js`).
4. **Red flags** with what to do about them (at most four in view, the most serious first), then the
   other insights.

While a new period loads, the current content stays, dimmed, at its height, so the page never jumps.

**לעומק** (closed by default, remembered in pref `ovDeep`) holds the spending of a period (the coral
hero with its pace, forecast, comparison sentence and the ring), all conclusions, categories vs.
average, top merchants, accounts, the upcoming-charges calendar (a four-week grid from this Sunday
with dots on charge days, today in coral, the next charges listed) and 12 months.
At 1440x900 everything above "לעומק" fits without scrolling. A 5-second test should answer
"where do I stand, and is anything wrong?".

## תנועות and the floating layers
The shared page grid (see "One system") holds the page header, the filter bar and the sheet; the
list is a table with aligned columns, so a wide row is filled with facts, not white.
- **Header:** "תנועות" (28px), the period and the count under it ("נובמבר 2026 · 482 תנועות"); on the other
  side three glass figure chips: הוצאות (coral dot) / הכנסות (green dot, green figure) / נטו (ring, signed,
  "נשאר" / "יצא יותר"). All three come from the server (`sumOut`, `sumIn`, `sumNet`): the client adds
  nothing up. On a drill-down (`kind=spending|income`) they become חיובים / החזרים / נטו אחרי החזרים
  ("כמו בסקירה", coral-tinted), equal to the overview headline. While a new filter loads, the old figures
  and rows stay, dimmed.
- **Filter bar:** glass pills: search (with the `/` chip), תקופה, חשבון, קטגוריה (each a custom listbox,
  see below; a set filter is coral-tinted), the direction segmented control; עמודות and CSV as icon pills
  with tooltips on the far side. "טווח תאריכים…" in the period list opens a glass popover with presets
  (החודש, החודש הקודם, 30 הימים האחרונים, 3 חודשים, מתחילת השנה) and the range calendar. Active filters
  show as chips with "ניקוי כל המסננים".
- **Rows**, grouped by day (date sort): a sticky day header under the sticky column header ("היום · יום
  שבת, 14 בנובמבר" and the count), with that day's totals in the amount column: the number first, so its ₪
  and decimals sit exactly over the row amounts, and the word ("יצא" / "נכנס") after it. The totals are the
  server's (`days` in the transactions response: every matching row of that day, also rows on other pages).
  Sorted by amount there are no groups; the date joins the sub-line.
- **A row (52px):** a category-tinted avatar with the merchant's initial; the merchant (15px, 500) and its
  status chips; then the columns **קטגוריה** (a quiet pill-button that opens the picker), **חשבון** and, when
  turned on in עמודות, **תאריך החיוב**; then the amount (164px), right-aligned with tabular figures, so the
  decimal points form one column; money in has "+", is green **and** says "נכנס" / "זיכוי" under the
  amount. A foreign amount sits there too. When the sheet is narrower than 760px (1100px window with the
  inspector open, 200% zoom) the category and account fold back into a sub-line under the merchant
  (`transactions.js` measures the sheet with a ResizeObserver and re-renders; focus is kept).
- **One chip style** (`.badge`): ממתין (dashed), תשלום 5 מתוך 6, חיוב כרטיס, לא נספר (amber tint),
  לא נספרת (struck). Explanations are tooltips; the inspector says the same in words.
- Hover is a faint rounded tint, the selected row is coral-soft with a coral edge at its start, keyboard
  focus is the rounded blue ring drawn on the cells. Skeleton rows in the real shape (avatar, two lines,
  amount) while loading; three more at the end while the next page loads (automatically, 400px before
  the end, or with the "לטעון עוד" button). Empty and no-results states with an icon disc and
  "ניקוי המסננים".
- **Inspector:** avatar + merchant + date · account in the header; the amount card (direction in words,
  a 30px figure, the original currency, the chips); קטגוריה as a full-width picker button (name, how it
  was set, the `C` hint); פרטים as a ruled definition list; the "נספרת בסיכומים ובמסקנות" switch in its
  own tinted card with a sentence that states the state; the actions as a list with their keys (M, Ctrl+C).
- Narrow (1100 window with the inspector open) a container query compacts the header (the figure chips on
  one line) and the bar; below 1000 CSS px (200% zoom) the whole page scrolls and the headers still stick.

### Floating layer rules
- **One portal:** `#layers` (`display: contents`) at the end of `<body>`. Dialogs, menus, listboxes,
  popovers, the palette, toasts, live regions and the tooltip all render there, never inside a panel.
- **Placement:** one `place()`. The safe area is below the title bar, clear of the rail, 8px from every
  edge; `max-height` shrinks to the room left. A menu hangs 4-8px from its trigger; if it does not fit
  on one side it flips (above / below, or hangs from the trigger's other edge) instead of being
  clamped over the trigger. Context menus open at the pointer and flip above it near the bottom, to
  its right near the left edge. Shift+F10 and the menu key anchor to the focused row.
- **Measure, then animate:** the position is measured first; `.is-placed` then starts the entry
  animation, whose direction follows the side (above or below).
- **Dismissal:** every popover closes on a scroll outside it, on resize and on window blur.
- **z-index:** one scale in `tokens.css` (`--z-sticky` … `--z-skip`), used everywhere.
- **Listbox:** `listbox.js`, the APG select-only combobox (role=combobox plus a listbox in `#layers`,
  aria-activedescendant, ↑ ↓ Home End PageUp PageDown, type-ahead, Enter / Space / Alt+↑, Esc, Tab;
  focus stays on the trigger), a glass popover with groups, swatches and a check on the chosen value.
  `selectBox({ anchor })` hangs it from a whole compound control (the month stepper).
- **One popover recipe:** 18px radius, glass-strong, 6px padding, 34px items (the palette: 38px, as the
  dialog's main content), icon column / label / key chip; hover = a faint tint, active = coral tint and
  hairline; shared separators and group labels. Width classes go in through `openMenu({ className })`
  so they apply before placement.
- **Tooltips:** one tooltip in `#layers` for `[data-tip]` (12.5px, 7/11px padding, `--z-tooltip`); any
  `title` is adopted on first hover or focus (moved to `aria-description`, or to `aria-label` when the
  element has no text). The rail labels use the same recipe.
- **Focus ring** follows each element's own radius; table rows get a rounded ring drawn on their cells.
- **Account labels:** `accountLabel()` / `accountText()` in `format.js`: the Hebrew name, then "•1234"
  as its own LTR isolate.
- **The include-in-totals switch** is neutral: an ink track and a filled knob when on, a hollow ring when
  off (shape and position, not colour); the inspector also says the state in words.
- Day headers are spaced by a border inside the header, so they never paint over a focus ring.
- Merchant names inside Hebrew sentences (e.g. the "apply to similar" dialog) are wrapped in `<bdi>`.

## חיובים קבועים and the category change
- **Category change:** after a pick, if other rows of the merchant would change, a dialog asks with the
  real count ("להחיל גם על 30 תנועות דומות מ-שופרסל?"); "רק התנועה הזו" is the default and has focus;
  Esc cancels. Every change (and exclusion) gets a toast with "ביטול" and Ctrl+Z (`undo.js`); the server
  reverts rows and the merchant rule.
- **One price-change definition** (server `latestPriceChange`): חיובים קבועים and מגמות מחירים both say
  "התייקר ב-10% במרץ 2026" (or "משתנה לפי צריכה" / "ללא שינוי בשנה האחרונה").

## סיכום שנתי: the annual review
Route `#/annual?end=YYYY-MM&tab=prices&item=<key>`, shortcut Ctrl+5. Also in the palette ("שנתי", and
"מגמות מחירים" straight to the second tab). Two tabs in a glass pill in the header (`role=tablist`,
arrow keys, RTL: ← is the next tab), the period stepper ("עד אוקטובר 2026"; PageDown / PageUp step a
month) on the far side. Styles in `assets/css/annual.css`.

**סיכום השנה, top to bottom:** a partial-data notice when it applies ("יש נתונים על 8 חודשים — ההשוואה
לשנה הקודמת תופיע כשיצטברו יותר נתונים (צריך 24 חודשים)") → the coral hero for the year (tag with the
range and how many months have data, "הוצאת בשנה האחרונה", the total, the sentence against the year
before with an arrow and יותר/פחות, the income line, chips: monthly average, what was left, the costliest
month; pills to the year's expenses / income) with a **savings-rate ring** ("נשאר מההכנסות", the previous
year's rate under it; a negative year shows an empty ring and says "הוצאת יותר מההכנסות") beside a glass
card **מול השנה הקודמת** (income, expenses, left, savings rate: this year, last year, change in words
with an arrow; below 1240px the words collapse to arrow + signed number, still read out). Without a
previous year that card explains why and shows a meter of months collected out of 24 → four KPI cards
with sparklines of the covered months (income, expenses, left, fixed charges per month with "התייקרו ב-402
₪ בשנה") → **מסקנות לשנה** (the first four in full, the rest one line each, same card language as the
overview) beside the most / least expensive months (rank badge red / green, the driving category, a bar;
click opens that month's overview) and income stability (level in words, the coefficient of variation,
unusual months) → income vs expenses with **dashed least-squares trend lines** (green / dark red,
labelled at the newest end; months without data show "–") → category trends as a table of **small
multiples** (a 30px sparkline per category, total and monthly average, first-vs-last-3-months change with
an arrow and words, trend label; "עולה בהדרגה" / "יורדת" tags for growers and shrinkers; when the quarters
moved but the trend line is flat the cell says "תנודתי, בלי מגמה" instead of a coloured arrow) → fixed
commitments (per month now, per year, start vs end of the period, every price change with התייקר / הוזל
tags and ₪ per year) beside the instalments still to pay (total, per month, each plan with a paid bar and
"שולמו 5 מתוך 6", and a per-month list).

**מגמות מחירים:** four summary cards (the coral one: increases in fixed charges, ₪/year), a plain
explanation of the rules (we only see receipt totals, so "קנייה ממוצעת", never "prices"), then the ranked
**התייקרו / הוזלו** lists (toggle buttons with `aria-pressed`; Enter moves focus to the chart) beside a
sticky detail panel: a hand-drawn **price-history chart** (time right-to-left; recurring charges as a step
line with every change point ringed in red / green, a dotted rule and "+10%" label; merchants as the
monthly average purchase with the first and last three months shaded and their levels dashed), a
readout that follows the mouse and the arrow keys (Home / End), a table toggle, and the facts in a
definition list. Below: all recurring charges, and the frequent merchants with visits per month and
average purchase first → last and what changed.

## שאלות: questions about your money
Rail item Ctrl+6 (icon `chat`), `views/chat.js` + `css/chat.css`. Answers are computed locally by
`POST /api/chat` (`server/chat.js`); the page says so in its sub-line, and nothing is sent anywhere else.
- **Layout:** the standard `pageHead` ("ניקוי השיחה" as its ghost control once there is a conversation) over one
  glass `.panel` that fills the window; the conversation scrolls inside it (`role=log`, polite) and the question
  field sits at its bottom. Messages share a 920px centred column.
- **Question:** a coral-tint bubble (`--coral-soft` + `--coral-line`) on the far (left) side. **Answer:** a
  `--card-in` card: what was understood as neutral `.badge`s (period, compared period, category, merchant), the
  sentence at 15px with every amount an LTR `<bdi class="num">` in 700, an optional `.chat-note`, rows in the
  shared `.rows` / `.row-btn` recipe (avatar, name, sub-line, amount; each opens its transactions), and the
  card's actions as `.btn.small.accent`. Example questions are `.btn.small.pchip` chips.
- **Empty:** the shared empty-state disc and title with six example questions. **Thinking:** three dots
  (still under `prefers-reduced-motion`). **Error:** the answer card in the alert tint with `role=alert`.
- Enter sends, Shift+Enter is a new line, the field grows to 140px. The conversation is kept in memory for the
  window only (it survives switching screens, not a restart) and is never stored.

## העסק and דשבורדים
- **העסק** (Ctrl+7, `views/business.js`, `css/business.css`), shown only while business mode is on: the
  business at a glance (how much of the money is really its own, VAT, profit, set-aside, flags) and the
  flow from the business to the home. Business rows only, read on the server through the business lens.
  The title-bar lens switch (a `radiogroup`) decides which side every other screen shows.
- **דשבורדים** (Ctrl+8, `views/dashboards.js`, `charts-dash.js`): dashboards built from Google Sheets.
  Every sheet gets a first dashboard made from its columns; widgets are added, edited, moved and removed
  with the result shown at once (computed in the page from the typed table), and the layout is saved to
  the server a moment after the last change. Same glass recipe as the overview.

## One system
Every screen uses the same paddings, title size, control heights, row heights, chips and buttons,
defined once as tokens (`tokens.css`) and classes. At 1100, 1440 and 1920 the title's top, its right
edge, the content's right and left edges and the first panel's top are the same on every screen
(transactions: the first panel starts under its filter bar). Every toolbar control is 36px, every
panel title 18px.

**Tokens.** `--page-max` 1680 · `--page-x` 28 (24 under 1360, 36 over 1800, 16 in reflow) · `--page-top` 20 ·
`--head-gap` 16 · `--panel-pad` 20/22 · `--card-pad` 18/20 · `--t-title` 28 · `--t-h2` 18 · `--ctl-h` 36 ·
`--ctl-h-sm` 30 · `--row-h` 52 · `--row-h-1` 44 · `--row-h-c` 36 · `--row-r` 14 · `--av` 34 / `--av-r` 12.

**Page.** `pageHead(title, sub, ...controls)` (`views/common.js`) builds `.cmdbar` + `.page-title` (h1 28px and
one `.page-sub` line, always present, so every header has the same height) with the screen's controls on the
far side, centred on the title block. Content goes in `.page` (the same column, `--gap` between panels).
Transactions builds the same header in its fixed top area; onboarding is one card in the same column.

### Controls
| recipe | class | look |
|---|---|---|
| primary | `.btn.primary` | coral pill, white text, glow |
| secondary | `.btn` | glass pill with the hairline edge |
| ghost | `.btn.ghost` | no surface until hover |
| danger | `.btn.danger` on secondary or ghost; `.btn.danger.solid` for the final destructive confirm | red text / red fill |
| accent | `.btn.accent` | a secondary in coral, only for a card's one action (an insight's "הצג תנועות") |
| icon | `.btn.icon` (36) / `.icon-btn` (30, no surface) | |
| on coral | `.pill-solid` / `.pill-ghost` | primary / secondary drawn for the hero card |

Sizes: 36px, `.small` 30px. Everything on a toolbar row is 36px: buttons, combos, the search pill,
segmented controls, the month stepper, the sync chip.
- **Select:** the `listbox.js` combobox everywhere, including the settings time (every 15 minutes, type "07"
  to jump; disabled while the daily sync is off). The coral "set" tint is only for transactions filters.
- **Text field:** `.input` (36px, 10px radius, field background, ≥3:1 border). **Search:** `.pill-field` with the
  icon (transactions, the category picker, the institutions list). **Password:** `.input-group`: the show /
  hide button sits inside the field (`aria-pressed`, its label changes); values are cleared and re-hidden on
  submit.
- **Checkbox / radio:** drawn (`.check`): an 18px rounded box, ink fill and a check when on; a ring with a dot
  for a radio. **Segmented / tabs:** `.seg`; the annual tabs use the same track and glass thumb (coral pills
  are only the rail's current item, primary buttons and chosen days).
- **Date range:** `rangecal.js` (below). No native `date`, `time` or `select` is used in the app.

### Rows, chips and states
**Rows.** `.grid-table` for every table (transactions, recurring, the categories table, settings connections,
the annual tables): 40px column headers (12.5px, ink-2) over a strong hairline; 52px rows with a hairline
between them; hover = a faint tint with 14px rounded ends; selected = coral tint with a coral edge at the
start; keyboard focus = the rounded blue ring on the cells (when also selected: ring outside, coral edge
inside). Lists inside panels (`.rows` + `.row-btn`: accounts, merchants, the months, price lists,
institutions) share the height, padding, radius, hover and pressed state, without hairlines. A row starts
with `avatarOf()` (`dom.js`): a category-tinted tile with the first letter (merchants, recurring charges,
price items, institutions) or an icon tile (accounts, connections). Amounts: start-aligned (the right edge in
RTL), tabular figures, one decimals rule per column.

The transactions table uses the page grid with category and account as columns (rather than two-line
rows in a narrow centred column): the extra width becomes aligned, scannable facts, the header and the
filters line up with every other screen, and the hairline plus the full-row hover tie each row together.
Two-line rows are what the sheet falls back to below 760px.

**Chips:** one `.badge` (22px, 12px 600): neutral, `b-pending` (dashed), `b-card` (amber), `b-excl` (struck),
`b-up` / `b-down` (red / green tint, always with a word), `b-coral` (the "3 דברים לבדוק" count). KPI-card
chips (24px, with an icon) are a sibling of `.badge`.
**States:** `emptyState()` (icon disc, title, one sentence, at most one action; an `error` variant) and
`skeletonList()` (rows in the real shape) are shared by transactions, recurring, settings and every error.

### Range calendar
`rangecal.js`, in the period popover. The APG date-picker grid: `role=grid`, weekday headers with the full
names, `gridcell`s with `aria-selected` and a full Hebrew `aria-label` ("יום ראשון, 8 בנובמבר 2026, תאריך
ההתחלה"), roving tabindex. Weeks start on Sunday; Sunday is the right-most column. Keys: → / ← previous /
next day (RTL), ↑ / ↓ a week, Home / End the start / end of the week, PageUp / PageDown a month (with Shift:
a year), Enter / Space pick; Esc closes the popover and focus returns to the period pill. First pick =
"מתאריך", second = "עד תאריך" (an earlier date swaps them); the two ends are toggle buttons above the grid,
so either can be re-picked; hovering previews the band. Bounds: the first day of the oldest month with data
→ today; days outside are disabled. Always six weeks, so the popover never changes height. Look: the
overview calendar card's language (a sunken grid, 10px-round cells, today ringed in coral, the ends as
coral pills joined by a coral band). The popover's title is an h2, so the calendar's h3 keeps the heading
order.

## Accessibility
- **Contrast:** every text passes WCAG AA against the pixels actually painted behind it (glass over the
  backdrop, gradients and grain included), in both themes. Method: hide the element's text, screenshot
  its box in the running app (headless Edge, 1440×900), and compare the text colour with every
  background pixel; "median" is the dominant background, "min" the 3rd-percentile pixel. Boxes that also
  contain non-text paint (button borders and rounded corners, legend swatches, the switch track, a tag's
  dot) can fall under 4.5 on *min*; their medians stay ≥ 4.8. Reference values:

  | text | light median (min) | dark median (min) |
  |---|---|---|
  | greeting date | 7.9 (7.6) | 7.5 (7.2) |
  | hero label (on coral) | 5.2 (5.0) | 5.2 (5.0) |
  | hero sentence | 6.3 (5.8) | 6.3 (5.8) |
  | hero forecast | 6.0 (5.7) | 6.0 (5.7) |
  | hero chip label | 6.7 (6.6) | 6.7 (6.6) |
  | ring label | 4.8 (4.8) | 4.8 (4.8) |
  | "all expenses" pill | 6.7 | 6.7 |
  | calendar past day | 5.9 | 7.3 |
  | upcoming kind line | 6.5 | 6.9 |
  | KPI label / note | 8.6 / 6.4 | 10.1 / 6.7 |
  | insight body | 9.2 | 9.0 |
  | severity: alert / warning / info | 5.8 / 5.6 / 7.8 | 5.4 / 6.2 / 11.0 |
  | insight action (coral) | 5.3 | 6.7 |
  | chart ticks | 6.5 | 6.9 |
  | category delta up / down | 6.5 / 6.0 | 7.4 / 9.4 |
  | transactions header / account column | 9.0 / 5.8 | 10.1 / 5.0 |
  | income amount (green) | 6.2 | 9.4 |
  | recurring monthly label (on coral) | 5.4 (4.5) | 5.4 (4.5) |
  | settings explanation | 8.6 | 9.6 |
  | primary button (white on coral) | 5.4 | 5.5 |

  The dark-theme red tag is `#ffaaa2` (5.3).
- **axe-core:** 0 serious or critical issues on every screen, in both themes, with every overlay type open
  (only the moderate "region" rule while a popover is open: popovers live outside the landmarks by design).
- **Focus ring:** blue `#1f56c8` / `#93b5ff` (≥3:1 on every glass), white on the coral card and the rail; it
  follows each element's radius, and table rows get it as a rounded ring on their cells.
- **Drill-downs land on the number clicked:** "כל ההוצאות של <חודש>", the income KPI and the annual pills
  open `kind=spending|income` (the rows behind the headline, refunds included); the totals line then reads
  "חיובים X · החזרים −Y · נטו אחרי החזרים Z" with Z equal to the headline.
- **Terms:** rail labels match the page headings; "מסקנות" everywhere (never תובנות); card bills are
  "חיובי האשראי שעוד לא ירדו" / "חיוב כרטיס אשראי".
- **Demo:** a notice on the overview says the numbers are demo data and offers "חיבור חשבון אמיתי".
- **Search** finds amounts too ("249" = 249.00-249.99).
- **KPI sparklines** are tab stops: arrows step through the months, a readout chip shows and announces each.
  The category small multiples (annual) list every month in their `aria-label` and are not a tab stop
  (their rows are).
- **Re-render keeps focus** (`dom.mount`): the same control is focused again after a refresh or sync.
- **Reflow** (`reflow.css`): below 1000 CSS px (1100 px window at 200% zoom) every grid stacks, the title bar
  drops its long texts and the inspector floats over the content.
- **Forced colours** (Windows High Contrast): panels, layers, chips and tags get a CanvasText edge; bars, rings,
  swatches and chart lines are repainted in Highlight / CanvasText; focus is a 3px Highlight outline.
  **Reduced transparency** also turns the blur off. **Target size:** every control is at least 24x24.
- **Live regions:** sync progress is one short line per finished connection ("מקס: הסתיים. 2 מתוך 3").

## Keyboard
- **Sections:** Ctrl+1 סקירה, Ctrl+2 תנועות, Ctrl+3 חיובים קבועים, Ctrl+4 חשבונות והגדרות, Ctrl+5 סיכום
  שנתי, Ctrl+6 שאלות, Ctrl+7 העסק (business mode only), Ctrl+8 דשבורדים.
- **Global:** Ctrl+K command palette, Ctrl+B rail / labelled sidebar, Ctrl+Shift+S sync now, F5, `?` the
  shortcut list, `/` search, PageUp / PageDown the period. Dialogs and menus own the keyboard while open.
- **Transactions:** `C` category picker, `M` and Ctrl+C from the inspector's action list, Shift+F10 or the
  menu key for the row's context menu, Ctrl+Z undoes the last category change or exclusion.
- Listbox, range calendar and tabs keys: see their sections above.

## Rules kept everywhere
Logical properties only; `<bdi>` around every number and Latin name; minus as U+2212; Hebrew
dates; every time axis right-to-left (day 1 / oldest month at the right; the sparklines too);
chart readouts, keyboard navigation and table alternatives; no `innerHTML`, no inline `<script>`
or `style=""` (JS sets styles through the CSSOM).

## Known gaps
- At 1100×700 the first screen fills the window; the flags start just below the fold. The calendar
  shows two charges instead of three on short windows.
- The backdrop is gradients plus grain, not a photograph.
- Before the first known bank movement the bank balance history is unknown, so the bank chart starts there.
- Insight titles from the server can still start with a Latin name (NETFLIX.COM…). The annual
  conclusions always start with a Hebrew word.
- Settings: "סנכרון אוטומטי בפתיחת התוכנה" sits under the daily auto-sync switch (default on).
- The transactions table at 1920+ still has white between the merchant and the category column on rows
  with short names; the headers and hairlines give the eye a guide, but a two-line row would be denser.
- The overview calendar card and the range calendar share the look but not the code (the card is a
  four-week strip with charge dots, the picker a month grid).
