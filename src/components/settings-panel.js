/**
 * Settings dialog (dashboard). Each control saves as soon as it changes; there is
 * no separate Save button to forget.
 */

import { BUILT_IN_CATEGORIES, getCategories } from '../models/settings.js';
import { backupFileName, createBackup, mergeAssessments, parseBackup } from '../services/backup.js';
import { REMINDER_PRESETS } from '../services/reminders.js';
import { listTimeZones } from '../utils/dates.js';
import { h, uniqueId } from '../utils/dom.js';
import { addCategory } from './deadline-dialogs.js';
import { confirmDialog, openDialog } from './dialog.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

function section(title, description, ...content) {
  return h(
    'section',
    { class: 'settings-section' },
    h(
      'div',
      { class: 'settings-intro' },
      h('h3', null, title),
      description ? h('p', null, description) : null,
    ),
    h('div', { class: 'settings-controls' }, content),
  );
}

function labelled(label, control, hint) {
  const id = control.id || uniqueId('setting');
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field-label', for: id }, label),
    control,
    hint ? h('p', { class: 'field-hint' }, hint) : null,
  );
}

function selectControl(options, value, onChange) {
  const element = h(
    'select',
    { class: 'input select' },
    options.map((option) =>
      h('option', { value: option.value, selected: option.value === value }, option.label),
    ),
  );
  element.addEventListener('change', () => onChange(element.value));
  return element;
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chooseRestoreMode(count) {
  return new Promise((resolve) => {
    let mode = null;
    const choose = (value) => {
      mode = value;
      handle.close();
    };
    const handle = openDialog({
      title: 'Restore backup',
      size: 'sm',
      body: h(
        'p',
        { class: 'confirm-message' },
        `The backup contains ${count} deadline${count === 1 ? '' : 's'}. Merge keeps your current deadlines and adds or updates from the backup. Replace removes everything first.`,
      ),
      footer: [
        h(
          'button',
          { type: 'button', class: 'btn', on: { click: () => handle.close() } },
          'Cancel',
        ),
        h(
          'button',
          { type: 'button', class: 'btn btn-ghost-danger', on: { click: () => choose('replace') } },
          'Replace all',
        ),
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', on: { click: () => choose('merge') } },
          'Merge',
        ),
      ],
      onClose: () => resolve(mode),
    });
  });
}

export function openSettings(app) {
  const handle = openDialog({ title: 'Settings', size: 'lg' });

  const save = async (changes) => {
    try {
      await app.storage.saveSettings({ ...app.getSettings(), ...changes });
    } catch (error) {
      showToast(error.message, { tone: 'danger' });
    }
  };

  function render() {
    const settings = app.getSettings();
    // Controls are rebuilt after every save; remember which one had focus so keyboard
    // users stay in place.
    const focusedKey = handle.body.contains(document.activeElement)
      ? document.activeElement.dataset?.setting
      : null;

    const theme = h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' },
      [
        ['system', 'System', 'system'],
        ['light', 'Light', 'sun'],
        ['dark', 'Dark', 'moon'],
      ].map(([value, label, iconName]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: 'segment',
            dataset: { setting: `theme-${value}` },
            'aria-checked': String(settings.theme === value),
            'aria-selected': String(settings.theme === value),
            on: { click: () => save({ theme: value }) },
          },
          icon(iconName, { size: 14 }),
          label,
        ),
      ),
    );

    const timeZone = selectControl(
      listTimeZones().map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') })),
      settings.timeZone,
      (value) => save({ timeZone: value }),
    );
    timeZone.dataset.setting = 'timeZone';
    const dueSoon = h('input', {
      class: 'input',
      type: 'number',
      min: 0,
      max: 60,
      step: 1,
      value: settings.dueSoonDays,
      dataset: { setting: 'dueSoon' },
    });
    dueSoon.addEventListener('change', () => {
      const value = Number(dueSoon.value);
      if (Number.isInteger(value) && value >= 0 && value <= 60) save({ dueSoonDays: value });
      else dueSoon.value = settings.dueSoonDays;
    });
    const categories = getCategories(settings);
    const defaultCategory = selectControl(
      categories.map((category) => ({ value: category.id, label: category.label })),
      settings.defaultCategory,
      (value) => save({ defaultCategory: value }),
    );
    defaultCategory.dataset.setting = 'defaultCategory';
    const defaultPriority = selectControl(
      [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
      settings.defaultPriority,
      (value) => save({ defaultPriority: value }),
    );
    defaultPriority.dataset.setting = 'defaultPriority';
    const weekStart = selectControl(
      [
        { value: '1', label: 'Monday' },
        { value: '0', label: 'Sunday' },
      ],
      String(settings.weekStartsOn),
      (value) => save({ weekStartsOn: Number(value) }),
    );
    weekStart.dataset.setting = 'weekStart';

    const notifications = h('input', {
      type: 'checkbox',
      checked: settings.notificationsEnabled,
      dataset: { setting: 'notifications' },
    });
    notifications.addEventListener('change', () =>
      save({ notificationsEnabled: notifications.checked }),
    );
    const offsets = new Set(settings.defaultReminderOffsets);
    const reminderPills = h(
      'div',
      { class: 'check-pills check-pills-flush', role: 'group', 'aria-label': 'Default reminders' },
      REMINDER_PRESETS.map((preset) => {
        const box = h('input', {
          type: 'checkbox',
          checked: offsets.has(preset.minutes),
          dataset: { setting: `reminder-${preset.minutes}` },
        });
        box.addEventListener('change', () => {
          if (box.checked) offsets.add(preset.minutes);
          else offsets.delete(preset.minutes);
          save({ defaultReminderOffsets: [...offsets] });
        });
        return h('label', { class: 'check-pill' }, box, h('span', null, preset.label));
      }),
    );
    const reminderTime = h('input', {
      class: 'input input-time',
      type: 'time',
      value: settings.reminderTime,
      dataset: { setting: 'reminderTime' },
    });
    reminderTime.addEventListener(
      'change',
      () => reminderTime.value && save({ reminderTime: reminderTime.value }),
    );

    const newCategory = h('input', {
      class: 'input',
      type: 'text',
      maxlength: 40,
      placeholder: 'New category',
      'aria-label': 'New category name',
      dataset: { setting: 'newCategory' },
    });
    const addCategoryButton = h(
      'button',
      {
        type: 'button',
        class: 'btn',
        on: {
          click: async () => {
            const label = newCategory.value.trim();
            if (!label) return newCategory.focus();
            await addCategory(app, label);
          },
        },
      },
      'Add',
    );
    newCategory.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addCategoryButton.click();
      }
    });
    const categoryList = h(
      'ul',
      { class: 'category-list' },
      BUILT_IN_CATEGORIES.map((category) =>
        h('li', { class: 'category-item is-builtin' }, category.label),
      ),
      settings.customCategories.map((category) =>
        h(
          'li',
          { class: 'category-item' },
          category.label,
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button icon-button-sm',
              'aria-label': `Remove category ${category.label}`,
              on: {
                click: () =>
                  save({
                    customCategories: settings.customCategories.filter(
                      (item) => item.id !== category.id,
                    ),
                    defaultCategory:
                      settings.defaultCategory === category.id
                        ? 'assignment'
                        : settings.defaultCategory,
                  }),
              },
            },
            icon('x', { size: 12 }),
          ),
        ),
      ),
    );

    const restoreInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      class: 'sr-only',
      tabindex: '-1',
      'aria-hidden': 'true',
    });
    restoreInput.addEventListener('change', async () => {
      const file = restoreInput.files?.[0];
      restoreInput.value = '';
      if (!file) return;
      const parsed = parseBackup(await file.text());
      if (!parsed.ok) return showToast(parsed.error, { tone: 'danger' });
      const mode = await chooseRestoreMode(parsed.assessments.length);
      if (!mode) return;
      const { assessments } = app.getState();
      await app.storage.replaceAll({
        assessments: mergeAssessments(assessments, parsed.assessments, mode),
        settings: mode === 'replace' ? parsed.settings : app.getSettings(),
      });
      const skipped = parsed.skipped ? ` (${parsed.skipped} invalid skipped)` : '';
      showToast(`Restored ${parsed.assessments.length} deadlines${skipped}`, { tone: 'success' });
    });

    const version = globalThis.chrome?.runtime?.getManifest?.().version ?? 'preview';

    handle.body.replaceChildren(
      h(
        'div',
        { class: 'settings' },
        section('Appearance', 'Follow your system or choose a theme.', theme),
        section(
          'Deadlines',
          'Defaults for new deadlines and how urgency is shown.',
          h(
            'div',
            { class: 'settings-grid' },
            labelled(
              'Time zone',
              timeZone,
              'New deadlines use this zone. Date-only deadlines are due by the end of the day.',
            ),
            labelled('“Due soon” means within (days)', dueSoon),
            labelled('Default category', defaultCategory),
            labelled('Default priority', defaultPriority),
            labelled('Calendar week starts on', weekStart),
          ),
        ),
        section(
          'Reminders',
          'Browser notifications before each deadline. They work while the browser is running.',
          h(
            'label',
            { class: 'checkbox-row' },
            notifications,
            h('span', null, 'Show reminder notifications'),
          ),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label' }, 'Default reminders'),
            reminderPills,
          ),
          labelled(
            'Time of day for date-only deadlines',
            reminderTime,
            'For example, “1 day before” a Friday deadline fires on Thursday at this time.',
          ),
        ),
        section(
          'Categories',
          'Built-in categories plus your own.',
          categoryList,
          h('div', { class: 'inline-row' }, newCategory, addCategoryButton),
        ),
        section(
          'Backup and data',
          'Everything is stored only in this browser profile. Export a backup to move or keep your data safe.',
          h(
            'div',
            { class: 'inline-row wrap' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                on: {
                  click: () => {
                    downloadJson(createBackup(app.getState()), backupFileName());
                    showToast('Backup downloaded');
                  },
                },
              },
              icon('download', { size: 14 }),
              'Export backup',
            ),
            h(
              'button',
              { type: 'button', class: 'btn', on: { click: () => restoreInput.click() } },
              icon('upload', { size: 14 }),
              'Restore backup',
            ),
            restoreInput,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost-danger',
                on: {
                  click: async () => {
                    const count = app.getState().assessments.length;
                    const confirmed = await confirmDialog({
                      title: 'Delete all deadlines?',
                      message: `This permanently removes all ${count} deadlines from this browser. Export a backup first if you might need them. Settings are kept.`,
                      confirmLabel: 'Delete all',
                      danger: true,
                    });
                    if (confirmed) {
                      await app.storage.saveAssessments([]);
                      showToast('All deadlines deleted');
                    }
                  },
                },
              },
              icon('trash', { size: 14 }),
              'Delete all deadlines',
            ),
          ),
        ),
        h(
          'p',
          { class: 'settings-about' },
          `Deadline Reminder ${version} · No accounts, no tracking. Nothing leaves your browser.`,
        ),
      ),
    );
    if (focusedKey) handle.body.querySelector(`[data-setting="${focusedKey}"]`)?.focus();
  }

  render();
  const unsubscribe = app.onChange(render);
  handle.dialog.addEventListener('close', unsubscribe);
  return handle;
}
