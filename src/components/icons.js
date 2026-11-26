/**
 * Inline SVG icons drawn for this project (24×24 grid, stroked).
 * Built with createElementNS so no markup strings are parsed.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Each icon is a list of [elementName, attributes].
const ICONS = {
  logo: [
    ['rect', { x: 3, y: 4, width: 18, height: 17, rx: 4 }],
    ['path', { d: 'M3 9h18M8 2.5v3M16 2.5v3' }],
    ['path', { d: 'm8.5 14.5 2.5 2.5 4.5-5' }],
  ],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['path', { d: 'm20 20-4.2-4.2' }],
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    [
      'path',
      {
        d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
      },
    ],
  ],
  moon: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z' }]],
  system: [
    ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }],
    ['path', { d: 'M8 20h8M12 16v4' }],
  ],
  settings: [
    ['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }],
    ['circle', { cx: 15, cy: 7, r: 2 }],
    ['circle', { cx: 9, cy: 17, r: 2 }],
  ],
  expand: [['path', { d: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7' }]],
  upload: [
    ['path', { d: 'M12 15V4M7.5 8.5 12 4l4.5 4.5' }],
    ['path', { d: 'M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4' }],
  ],
  file: [
    ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z' }],
    ['path', { d: 'M14 3v5h5M9 13h6M9 17h4' }],
  ],
  check: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]],
  x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  trash: [
    ['path', { d: 'M4 7h16M10 11v6M14 11v6M9 7V4h6v3' }],
    ['path', { d: 'M6 7l1 13h10l1-13' }],
  ],
  edit: [['path', { d: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z M13.5 6.5l4 4' }]],
  calendar: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15, rx: 2.5 }],
    ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }],
  ],
  list: [['path', { d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }]],
  agenda: [['path', { d: 'M4 5h16M4 10h10M4 15h16M4 20h10' }]],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5V12l3 2' }],
  ],
  alert: [
    ['path', { d: 'M12 3.5 2.5 20h19Z' }],
    ['path', { d: 'M12 10v4.5M12 17.5h.01' }],
  ],
  chevronLeft: [['path', { d: 'm14.5 6-6 6 6 6' }]],
  chevronRight: [['path', { d: 'm9.5 6 6 6-6 6' }]],
  chevronDown: [['path', { d: 'm6 9.5 6 6 6-6' }]],
  link: [
    ['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1' }],
    ['path', { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }],
  ],
  bell: [
    ['path', { d: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z' }],
    ['path', { d: 'M10 20.5a2 2 0 0 0 4 0' }],
  ],
  undo: [['path', { d: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3' }]],
  download: [
    ['path', { d: 'M12 4v11M7.5 10.5 12 15l4.5-4.5' }],
    ['path', { d: 'M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4' }],
  ],
  pin: [
    ['path', { d: 'M9 4h6l-1 6 3 3H7l3-3Z' }],
    ['path', { d: 'M12 13v7' }],
  ],
  more: [
    ['circle', { cx: 5.5, cy: 12, r: 1.2 }],
    ['circle', { cx: 12, cy: 12, r: 1.2 }],
    ['circle', { cx: 18.5, cy: 12, r: 1.2 }],
  ],
  inbox: [
    ['path', { d: 'M3.5 13 6 5h12l2.5 8v6h-17Z' }],
    ['path', { d: 'M3.5 13H9l1 2h4l1-2h5.5' }],
  ],
};

/**
 * @param {keyof ICONS} name
 * @param {{ size?: number, label?: string, className?: string }} [options]
 *   Without a label the icon is decorative and hidden from screen readers.
 */
export function icon(name, { size = 16, label, className } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', ['icon', className].filter(Boolean).join(' '));
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  for (const [tag, attributes] of ICONS[name] ?? []) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
    svg.append(child);
  }
  return svg;
}
