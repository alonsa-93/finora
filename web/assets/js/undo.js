// One-step undo for data edits (category change, exclusion). The toast's "ביטול" button and
// Ctrl+Z both run the latest registered undo; the server reverts the rows and the merchant rule
// (POST /api/transactions/undo).
import { announce } from './layers.js';

let last = null;

/** Register the undo for the edit that just happened (replaces the previous one). */
export function registerUndo(label, run) {
  const entry = { label, run };
  last = entry;
  return () => { if (last === entry) last = null; };
}

/** Run the latest undo once. Returns true when something was undone. */
export async function undoLast() {
  if (!last) { announce('אין פעולה לביטול'); return false; }
  const entry = last;
  last = null;
  await entry.run();
  return true;
}
