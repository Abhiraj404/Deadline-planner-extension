/**
 * Small DOM helpers. All text goes through `textContent` / text nodes, so user input
 * can never be interpreted as HTML. Nothing in this project uses innerHTML.
 */

/**
 * Create an element.
 *   h('button', { class: 'btn', type: 'button', on: { click: fn } }, 'Save')
 * Props: `class`, `dataset`, `on` (event listeners), `text`, booleans set/remove
 * attributes, everything else becomes an attribute. Children may be nodes, strings,
 * numbers, arrays, or null/false (skipped).
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class')
      element.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value))
        element.addEventListener(event, handler);
    } else if (key === 'text') element.textContent = value;
    else if (key === 'value' && 'value' in element) element.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'open') {
      element[key] = Boolean(value);
    } else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function debounce(fn, wait = 150) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** True when a key press should not trigger a page shortcut (the user is typing). */
export function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

let idCounter = 0;
export function uniqueId(prefix = 'dr') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
