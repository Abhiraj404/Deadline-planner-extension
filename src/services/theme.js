/**
 * Theme handling. Colours live in styles/tokens.css and switch with CSS
 * `light-dark()`; this module only sets `data-theme` on <html>.
 * "system" removes the attribute so the browser's preference applies.
 */

const CACHE_KEY = 'dr-theme';
export const THEME_ORDER = ['system', 'light', 'dark'];
export const THEME_LABELS = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

export function applyTheme(theme, root = document.documentElement) {
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    // Read synchronously by public/theme-boot.js on the next page load.
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Ignore: the theme still applies, it may just flash on the next open.
  }
}

export function nextTheme(theme) {
  return THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
}
