// Protected DACL for the data folder: only the current user and SYSTEM, no inherited entries
// (%LOCALAPPDATA% can carry extra principals such as AppContainer capability SIDs).
// Applied when the folder is created and again on every start. icacls / whoami are run by absolute
// System32 path with an argument array (no shell); only the exit code is ever logged.
import { spawnSync } from 'node:child_process';
import { systemExe } from './config.js';

let userSid = null;
export function currentUserSid() {
  if (userSid) return userSid;
  if (process.platform !== 'win32') return null;
  const r = spawnSync(systemExe('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  const m = /"(S-1-5-[\d-]+)"/.exec(r.stdout || '');
  userSid = m ? m[1] : null;
  return userSid;
}

const done = new Set();

/**
 * @returns {{ ok: boolean, status?: number }} never throws
 */
export function protectDir(dir, { force = false } = {}) {
  if (process.platform !== 'win32') return { ok: false };
  if (!force && done.has(dir)) return { ok: true };
  const sid = currentUserSid();
  if (!sid) return { ok: false };
  const r = spawnSync(systemExe('icacls.exe'), [dir, '/inheritance:r',
    '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/Q'],
  { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const ok = r.status === 0;
  if (ok) done.add(dir);
  return { ok, status: r.status };
}
