// What the renderer may put on the clipboard through `window.moneycash.clipboard.writeText`:
// one amount (optional sign and currency symbol, digits with optional thousands separators and up
// to two decimals), at most 64 characters. Nothing else - no text, no URLs, no control characters.
// Pure (no Electron import) so server/test can check it.
// A literal space, not \s (which also matches newlines, tabs and other control characters).
const AMOUNT = /^[-+−]? ?[₪$€£]? ?\d{1,3}(?:,?\d{3})*(?:\.\d{1,2})? ?[₪$€£]?$/;

export function isCopyableAmount(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= 64 && AMOUNT.test(text);
}
