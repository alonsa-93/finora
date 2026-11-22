// Classic, render-blocking script: resolves the theme before first paint so nothing flashes.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('mc.theme') || 'system'; } catch (e) { /* storage blocked: follow the OS */ }
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try {
    var w = parseInt(localStorage.getItem('mc.sidebarW'), 10);
    if (w >= 160 && w <= 360) document.documentElement.style.setProperty('--sb-w', w + 'px');
  } catch (e) { /* ignore */ }
})();
