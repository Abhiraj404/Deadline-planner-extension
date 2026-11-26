// Runs before the stylesheet paints so a saved light/dark choice does not flash.
// The value is a cache of settings.theme written by services/theme.js.
(function () {
  try {
    var theme = localStorage.getItem('dr-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch {
    // Storage can be unavailable; the system theme is used instead.
  }
})();
