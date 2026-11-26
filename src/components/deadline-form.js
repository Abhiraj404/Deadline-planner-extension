/**
 * The deadline form, shared by the popup and the dashboard for both creating and
 * editing. Only the title and due date are required; everything else sits under
 * "Advanced options" so a basic deadline takes two fields.
 */

import { RELATED_DATE_LABELS } from '../models/assessment.js';
import { getCategories } from '../models/settings.js';
import { describeOffset } from '../services/reminders.js';
import { createOffsetPicker } from './offset-picker.js';
import { listTimeZones } from '../utils/dates.js';
import { h, uniqueId } from '../utils/dom.js';
import { icon } from './icons.js';

const NEW_CATEGORY = '__new__';

function field({ label, input, hint, name, optional = false, className }) {
  const id = input.id || uniqueId(`f-${name}`);
  input.id = id;
  const errorId = `${id}-error`;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h(
    'div',
    { class: ['field', className], dataset: { field: name } },
    h(
      'label',
      { class: 'field-label', for: id },
      label,
      optional ? h('span', { class: 'field-optional' }, 'optional') : null,
    ),
    input,
    hint ? h('p', { class: 'field-hint', id: hintId }, hint) : null,
    h('p', { class: 'field-error', id: errorId, hidden: true }),
  );
}

function textInput(name, value, props = {}) {
  return h('input', { class: 'input', name, type: 'text', value: value ?? '', ...props });
}

function textarea(name, value, props = {}) {
  const element = h('textarea', { class: 'input textarea', name, rows: 3, ...props });
  element.value = value ?? '';
  return element;
}

function select(name, options, selected) {
  return h(
    'select',
    { class: 'input select', name },
    options.map((option) =>
      h('option', { value: option.value, selected: option.value === selected }, option.label),
    ),
  );
}

/** Editable checklist (deliverables). Items keep their ids and done state. */
function checklistEditor(initialItems) {
  let items = initialItems.map((item) => ({ ...item }));
  const list = h('ul', { class: 'checklist-editor' });
  const input = textInput('checklist-new', '', {
    placeholder: 'Add an item, then press Enter',
    'aria-label': 'New checklist item',
    maxlength: 300,
  });

  function render() {
    list.replaceChildren(
      ...items.map((item, index) =>
        h(
          'li',
          { class: 'checklist-editor-item' },
          h('span', { class: item.done ? 'is-done' : '' }, item.text),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button icon-button-sm',
              'aria-label': `Remove “${item.text}”`,
              on: {
                click: () => {
                  items.splice(index, 1);
                  render();
                  input.focus();
                },
              },
            },
            icon('x', { size: 14 }),
          ),
        ),
      ),
    );
  }

  function addFromInput() {
    const text = input.value.trim();
    if (!text) return;
    items = [...items, { text, done: false }];
    input.value = '';
    render();
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); // add the item instead of submitting the form
      addFromInput();
    }
  });
  render();

  const element = h(
    'div',
    { class: 'checklist-field' },
    list,
    h(
      'div',
      { class: 'inline-row' },
      input,
      h('button', { type: 'button', class: 'btn btn-sm', on: { click: addFromInput } }, 'Add'),
    ),
  );
  return {
    element,
    input,
    getItems: () => {
      addFromInput(); // keep text the user typed but did not add yet
      return items;
    },
  };
}

/** Reminder choice: the defaults, or a custom set of offsets. */
/** Reminders for one deadline: the defaults, none at all, or a custom set. */
function reminderEditor(initialOffsets, defaultOffsets) {
  const name = uniqueId('reminder-mode');
  const mode =
    initialOffsets === null ? 'default' : initialOffsets.length === 0 ? 'none' : 'custom';
  const defaultsText = defaultOffsets.length
    ? defaultOffsets.map(describeOffset).join(', ')
    : 'none';
  const radio = (value) => h('input', { type: 'radio', name, value, checked: mode === value });
  const defaultRadio = radio('default');
  const noneRadio = radio('none');
  const customRadio = radio('custom');
  const picker = createOffsetPicker(mode === 'custom' ? initialOffsets : defaultOffsets, null, {
    label: 'Reminders for this deadline',
  });
  const customGroup = h(
    'div',
    { class: 'reminder-custom', hidden: mode !== 'custom' },
    picker.element,
  );
  const sync = () => {
    customGroup.hidden = !customRadio.checked;
  };
  for (const input of [defaultRadio, noneRadio, customRadio])
    input.addEventListener('change', sync);

  const element = h(
    'fieldset',
    { class: 'fieldset' },
    h('legend', { class: 'field-label' }, 'Reminders'),
    h(
      'label',
      { class: 'radio-row' },
      defaultRadio,
      h('span', null, `Use my defaults (${defaultsText})`),
    ),
    h('label', { class: 'radio-row' }, customRadio, h('span', null, 'Choose for this deadline')),
    customGroup,
    h(
      'label',
      { class: 'radio-row' },
      noneRadio,
      h('span', null, 'No reminders for this deadline'),
    ),
  );

  return {
    element,
    getOffsets: () => (defaultRadio.checked ? null : noneRadio.checked ? [] : picker.getOffsets()),
  };
}

/** Editable list of related dates (presentation slot, exam, feedback…). */
function relatedDatesEditor(initial) {
  let items = initial.map((item) => ({ ...item }));
  const list = h('ul', { class: 'related-editor' });
  const labelOptions = Object.entries(RELATED_DATE_LABELS);

  function render() {
    list.replaceChildren(
      ...items.map((item, index) => {
        const label = h(
          'select',
          { class: 'input select', 'aria-label': 'Kind of date' },
          labelOptions.map(([value, text]) =>
            h('option', { value, selected: value === item.label }, text),
          ),
        );
        const date = h('input', {
          class: 'input',
          type: 'date',
          value: item.date ?? '',
          'aria-label': 'Date',
        });
        const time = h('input', {
          class: 'input',
          type: 'time',
          value: item.time ?? '',
          'aria-label': 'Time (optional)',
        });
        const note = h('input', {
          class: 'input',
          type: 'text',
          value: item.note ?? '',
          maxlength: 200,
          placeholder: 'Note',
          'aria-label': 'Note (optional)',
        });
        label.addEventListener('change', () => (item.label = label.value));
        date.addEventListener('change', () => (item.date = date.value));
        time.addEventListener('change', () => (item.time = time.value || null));
        note.addEventListener('input', () => (item.note = note.value));
        return h(
          'li',
          { class: 'related-editor-row' },
          label,
          date,
          time,
          note,
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button icon-button-sm',
              'aria-label': 'Remove this date',
              on: {
                click: () => {
                  items.splice(index, 1);
                  render();
                },
              },
            },
            icon('x', { size: 14 }),
          ),
        );
      }),
    );
  }
  render();
  const addButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm',
      on: {
        click: () => {
          items = [...items, { label: 'presentation', date: '', time: null, note: '' }];
          render();
          list.querySelector('li:last-child input[type=date]')?.focus();
        },
      },
    },
    icon('plus', { size: 13 }),
    'Add a date',
  );
  return {
    element: h('div', { class: 'checklist-field' }, list, h('div', null, addButton)),
    getItems: () => items.filter((item) => item.date || item.note),
  };
}

/**
 * @param {object} options
 * @param {'create'|'edit'} options.mode
 * @param {object} [options.initial] existing assessment or prefilled values
 * @param {object} options.settings
 * @param {(label: string) => Promise<{id: string, label: string} | null>} options.onAddCategory
 * @param {(value: object) => Promise<{ok: boolean, errors?: object}>} options.onSubmit
 * @param {() => void} options.onCancel
 */
export function createDeadlineForm({
  mode,
  initial = {},
  settings,
  onAddCategory,
  onSubmit,
  onCancel,
  openAdvanced = false,
}) {
  const categories = getCategories(settings);
  const values = {
    title: '',
    dueDate: '',
    dueTime: null,
    category: settings.defaultCategory,
    priority: settings.defaultPriority,
    reminderOffsets: null,
    checklist: [],
    tags: [],
    timeZone: settings.timeZone,
    ...initial,
  };

  const title = textInput('title', values.title, {
    required: true,
    maxlength: 200,
    autocomplete: 'off',
    placeholder: 'e.g. CA2 Group Project Report',
  });
  const dueDate = h('input', {
    class: 'input',
    name: 'dueDate',
    type: 'date',
    required: true,
    value: values.dueDate,
    min: '1970-01-01',
    max: '2100-12-31',
  });
  const dueTime = h('input', {
    class: 'input',
    name: 'dueTime',
    type: 'time',
    value: values.dueTime ?? '',
  });

  const categoryOptions = [
    ...categories.map((category) => ({ value: category.id, label: category.label })),
    { value: NEW_CATEGORY, label: '+ New category…' },
  ];
  if (!categories.some((category) => category.id === values.category)) {
    categoryOptions.unshift({ value: values.category, label: values.category });
  }
  const category = select('category', categoryOptions, values.category);
  const newCategoryInput = textInput('newCategory', '', {
    placeholder: 'Category name',
    maxlength: 40,
    'aria-label': 'New category name',
  });
  let lastCategory = values.category;
  const newCategoryRow = h(
    'div',
    { class: 'inline-row', hidden: true },
    newCategoryInput,
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm',
        on: {
          click: async () => {
            const label = newCategoryInput.value.trim();
            if (!label) return newCategoryInput.focus();
            const created = await onAddCategory(label);
            if (!created) return;
            const option = h('option', { value: created.id }, created.label);
            category.insertBefore(
              option,
              category.querySelector(`option[value="${NEW_CATEGORY}"]`),
            );
            category.value = created.id;
            lastCategory = created.id;
            newCategoryRow.hidden = true;
            newCategoryInput.value = '';
            category.focus();
          },
        },
      },
      'Add',
    ),
  );
  newCategoryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      newCategoryRow.querySelector('button').click();
    }
  });
  category.addEventListener('change', () => {
    if (category.value === NEW_CATEGORY) {
      newCategoryRow.hidden = false;
      category.value = lastCategory;
      newCategoryInput.focus();
    } else {
      lastCategory = category.value;
    }
  });

  const priority = select(
    'priority',
    [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    values.priority,
  );

  const moduleName = textInput('moduleName', values.moduleName, {
    maxlength: 120,
    placeholder: 'e.g. Software Engineering',
  });
  const moduleCode = textInput('moduleCode', values.moduleCode, {
    maxlength: 30,
    placeholder: 'e.g. COMP3010',
  });
  const weighting = h('input', {
    class: 'input',
    name: 'weighting',
    type: 'number',
    min: 0,
    max: 100,
    step: 'any',
    inputmode: 'decimal',
    value: values.weighting ?? '',
    placeholder: '%',
  });
  const estimate = h('input', {
    class: 'input',
    name: 'estimatedMinutes',
    type: 'number',
    min: 0.25,
    step: 0.25,
    inputmode: 'decimal',
    value: values.estimatedMinutes ? String(values.estimatedMinutes / 60) : '',
    placeholder: 'hours',
  });
  const description = textarea('description', values.description, {
    maxlength: 5000,
    placeholder: 'Requirements, brief summary…',
  });
  const notes = textarea('notes', values.notes, { maxlength: 5000 });
  const submissionUrl = h('input', {
    class: 'input',
    name: 'submissionUrl',
    type: 'url',
    value: values.submissionUrl ?? '',
    placeholder: 'https://',
    maxlength: 2048,
  });
  const tags = textInput('tags', values.tags.join(', '), { placeholder: 'Comma separated' });
  const submissionMethod = textInput('submissionMethod', values.submissionMethod, {
    maxlength: 200,
    placeholder: 'e.g. Moodle, Turnitin, in person',
  });
  const wordCount = textInput('wordCount', values.wordCount, {
    maxlength: 80,
    placeholder: 'e.g. 2,000 words',
  });
  const groupSize = textInput('groupSize', values.groupSize, {
    maxlength: 80,
    placeholder: 'e.g. 3–4 students',
  });
  const instructions = textarea('instructions', (values.instructions ?? []).join('\n'), {
    placeholder: 'One instruction per line',
  });
  const markingCriteria = textarea('markingCriteria', (values.markingCriteria ?? []).join('\n'), {
    placeholder: 'One criterion per line',
  });
  const relatedDates = relatedDatesEditor(values.relatedDates ?? []);
  const timeZone = select(
    'timeZone',
    listTimeZones().map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') })),
    values.timeZone,
  );
  const completed = h('input', {
    type: 'checkbox',
    name: 'completed',
    checked: values.completed === true,
  });

  const checklist = checklistEditor(values.checklist);
  checklist.input.id = uniqueId('f-checklist');
  const reminders = reminderEditor(values.reminderOffsets, settings.defaultReminderOffsets);

  const hasAdvancedValues = Boolean(
    values.moduleName ||
    values.moduleCode ||
    (values.weighting !== null && values.weighting !== undefined) ||
    values.description ||
    values.notes ||
    values.submissionUrl ||
    values.checklist.length ||
    values.tags.length ||
    values.reminderOffsets ||
    values.estimatedMinutes ||
    values.submissionMethod ||
    values.wordCount ||
    values.groupSize ||
    values.instructions?.length ||
    values.markingCriteria?.length ||
    values.relatedDates?.length,
  );

  const advanced = h(
    'details',
    { class: 'advanced', open: openAdvanced || (mode === 'edit' && hasAdvancedValues) },
    h(
      'summary',
      { class: 'advanced-summary' },
      icon('chevronDown', { size: 14 }),
      'Advanced options',
    ),
    h(
      'div',
      { class: 'advanced-body' },
      h(
        'div',
        { class: 'field-row' },
        field({ label: 'Module', name: 'moduleName', input: moduleName, optional: true }),
        field({
          label: 'Module code',
          name: 'moduleCode',
          input: moduleCode,
          optional: true,
          className: 'field-narrow',
        }),
      ),
      h(
        'div',
        { class: 'field-row' },
        field({ label: 'Weighting (%)', name: 'weighting', input: weighting, optional: true }),
        field({
          label: 'Estimated time (hours)',
          name: 'estimatedMinutes',
          input: estimate,
          optional: true,
        }),
      ),
      field({
        label: 'Description or requirements',
        name: 'description',
        input: description,
        optional: true,
      }),
      h(
        'div',
        { class: 'field', dataset: { field: 'checklist' } },
        h(
          'label',
          { class: 'field-label', for: checklist.input.id },
          'Deliverables checklist',
          h('span', { class: 'field-optional' }, 'optional'),
        ),
        checklist.element,
      ),
      field({
        label: 'Submission method',
        name: 'submissionMethod',
        input: submissionMethod,
        optional: true,
      }),
      h(
        'div',
        { class: 'field-row' },
        field({ label: 'Word count', name: 'wordCount', input: wordCount, optional: true }),
        field({ label: 'Group size', name: 'groupSize', input: groupSize, optional: true }),
      ),
      field({
        label: 'Important instructions',
        name: 'instructions',
        input: instructions,
        optional: true,
      }),
      field({
        label: 'Marking criteria',
        name: 'markingCriteria',
        input: markingCriteria,
        optional: true,
      }),
      h(
        'div',
        { class: 'field', dataset: { field: 'relatedDates' } },
        h(
          'span',
          { class: 'field-label' },
          'Other dates',
          h('span', { class: 'field-optional' }, 'optional'),
        ),
        relatedDates.element,
        h('p', { class: 'field-error', hidden: true }),
      ),
      field({ label: 'Notes', name: 'notes', input: notes, optional: true }),
      field({
        label: 'Submission link',
        name: 'submissionUrl',
        input: submissionUrl,
        optional: true,
      }),
      field({ label: 'Tags', name: 'tags', input: tags, optional: true }),
      h(
        'div',
        { class: 'field', dataset: { field: 'reminderOffsets' } },
        reminders.element,
        h('p', { class: 'field-error', hidden: true }),
      ),
      field({
        label: 'Time zone',
        name: 'timeZone',
        input: timeZone,
        hint: 'Date-only deadlines are due by the end of the day in this time zone.',
      }),
    ),
  );
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submitButton = h(
    'button',
    { type: 'submit', class: 'btn btn-primary' },
    mode === 'create' ? 'Add deadline' : 'Save changes',
  );

  const form = h(
    'form',
    { class: 'deadline-form', novalidate: true },
    formError,
    field({ label: 'Title', name: 'title', input: title }),
    h(
      'div',
      { class: 'field-row' },
      field({ label: 'Due date', name: 'dueDate', input: dueDate }),
      field({ label: 'Time', name: 'dueTime', input: dueTime, optional: true }),
    ),
    h(
      'div',
      { class: 'field-row' },
      h(
        'div',
        { class: 'field-stack' },
        field({ label: 'Category', name: 'category', input: category }),
        newCategoryRow,
      ),
      field({ label: 'Priority', name: 'priority', input: priority }),
    ),
    mode === 'edit'
      ? h('label', { class: 'checkbox-row' }, completed, h('span', null, 'Completed'))
      : null,
    advanced,
    h(
      'div',
      { class: 'form-actions' },
      h(
        'span',
        { class: 'form-shortcut' },
        h('kbd', null, 'Ctrl'),
        '+',
        h('kbd', null, 'Enter'),
        ' to save',
      ),
      h('button', { type: 'button', class: 'btn', on: { click: () => onCancel() } }, 'Cancel'),
      submitButton,
    ),
  );

  function showErrors(errors) {
    for (const node of form.querySelectorAll('.field')) {
      const error = node.querySelector(':scope > .field-error');
      const input = node.querySelector('.input, input');
      const message = errors[node.dataset.field];
      if (error) {
        error.hidden = !message;
        error.textContent = message ?? '';
      }
      if (input) {
        if (message) {
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-errormessage', error?.id ?? '');
        } else {
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-errormessage');
        }
      }
    }
    const advancedFields = [
      'moduleName',
      'moduleCode',
      'weighting',
      'estimatedMinutes',
      'description',
      'notes',
      'submissionUrl',
      'tags',
      'timeZone',
      'reminderOffsets',
      'submissionMethod',
      'wordCount',
      'groupSize',
      'instructions',
      'markingCriteria',
      'relatedDates',
    ];
    if (advancedFields.some((name) => errors[name])) advanced.open = true;
    formError.hidden = !errors.form;
    formError.textContent = errors.form ?? '';
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    firstInvalid?.focus();
  }

  function collect() {
    const hours = estimate.value.trim();
    return {
      title: title.value,
      dueDate: dueDate.value,
      dueTime: dueTime.value || null,
      category: category.value,
      priority: priority.value,
      moduleName: moduleName.value,
      moduleCode: moduleCode.value,
      weighting: weighting.value,
      estimatedMinutes: hours === '' ? null : Math.round(Number(hours) * 60),
      description: description.value,
      notes: notes.value,
      submissionUrl: submissionUrl.value,
      tags: tags.value,
      timeZone: timeZone.value,
      checklist: checklist.getItems(),
      reminderOffsets: reminders.getOffsets(),
      submissionMethod: submissionMethod.value,
      wordCount: wordCount.value,
      groupSize: groupSize.value,
      instructions: instructions.value,
      markingCriteria: markingCriteria.value,
      relatedDates: relatedDates.getItems(),
      ...(mode === 'edit' ? { completed: completed.checked } : {}),
    };
  }

  let busy = false;
  async function submit() {
    if (busy) return;
    // Browser "bad input" (e.g. a half-typed date) reports an empty value; catch it here.
    if (dueDate.validity.badInput) return showErrors({ dueDate: 'Enter a complete date.' });
    busy = true;
    submitButton.disabled = true;
    try {
      const result = await onSubmit(collect());
      if (!result.ok) showErrors(result.errors ?? { form: 'Could not save.' });
    } catch (error) {
      showErrors({ form: error?.message || 'Could not save.' });
    } finally {
      busy = false;
      submitButton.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  return { element: form, focus: () => title.focus() };
}
