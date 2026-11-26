/**
 * Reminder interval picker: the standard presets as toggle pills, plus custom
 * intervals ("2 days", "6 hours"). Used by Settings and the deadline form.
 */

import { MAX_REMINDER_OFFSET_MINUTES } from '../models/settings.js';
import { REMINDER_PRESETS, describeOffset } from '../services/reminders.js';
import { h } from '../utils/dom.js';
import { icon } from './icons.js';

/**
 * @param {number[]} initial selected offsets in minutes
 * @param {(offsets: number[]) => void} [onChange] called after every change
 * @param {{ label?: string, keyPrefix?: string }} [options]
 */
export function createOffsetPicker(
  initial,
  onChange,
  { label = 'Reminders', keyPrefix = 'reminder' } = {},
) {
  const selected = new Set(initial);
  const element = h('div', { class: 'offset-picker' });
  const emit = () => onChange?.([...selected].sort((a, b) => b - a));

  const amount = h('input', {
    class: 'input input-number',
    type: 'number',
    min: 1,
    max: 60,
    step: 1,
    value: 2,
    'aria-label': 'Custom reminder amount',
  });
  const unit = h(
    'select',
    { class: 'input select input-unit', 'aria-label': 'Custom reminder unit' },
    h('option', { value: '1440' }, 'days before'),
    h('option', { value: '60' }, 'hours before'),
    h('option', { value: '1' }, 'minutes before'),
  );
  const error = h('p', { class: 'field-error', hidden: true });

  function render() {
    const custom = [...selected].filter(
      (minutes) => !REMINDER_PRESETS.some((preset) => preset.minutes === minutes),
    );
    element.replaceChildren(
      h(
        'div',
        { class: 'check-pills check-pills-flush', role: 'group', 'aria-label': label },
        REMINDER_PRESETS.map((preset) => {
          const box = h('input', {
            type: 'checkbox',
            checked: selected.has(preset.minutes),
            dataset: { setting: `${keyPrefix}-${preset.minutes}` },
          });
          box.addEventListener('change', () => {
            if (box.checked) selected.add(preset.minutes);
            else selected.delete(preset.minutes);
            emit();
          });
          return h(
            'label',
            {
              class: 'check-pill',
              title: preset.needsTime ? 'Only for deadlines with a submission time' : null,
            },
            box,
            h('span', null, preset.label),
          );
        }),
        custom
          .sort((a, b) => b - a)
          .map((minutes) =>
            h(
              'span',
              { class: 'check-pill is-custom' },
              h('span', null, describeOffset(minutes)),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-button icon-button-sm',
                  'aria-label': `Remove reminder ${describeOffset(minutes)}`,
                  on: {
                    click: () => {
                      selected.delete(minutes);
                      render();
                      emit();
                    },
                  },
                },
                icon('x', { size: 11 }),
              ),
            ),
          ),
      ),
      h(
        'div',
        { class: 'inline-row custom-offset' },
        amount,
        unit,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            on: {
              click: () => {
                const minutes = Number(amount.value) * Number(unit.value);
                const valid =
                  Number.isInteger(minutes) &&
                  minutes > 0 &&
                  minutes <= MAX_REMINDER_OFFSET_MINUTES;
                error.hidden = valid;
                error.textContent = valid ? '' : 'Choose a whole number up to 60 days before.';
                if (!valid) return;
                selected.add(minutes);
                render();
                emit();
              },
            },
          },
          'Add custom',
        ),
      ),
      error,
    );
  }
  render();
  return { element, getOffsets: () => [...selected].sort((a, b) => b - a) };
}
