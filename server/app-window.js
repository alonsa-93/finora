// Lifecycle of the --app-window desktop mode (Node.js server + Microsoft Edge app window).
//
// It behaves like the Electron app did:
//  - one Finora at a time: a second launch does not kill the running one (that cut syncs short
//    and left a logged-in scrape Chrome behind); it asks it to open a window and exits;
//  - closing the window does not stop a sync that is running: the server finishes it in the
//    background, then exits;
//  - the window is "open" while Edge holds the lock of its profile (<data dir>\edge-window\lockfile),
//    so a window Edge opened inside an already running Edge process is tracked too (the launcher
//    process exits at once in that case, so its exit says nothing).
import { existsSync, openSync, closeSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * True when a process command line is this Finora's own --app-window server (node.exe running
 * our server\index.js). The pid in run\app-window.json can outlive a crash and be reused by any
 * other node.exe; only a match may be killed.
 */
export function isOurServerCommandLine(commandLine, indexPath) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\//g, '\\');
  const cl = norm(commandLine);
  return Boolean(indexPath) && cl.includes(norm(indexPath)) && /(^|[\s"])--app-window(?=$|[\s"])/.test(cl);
}

/** True while an Edge/Chrome process runs with this profile (it holds the lockfile exclusively). */
export function profileInUse(profileDir) {
  const lf = join(profileDir, 'lockfile');
  if (!existsSync(lf)) return false;
  try {
    closeSync(openSync(lf, 'r+'));
    return false; // stale lockfile left by a crash
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

/**
 * Watch the window(s) and call onAllClosed once none is open and nothing is busy.
 * @param {{ isOpen: () => boolean, isBusy: () => boolean, onAllClosed: () => void,
 *   onBusyClose?: () => void, startGraceMs?: number, pollMs?: number,
 *   setTimer?: Function, clearTimer?: Function, now?: () => number }} o
 * @returns {{ reopened: () => void, stop: () => void }} reopened(): a new window was asked for.
 */
export function watchWindow({
  isOpen, isBusy, onAllClosed, onBusyClose = () => {}, startGraceMs = 30000, pollMs = 1500,
  setTimer = setInterval, clearTimer = clearInterval, now = Date.now,
}) {
  let graceUntil = now() + startGraceMs;
  let seenOpen = false;
  let closedNoted = false;
  let done = false;
  const tick = () => {
    if (done) return;
    if (isOpen()) { seenOpen = true; closedNoted = false; return; }
    // Edge is still starting (first launch can take a while): not closed yet.
    if (!seenOpen && now() < graceUntil) return;
    if (isBusy()) {
      if (!closedNoted) { closedNoted = true; onBusyClose(); }
      return;
    }
    done = true;
    clearTimer(timer);
    onAllClosed();
  };
  const timer = setTimer(tick, pollMs);
  timer?.unref?.();
  return {
    reopened: () => { graceUntil = now() + startGraceMs; seenOpen = false; },
    stop: () => { done = true; clearTimer(timer); },
    tick,
  };
}

const REQ = /^show-\d+-[a-f0-9]+\.req$/;

/** A second launch: ask the running server to open a window. Resolves true once it took the request. */
export async function requestShow(runDir, { waitMs = 6000, pollMs = 100, id = `${Date.now()}-${process.pid.toString(16)}` } = {}) {
  const f = join(runDir, `show-${id}.req`);
  writeFileSync(f, '');
  for (let t = 0; t < waitMs; t += pollMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!existsSync(f)) return true;
  }
  try { unlinkSync(f); } catch { /* taken at the last moment */ return true; }
  return false;
}

/** The running server: take show requests (delete = acknowledge) and open a window for each batch. */
export function watchShowRequests(runDir, onShow, { pollMs = 500 } = {}) {
  const timer = setInterval(() => {
    let names = [];
    try { names = readdirSync(runDir).filter((n) => REQ.test(n)); } catch { return; }
    if (!names.length) return;
    for (const n of names) { try { unlinkSync(join(runDir, n)); } catch { /* ignore */ } }
    onShow();
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
