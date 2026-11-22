// Bootstrap for browser mode (`npm start`) and the Edge app window: exchange the one-time token from
// the URL fragment for the HttpOnly session cookie plus the API token (answer body), then open the
// dashboard. The fragment is removed from the address bar and history first. The API token goes to
// sessionStorage only: this tab, this origin (port included), gone when the tab closes; api.js sends
// it in X-MoneyCash. Not imported from api.js so this page loads nothing else.
(async () => {
  const msg = document.getElementById('msg');
  const token = location.hash.slice(1);
  history.replaceState(null, '', '/auth');
  try {
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MoneyCash': '1' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });
    if (r.status === 200) {
      const { apiToken } = await r.json();
      if (typeof apiToken === 'string' && apiToken) {
        sessionStorage.setItem('mc_api', apiToken); // api.js TOKEN_KEY
        location.replace('/');
        return;
      }
    }
  } catch { /* fall through */ }
  msg.textContent = 'הקישור לכניסה כבר נוצל או אינו תקין. כדי להיכנס, הפעל את MoneyCash מחדש.';
})();
