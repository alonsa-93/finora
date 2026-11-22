// Imported FIRST by server/main.js (before express / puppeteer load), so these variables are
// gone before any module reads them:
// - DEBUG: the `debug` module (express, puppeteer, israeli-bank-scrapers) would print to stderr;
//   puppeteer's `puppeteer:protocol` channel includes the text typed into login forms.
// - PUPPETEER_*: e.g. PUPPETEER_EXECUTABLE_PATH would redirect the scraper (and the decrypted
//   credentials it types) to an arbitrary executable.
for (const k of Object.keys(process.env)) {
  if (k === 'DEBUG' || k === 'DEBUG_FD' || /^(npm_config_|npm_package_config_)?PUPPETEER_/i.test(k)) delete process.env[k];
}
