/**
 * Short status messages with an optional action (for example "Undo").
 * Announced politely to screen readers through an aria-live region.
 */

import { h } from '../utils/dom.js';

let region;
let timer;

function getRegion() {
  if (!region || !region.isConnected) {
    region = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

export function showToast(message, { action, tone = 'neutral', duration = 5000 } = {}) {
  const container = getRegion();
  clearTimeout(timer);
  const dismiss = () => container.replaceChildren();
  const toast = h(
    'div',
    { class: `toast toast-${tone}` },
    h('span', { class: 'toast-message' }, message),
    action
      ? h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            on: {
              click: () => {
                dismiss();
                action.onClick();
              },
            },
          },
          action.label,
        )
      : null,
  );
  container.replaceChildren(toast);
  timer = setTimeout(dismiss, duration);
}
