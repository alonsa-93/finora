// Who may turn on developer mode (`--dev` / FINORA_DEV=1): only a source checkout.
//
// Developer mode loosens real guards (DevTools, FINORA_DATA_DIR, the OneDrive check, smoke-test
// hooks). The local install (scripts/install-local.ps1) runs the stock, unsigned electron.exe with
// no fuses, so `app.isPackaged` is false there too and cannot tell the two apart. A checkout is
// recognised on disk instead, and all of these must hold:
//   1. no install marker: install-local.ps1 writes `finora-install.json` into every install;
//   2. not under %LOCALAPPDATA%\Programs (where installs live, whatever the marker says);
//   3. a `.git` entry (directory, or file for worktrees) OR a development-only package that the
//      installer never copies (node_modules/electron-builder).
// Pure and synchronous: imported before anything else is loaded.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INSTALL_MARKER = 'finora-install.json';

const under = (p, root) => {
  if (!root) return false;
  const a = resolve(p).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`);
};

/**
 * @param {string} appRoot the folder holding package.json, electron/, server/, web/
 * @param {{env?: object, exists?: (p: string) => boolean}} [o] injectable for tests
 */
export function isSourceCheckout(appRoot, { env = process.env, exists = existsSync } = {}) {
  if (!appRoot) return false;
  if (exists(join(appRoot, INSTALL_MARKER))) return false;
  const programs = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : null;
  if (under(appRoot, programs)) return false;
  return exists(join(appRoot, '.git')) || exists(join(appRoot, 'node_modules', 'electron-builder', 'package.json'));
}

/** Developer mode = asked for AND running from a source checkout. */
export function devModeAllowed(requested, appRoot, o) {
  return Boolean(requested) && isSourceCheckout(appRoot, o);
}
