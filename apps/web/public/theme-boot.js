/* p17-remyral-brand: the console theme before the first paint (no flash). A classic script loaded from <head> (CSP
   script-src 'self': no inline script). Reads this browser's copy of the choice (src/theme/theme.ts keeps it in sync
   with the account's choice on the master) and marks <html>; "system" (or nothing stored) leaves it unmarked, so
   prefers-color-scheme applies. Storage can throw (private mode, blocked site data): then the system theme applies. */
/* global window, document */
(function () {
  try {
    var t = window.localStorage.getItem('remyral.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch {
    /* the system theme applies */
  }
})();
