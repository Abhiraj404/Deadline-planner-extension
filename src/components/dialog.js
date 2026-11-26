/**
 * Accessible modal dialogs built on the native <dialog> element.
 * showModal() gives us a focus trap, Escape to close, an inert background and a
 * top-layer backdrop for free. We add a labelled header and focus restoration.
 */

import { h, uniqueId } from '../utils/dom.js';
import { icon } from './icons.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {Node} [options.body]
 * @param {Node} [options.footer]
 * @param {'sm'|'md'|'lg'} [options.size]
 * @param {() => void} [options.onClose]
 * @returns {{ dialog: HTMLDialogElement, body: HTMLElement, close: () => void, setTitle: (t: string) => void }}
 */
export function openDialog({ title, body, footer, size = 'md', onClose, description } = {}) {
  const previouslyFocused = document.activeElement;
  const titleId = uniqueId('dialog-title');
  const titleNode = h('h2', { class: 'dialog-title', id: titleId }, title);
  const bodyNode = h('div', { class: 'dialog-body' }, body);

  const dialog = h(
    'dialog',
    { class: `dialog dialog-${size}`, 'aria-labelledby': titleId, tabindex: '-1' },
    h(
      'header',
      { class: 'dialog-header' },
      titleNode,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': 'Close',
          title: 'Close (Esc)',
          on: { click: () => close() },
        },
        icon('x'),
      ),
    ),
    description ? h('p', { class: 'dialog-description' }, description) : null,
    bodyNode,
    footer ? h('footer', { class: 'dialog-footer' }, footer) : null,
  );

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    dialog.close();
  }

  dialog.addEventListener('close', () => {
    closed = true;
    dialog.remove();
    onClose?.();
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
  });
  // Clicking the backdrop (the dialog element itself, outside its content) closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  document.body.append(dialog);
  dialog.showModal();
  // showModal() focuses the first control (the close button). Focus the dialog itself
  // instead; callers then move focus to the most useful field.
  dialog.focus();
  return {
    dialog,
    body: bodyNode,
    close,
    setTitle: (text) => {
      titleNode.textContent = text;
    },
  };
}

/** Promise-based confirmation. Resolves true only when the confirm button is pressed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const confirmButton = h(
      'button',
      {
        type: 'button',
        class: ['btn', danger ? 'btn-danger' : 'btn-primary'],
        on: {
          click: () => {
            confirmed = true;
            handle.close();
          },
        },
      },
      confirmLabel,
    );
    const handle = openDialog({
      title,
      size: 'sm',
      body: h('p', { class: 'confirm-message' }, message),
      footer: [
        h(
          'button',
          { type: 'button', class: 'btn', on: { click: () => handle.close() } },
          'Cancel',
        ),
        confirmButton,
      ],
      onClose: () => resolve(confirmed),
    });
    confirmButton.focus();
  });
}
