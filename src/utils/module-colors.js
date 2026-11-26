/**
 * Module colour labels. Each module gets one of eight colours, chosen from a hash of
 * its code (or name), so the same module always has the same colour on every page and
 * device without storing anything. Colours are defined as tokens in styles/tokens.css
 * (`--module-0` … `--module-7`) and always appear next to the module's text.
 */

export const MODULE_COLOR_COUNT = 8;

export function moduleColorIndex(key) {
  if (!key) return null;
  let hash = 0;
  for (const char of String(key).toUpperCase()) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % MODULE_COLOR_COUNT;
}

export function moduleColorClass(key) {
  const index = moduleColorIndex(key);
  return index === null ? null : `module-color-${index}`;
}
