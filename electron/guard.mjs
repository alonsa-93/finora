// FIRST import of electron/main.mjs: runs before Electron's API, Node's fs/path or any of our
// code is evaluated (ES modules evaluate their imports in order, depth first). No imports here.
//
// Refuse to run when the process could be driven from outside:
//  - ELECTRON_RUN_AS_NODE: electron.exe would be a plain Node.js (with our app folder next to it);
//  - NODE_OPTIONS (any non-empty value): --require / --import / --inspect preload code or open a
//    debugger in the main process;
//  - --inspect* / --remote-debugging* / --js-flags / --debug* on the command line.
//
// Residual risk (documented in README): the local install runs the stock electron.exe without fuses,
// so Node itself parses NODE_OPTIONS and --inspect BEFORE this file runs. A debugger port can be
// open for the few milliseconds until this exit; nothing of ours (window, cookie, key, data) has
// been loaded by then. Only a signed build with fuses (runAsNode / nodeOptions / nodeCliInspect off,
// see package.json `electronFuses`) closes that gap fully.
const argv = process.argv.slice(1);
const badArg = argv.find((a) => /^--?(inspect|remote-debugging|js-flags|debug)/i.test(String(a)));
const nodeOptions = String(process.env.NODE_OPTIONS || '').trim();
if (process.env.ELECTRON_RUN_AS_NODE || nodeOptions || badArg) {
  try { process.stderr.write('Finora: refusing to start with debugging switches or NODE_OPTIONS.\n'); } catch { /* no console */ }
  process.exit(1);
}
