// Remembered UI state. Every access is wrapped: storage may be unavailable and the app must still work.
const P = 'mc.';

export function getPref(key, fallback) {
  try {
    const raw = localStorage.getItem(P + key);
    if (raw === null) return fallback;
    if (key === 'theme') return raw;
    return JSON.parse(raw);
  } catch { return fallback; }
}

export function setPref(key, value) {
  try {
    if (key === 'theme') localStorage.setItem(P + key, value);
    else if (key === 'sidebarW') localStorage.setItem(P + key, String(value));
    else localStorage.setItem(P + key, JSON.stringify(value));
  } catch { /* ignore */ }
}
