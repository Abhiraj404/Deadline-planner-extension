/**
 * Quick actions on a deadline card (popup and dashboard): complete, open, and a small
 * "more" menu with edit, snooze, pin and details. Built on the native Popover API, so
 * it closes on Escape or an outside click and sits above everything else.
 */

import { SNOOZE_OPTIONS } from '../services/reminders.js';
import { h } from '../utils/dom.js';
import { openDeadlineDetails, openDeadlineEditor, toggleComplete } from './deadline-dialogs.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

let openMenuElement = null;

/**
 * @param {HTMLElement} anchor the button that opened the menu (focus returns to it)
 * @param {Array<{ label: string, icon?: string, run: () => void } | null>} items
 */
export function openMenu(anchor, items) {
  openMenuElement?.hidePopover?.();
  const buttons = items
    .filter(Boolean)
    .map((item) =>
      h(
        'button',
        { type: 'button', role: 'menuitem', class: 'menu-item', tabindex: '-1' },
        item.icon ? icon(item.icon, { size: 14 }) : null,
        item.label,
      ),
    );
  const menu = h(
    'div',
    {
      class: 'menu',
      popover: 'auto',
      role: 'menu',
      'aria-label': anchor.getAttribute('aria-label') ?? 'Actions',
    },
    buttons,
  );
  buttons.forEach((button, index) =>
    button.addEventListener('click', () => {
      menu.hidePopover();
      items.filter(Boolean)[index].run();
    }),
  );
  menu.addEventListener('keydown', (event) => {
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : buttons.length - 1;
      buttons[(index + step) % buttons.length].focus();
    } else if (event.key === 'Home') buttons[0].focus();
    else if (event.key === 'End') buttons.at(-1).focus();
    else if (event.key === 'Tab') menu.hidePopover();
  });
  menu.addEventListener('toggle', (event) => {
    if (event.newState !== 'closed') return;
    anchor.setAttribute('aria-expanded', 'false');
    if (menu.contains(document.activeElement) || document.activeElement === document.body)
      anchor.focus();
    menu.remove();
    if (openMenuElement === menu) openMenuElement = null;
  });

  document.body.append(menu);
  menu.showPopover();
  openMenuElement = menu;
  anchor.setAttribute('aria-expanded', 'true');
  // Place under the anchor, right-aligned, kept inside the viewport.
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8),
  );
  const below = rect.bottom + 4 + menu.offsetHeight <= window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - menu.offsetHeight - 4)}px`;
  buttons[0]?.focus();
  return menu;
}

/** Mute a deadline's reminders for a while; the reminder comes back afterwards. */
export async function snoozeDeadline(app, assessment, minutes) {
  const until = Date.now() + minutes * 60_000;
  let previous;
  await app.storage.updateReminderState((state) => {
    previous = state.snoozes[assessment.id];
    return { ...state, snoozes: { ...state.snoozes, [assessment.id]: until } };
  });
  const label =
    SNOOZE_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `${minutes} minutes`;
  showToast(`Reminders for “${assessment.title}” snoozed for ${label}`, {
    action: {
      label: 'Undo',
      onClick: () =>
        app.storage.updateReminderState((state) => {
          const snoozes = { ...state.snoozes };
          if (previous) snoozes[assessment.id] = previous;
          else delete snoozes[assessment.id];
          return { ...state, snoozes };
        }),
    },
  });
}

async function togglePin(app, assessment) {
  await app.service.togglePinned(assessment.id);
  showToast(
    assessment.pinned
      ? `Unpinned “${assessment.title}”`
      : `Pinned “${assessment.title}” to the top`,
  );
}

/** The "more" menu for one deadline. */
export function openCardMenu(app, assessment, anchor) {
  const snoozed = (app.getState().reminderState?.snoozes ?? {})[assessment.id] > Date.now();
  openMenu(anchor, [
    { label: 'Edit', icon: 'edit', run: () => openDeadlineEditor(app, { assessment }) },
    {
      label: assessment.pinned ? 'Unpin' : 'Pin to top',
      icon: 'pin',
      run: () => togglePin(app, assessment),
    },
    ...(assessment.completed
      ? []
      : SNOOZE_OPTIONS.map((option) => ({
          label: `Snooze reminders ${option.label}`,
          icon: 'clock',
          run: () => snoozeDeadline(app, assessment, option.minutes),
        }))),
    snoozed
      ? {
          label: 'Resume reminders now',
          icon: 'bell',
          run: () =>
            app.storage.updateReminderState((state) => {
              const snoozes = { ...state.snoozes };
              delete snoozes[assessment.id];
              return { ...state, snoozes };
            }),
        }
      : null,
    { label: 'Open details', icon: 'expand', run: () => openDeadlineDetails(app, assessment.id) },
  ]);
}

/**
 * One delegated click handler for a container of cards.
 * @returns {boolean} true when the click was a card action
 */
export function handleCardClick(app, event) {
  const target = event.target.closest('[data-action]');
  const card = event.target.closest('.card');
  if (!target || !card) return false;
  const assessment = app.getAssessment(card.dataset.id);
  if (!assessment) return false;
  const action = target.dataset.action;
  if (action === 'toggle-complete') toggleComplete(app, assessment);
  else if (action === 'menu') openCardMenu(app, assessment, target);
  else if (action === 'open') openDeadlineDetails(app, assessment.id);
  else return false;
  return true;
}
