// Short-lived sync worker: one process per scrape. It receives the decrypted credentials of ONE
// connection over IPC (as bytes, never via argv / env / disk), runs the scrape, sends back the result
// and exits. The app process still decrypts them and holds the plaintext briefly while handing it
// over; what stays out of its heap is the long part: the scraper, the browser and the bank session.
// Started by sync-runner.js (child_process.fork, CLI) or by the Electron shell (utilityProcess).
import './harden-env.js'; // must stay the first import
import { runScrape } from './scrape.js';
import { safeProfileDir } from './browser.js';
import { dataDir } from './config.js';

try { process.chdir(dataDir()); } catch { /* keep cwd */ }

const port = process.parentPort; // Electron utilityProcess
const send = (m) => { try { if (port) port.postMessage(m); else process.send?.(m); } catch { /* parent gone */ } };
const onMessage = (fn) => { if (port) port.on('message', (e) => fn(e.data)); else process.on('message', fn); };

const controller = new AbortController();

let started = false;

// The app process went away (closed, replaced by a new launch, killed): stop now and close the
// browser, so no logged-in Chrome is left running and holding the connection's profile.
const orphaned = () => {
  controller.abort();
  setTimeout(() => process.exit(0), 5000).unref();
};
if (port) port.on('close', orphaned); else process.on('disconnect', orphaned);

onMessage(async (msg) => {
  if (msg?.type === 'abort') { controller.abort(); return; }
  if (msg?.type !== 'run' || started) return;
  started = true;
  const raw = msg.credentials;
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  let credentials;
  try {
    credentials = JSON.parse(bytes.toString('utf8'));
  } catch {
    credentials = null;
  } finally {
    bytes.fill(0);
  }
  let result;
  if (!credentials || typeof credentials !== 'object') {
    result = { success: false, errorType: 'GENERIC', errorMessage: 'bad job', loggedIn: false };
  } else {
    const { companyId, startDate, executablePath, timeoutMs, interactive, profileDir, lite } = msg.job || {};
    result = await runScrape({
      companyId, startDate, executablePath, timeoutMs, credentials,
      interactive: interactive === true,
      lite: lite === true,
      profileDir: safeProfileDir(profileDir),
      signal: controller.signal,
      onProgress: (t) => send({ type: 'progress', progress: String(t || '') }),
      onBrowser: (pid) => send({ type: 'browser', pid }),
    });
  }
  credentials = null;
  send({ type: 'result', result });
  setTimeout(() => process.exit(0), 200);
});

send({ type: 'ready' });
