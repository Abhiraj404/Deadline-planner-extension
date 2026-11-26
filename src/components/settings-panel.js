/**
 * Settings dialog (dashboard). Each control saves as soon as it changes; there is
 * no separate Save button to forget.
 */

import { BUILT_IN_CATEGORIES, IMPORT_LIMIT_RANGES, getCategories } from '../models/settings.js';
import { fileStore } from '../services/file-store.js';
import { BADGE_MODES, SNOOZE_OPTIONS } from '../services/reminders.js';
import {
  demoControls,
  exportBackup,
  resetEverything,
  restoreBackup,
  storageUsageLine,
} from './data-tools.js';
import { createOffsetPicker } from './offset-picker.js';
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
    const reminderPicker = createOffsetPicker(
      settings.defaultReminderOffsets,
      (offsets) => save({ defaultReminderOffsets: offsets }),
      { label: 'Default reminders' },
    );
    const badgeMode = selectControl(
      Object.entries(BADGE_MODES).map(([value, label]) => ({ value, label })),
      settings.badgeMode,
      (value) => save({ badgeMode: value }),
    );
    badgeMode.dataset.setting = 'badgeMode';
    const snoozeLength = selectControl(
      SNOOZE_OPTIONS.map((option) => ({ value: String(option.minutes), label: option.label })),
      String(settings.snoozeMinutes),
      (value) => save({ snoozeMinutes: Number(value) }),
    );
    snoozeLength.dataset.setting = 'snoozeMinutes';
    const history = app.getState().reminderState?.history ?? [];
    const historyList = history.length
      ? h(
          'ul',
          { class: 'plain-list history-list' },
          history
            .slice(0, 8)
            .map((entry) =>
              h(
                'li',
                null,
                `${new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · `,
                entry.kind === 'missed-summary'
                  ? `${entry.count} missed reminders summarised`
                  : `${entry.kind === 'snooze' ? 'Snoozed reminder' : entry.kind === 'missed' ? 'Missed reminder' : 'Reminder'}: ${entry.title ?? (entry.titles ?? []).join(', ')}`,
              ),
            ),
        )
      : h('p', { class: 'muted' }, 'No reminders have been shown yet.');

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
      if (file) await restoreBackup(app, file);
    });

    const version = globalThis.chrome?.runtime?.getManifest?.().version ?? 'preview';

    const retain = h('input', {
      type: 'checkbox',
      checked: settings.retainDocumentFiles,
      dataset: { setting: 'retain' },
    });
    retain.addEventListener('change', async () => {
      if (!retain.checked && (app.getState().documents ?? []).some((record) => record.fileStored)) {
        const confirmed = await confirmDialog({
          title: 'Stop keeping original files?',
          message:
            'Stored copies of imported files will be deleted. The details and evidence stay in the library.',
          confirmLabel: 'Delete stored files',
          danger: true,
        });
        if (!confirmed) {
          retain.checked = true;
          return;
        }
        await fileStore.clear().catch(() => {});
        await app.storage.updateDocuments((records) =>
          records.map((record) => (record.fileStored ? { ...record, fileStored: false } : record)),
        );
      }
      save({ retainDocumentFiles: retain.checked });
    });
    const limitLabels = {
      maxFileSizeMB: 'Largest file (MB)',
      maxPdfPages: 'Most PDF pages read',
      maxTextChars: 'Most characters of text read',
      maxDocxExpandedMB: 'Largest unpacked Word file (MB)',
      maxBatchSize: 'Files per import batch',
    };
    const limitInputs = Object.entries(IMPORT_LIMIT_RANGES).map(([key, [min, max]]) => {
      const input = h('input', {
        class: 'input',
        type: 'number',
        min,
        max,
        step: 1,
        value: settings.importLimits[key],
        dataset: { setting: `limit-${key}` },
      });
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isInteger(value) && value >= min && value <= max) {
          save({ importLimits: { ...app.getSettings().importLimits, [key]: value } });
        } else input.value = settings.importLimits[key];
      });
      return labelled(limitLabels[key], input, `${min.toLocaleString()}–${max.toLocaleString()}`);
    });

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
          'Browser notifications before each deadline, scheduled with the browser’s alarm system.',
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
            reminderPicker.element,
            h(
              'p',
              { class: 'field-hint' },
              '“1 hour before” and other reminders under a day only apply to deadlines with a submission time. Each deadline can override these in its Advanced options.',
            ),
          ),
          h(
            'div',
            { class: 'settings-grid' },
            labelled(
              'Reminder time for date-only deadlines',
              reminderTime,
              'Used because a date-only deadline has no official time. “1 day before” a Friday deadline fires on Thursday at this time.',
            ),
            labelled('Snooze length (notification button)', snoozeLength),
            labelled(
              'Toolbar badge shows',
              badgeMode,
              'The tooltip always lists overdue, due-soon and upcoming counts.',
            ),
          ),
          h(
            'p',
            { class: 'notice notice-warning' },
            'Reminders are a convenience, not a guarantee. The browser may deliver them a few minutes late, and nothing can be shown while the browser or computer is off; reminders missed in that time are summarised when the browser starts again. Always check official deadlines with your college.',
          ),
          h('details', null, h('summary', { class: 'link' }, 'Recent reminders'), historyList),
        ),
        section(
          'Categories',
          'Built-in categories plus your own.',
          categoryList,
          h('div', { class: 'inline-row' }, newCategory, addCategoryButton),
        ),
        section(
          'Document import',
          'Briefs are read on this device. These limits protect against very large or malformed files.',
          h(
            'label',
            { class: 'checkbox-row' },
            retain,
            h('span', null, 'Keep original files (stored in this browser only)'),
          ),
          h('div', { class: 'settings-grid' }, limitInputs),
        ),
        section(
          'Backup and restore',
          'Everything is stored only in this browser profile. A backup is a JSON file with your deadlines, modules, notes, completion, reminder settings and document details (never the documents themselves).',
          h(
            'div',
            { class: 'inline-row wrap' },
            h(
              'button',
              { type: 'button', class: 'btn', on: { click: () => exportBackup(app) } },
              icon('download', { size: 14 }),
              'Export backup',
            ),
            h(
              'button',
              { type: 'button', class: 'btn', on: { click: () => restoreInput.click() } },
              icon('upload', { size: 14 }),
              'Restore backup…',
            ),
            restoreInput,
          ),
          storageUsageLine(h('p', { class: 'field-hint' }, 'Checking storage use…')),
        ),
        section(
          'Demo data',
          'Invented deadlines for trying the extension. They are marked as demo and can be removed without touching your own.',
          demoControls(app),
        ),
        section(
          'Reset',
          'Delete everything this extension stores in this browser.',
          h(
            'div',
            null,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost-danger',
                on: { click: () => resetEverything(app) },
              },
              icon('trash', { size: 14 }),
              'Reset everything…',
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
