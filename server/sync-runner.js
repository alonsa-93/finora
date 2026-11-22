// Runs one scrape in an isolated, short-lived worker process (sync-worker.js) and returns its
// result. `spawnWorker` abstracts the process API: child_process.fork (CLI, below) or Electron's
// utilityProcess (electron/main.mjs). Protocol: worker sends {ready}, gets {run, job, credentials},
// replies {progress}, {browser, pid}, {result}; {abort} asks it to close the browser and stop.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dataDir } from './config.js';

export const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sync-worker.js');

/** Environment for the worker: only what it needs, never DEBUG / NODE_OPTIONS / PUPPETEER_*. */
export function workerEnv() {
  const env = {};
  for (const k of ['SystemRoot', 'windir', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'PATH', 'Path',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'COMPUTERNAME', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.MONEYCASH_DATA_DIR = dataDir();
  env.MONEYCASH_QUIET = '1';
  return env;
}

/** child_process.fork adapter (plain Node). */
export function forkAdapter() {
  const child = fork(WORKER_PATH, [], {
    env: workerEnv(), cwd: dataDir(), serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [], windowsHide: true,
  });
  return {
    post: (m) => child.send(m),
    onMessage: (cb) => child.on('message', cb),
    onExit: (cb) => { child.on('exit', cb); child.on('error', cb); },
    kill: () => { try { child.kill(); } catch { /* ignore */ } },
  };
}

/**
 * Build a runner usable with sync.setScrapeRunner().
 * @param {() => { post, onMessage, onExit, kill }} spawnWorker
 */
export function makeWorkerRunner(spawnWorker = forkAdapter) {
  return function runInWorker({ job, credentials, timeoutMs, onProgress, signal }) {
    return new Promise((resolve) => {
      const w = spawnWorker();
      let browserPid = null;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        credentials.fill(0);
        clearTimeout(backstop);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const hardKill = () => {
        w.kill();
        // A killed worker cannot close its browser: end the (possibly logged-in) Chrome directly.
        if (browserPid) { try { process.kill(browserPid); } catch { /* already gone */ } }
      };
      const onAbort = () => {
        try { w.post({ type: 'abort' }); } catch { /* ignore */ }
        setTimeout(hardKill, 10000).unref();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const backstop = setTimeout(() => {
        hardKill();
        finish({ success: false, errorType: 'TIMEOUT', errorMessage: 'worker timeout', loggedIn: false });
      }, timeoutMs + 60000);
      w.onMessage((m) => {
        if (m?.type === 'ready') {
          try {
            w.post({ type: 'run', job, credentials });
          } finally {
            credentials.fill(0); // our copy; the worker got a structured clone
          }
        } else if (m?.type === 'progress') onProgress?.(m.progress);
        else if (m?.type === 'browser' && Number.isInteger(m.pid)) browserPid = m.pid;
        else if (m?.type === 'result') finish(m.result || { success: false, errorType: 'GENERIC', errorMessage: '' });
      });
      w.onExit(() => {
        if (!done) {
          if (browserPid) { try { process.kill(browserPid); } catch { /* gone */ } }
          finish({ success: false, errorType: 'GENERIC', errorMessage: 'worker exited', loggedIn: false });
        }
      });
    });
  };
}
