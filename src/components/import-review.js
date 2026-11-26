/**
 * Review screen for one imported document.
 *
 * Shows what was extracted, with confidence and the original source line for each
 * value, and lets the user correct everything before anything is saved. Ambiguous
 * deadlines are never pre-selected: the user must pick one (or type their own).
 * For a file that matches an existing deadline, a comparison lets the user tick
 * exactly which changes to apply.
 */

import { CONFIDENCE_LABELS, DATE_LABEL_NAMES, confidenceCategory } from '../extraction/engine.js';
import { RELATED_DATE_LABELS } from '../models/assessment.js';
import { getCategories } from '../models/settings.js';
import { compareWithExtraction } from '../services/documents.js';
import { IMPORT_KIND_TEXT } from '../services/duplicates.js';
import { candidateToExtraction } from '../services/imports.js';
import { formatDate, formatTime } from '../utils/dates.js';
import { formatBytes, h, uniqueId } from '../utils/dom.js';
import { icon } from './icons.js';

const LONG_DATE = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };

export function confidenceChip(fieldValue, category = confidenceCategory(fieldValue)) {
  const iconName = category === 'high' ? 'check' : category === 'review' ? 'alert' : 'x';
  return h(
    'span',
    { class: `conf conf-${category}` },
    icon(iconName, { size: 11 }),
    CONFIDENCE_LABELS[category],
  );
}

/** Expandable "where did this come from" block. */
export function evidence(source, notes = []) {
  if (!source?.text) return null;
  return h(
    'details',
    { class: 'evidence' },
    h('summary', null, 'Source'),
    h('blockquote', null, source.text),
    h('p', { class: 'evidence-meta' }, [source.location, ...notes].filter(Boolean).join(' · ')),
  );
}

function dateText(date, time) {
  return `${formatDate(date, LONG_DATE)}${time ? ` · ${formatTime(time)}` : ''}`;
}

function inputRow(label, input, fieldValue, { name, hint } = {}) {
  const id = uniqueId('review');
  input.id = id;
  return h(
    'div',
    { class: 'field review-field', dataset: { field: name } },
    h(
      'div',
      { class: 'review-label-row' },
      h('label', { class: 'field-label', for: id }, label),
      fieldValue !== undefined ? confidenceChip(fieldValue) : null,
    ),
    input,
    hint ? h('p', { class: 'field-hint' }, hint) : null,
    fieldValue ? evidence(fieldValue.source, fieldValue.notes) : null,
    h('p', { class: 'field-error', hidden: true }),
  );
}

const text = (name, value) =>
  h('input', { class: 'input', type: 'text', name, value: value ?? '', autocomplete: 'off' });

/** Checkbox list of extracted items with editable text. */
function itemList(items, { checked = true, addLabel } = {}) {
  const list = h('ul', { class: 'review-items' });
  const rows = [];
  const addRow = (value, item, isChecked) => {
    const box = h('input', { type: 'checkbox', checked: isChecked, 'aria-label': 'Include' });
    const input = h('input', {
      class: 'input input-sm',
      type: 'text',
      value,
      'aria-label': 'Item text',
    });
    rows.push({ box, input });
    list.append(
      h(
        'li',
        null,
        box,
        h('div', { class: 'review-item-body' }, input, item ? evidence(item.source) : null),
      ),
    );
  };
  for (const item of items) addRow(item.value, item, checked);
  const add = addLabel
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-ghost',
          on: {
            click: () => {
              addRow('', null, true);
              rows.at(-1).input.focus();
            },
          },
        },
        icon('plus', { size: 13 }),
        addLabel,
      )
    : null;
  return {
    element: h('div', null, list, add),
    values: () =>
      rows
        .filter((row) => row.box.checked && row.input.value.trim())
        .map((row) => row.input.value.trim()),
  };
}

function section(title, content, { open = true, count } = {}) {
  return h(
    'details',
    { class: 'review-section', open },
    h(
      'summary',
      null,
      title,
      count !== undefined ? h('span', { class: 'segment-count' }, String(count)) : null,
    ),
    h('div', { class: 'review-section-body' }, content),
  );
}

/** Radio list of possible deadlines plus "enter another date". */
function deadlineChooser(candidate, dueTimeInput) {
  const name = uniqueId('deadline');
  const options = [];
  for (const item of candidate.deadlineCandidates) {
    if (item.value) {
      options.push({
        date: item.value,
        time: item.time,
        item,
        label: dateText(item.value, item.time),
      });
      for (const alternative of item.alternatives) {
        options.push({
          date: alternative.date,
          time: item.time,
          item,
          label: `${dateText(alternative.date, item.time)} — ${alternative.reason}`,
          alternative: true,
        });
      }
    } else {
      for (const suggestion of item.suggestions) {
        options.push({
          date: suggestion,
          time: item.time,
          item,
          suggested: true,
          label: `${dateText(suggestion, item.time)} — suggested`,
        });
      }
    }
  }
  // Only a single, unambiguous, high-confidence date is pre-selected.
  const preselect = !candidate.needsConfirmation && options.length > 0 ? 0 : -1;
  const customDate = h('input', {
    class: 'input',
    type: 'date',
    'aria-label': 'Due date',
    min: '1970-01-01',
    max: '2100-12-31',
  });
  let chosen = preselect >= 0 ? options[preselect] : null;

  const radios = options.map((option, index) => {
    const radio = h('input', {
      type: 'radio',
      name,
      value: String(index),
      checked: index === preselect,
    });
    radio.addEventListener('change', () => {
      chosen = option;
      customDate.disabled = true;
      if (option.time) dueTimeInput.value = option.time;
    });
    return h(
      'label',
      { class: ['choice', option.alternative || option.suggested ? 'choice-alt' : null] },
      radio,
      h(
        'div',
        { class: 'choice-body' },
        h(
          'div',
          { class: 'choice-head' },
          h('span', { class: 'choice-title' }, option.label),
          option.alternative || option.suggested
            ? confidenceChip(null, 'review')
            : confidenceChip(option.item),
        ),
        option.item.matchedText
          ? h('p', { class: 'choice-note' }, `Written as “${option.item.matchedText}”`)
          : null,
        evidence(option.item.source, option.item.notes),
      ),
    );
  });
  const customRadio = h('input', {
    type: 'radio',
    name,
    value: 'custom',
    checked: options.length === 0,
  });
  customRadio.addEventListener('change', () => {
    chosen = null;
    customDate.disabled = false;
    customDate.focus();
  });
  customDate.disabled = options.length > 0;
  if (options.length === 0) chosen = null;

  const message =
    options.length === 0
      ? 'No submission deadline was found. Enter it yourself.'
      : preselect >= 0
        ? 'One clear deadline was found.'
        : 'Choose the correct deadline. Nothing is selected because the document is ambiguous.';

  const element = h(
    'fieldset',
    { class: 'fieldset review-field', dataset: { field: 'dueDate' } },
    h('legend', { class: 'field-label' }, 'Submission deadline'),
    h('p', { class: 'field-hint' }, message),
    h('div', { class: 'choices', role: 'radiogroup' }, radios),
    h(
      'label',
      { class: 'choice' },
      customRadio,
      h(
        'div',
        { class: 'choice-body' },
        h('span', { class: 'choice-title' }, 'Enter another date'),
        customDate,
      ),
    ),
    h('p', { class: 'field-error', hidden: true }),
  );
  return {
    element,
    value: () => {
      if (customRadio.checked) return { date: customDate.value, item: null };
      return chosen ? { date: chosen.date, item: chosen.item } : { date: '', item: null };
    },
  };
}

function relatedDatesChooser(candidate) {
  const rows = [];
  const durationNote = candidate.presentation.duration?.value ?? null;
  const dates = [
    ...candidate.presentation.dates.map((item) => ({
      item,
      checked: Boolean(item.value),
      note: durationNote,
    })),
    ...candidate.otherDates.map((item) => ({
      item,
      checked: item.label === 'exam' && Boolean(item.value),
      note: null,
    })),
  ];
  const list = h(
    'ul',
    { class: 'review-items' },
    dates.map(({ item, checked, note }) => {
      const usable = Boolean(item.value);
      const box = h('input', {
        type: 'checkbox',
        checked,
        disabled: !usable,
        'aria-label': 'Keep this date',
      });
      rows.push({ box, item, note });
      return h(
        'li',
        null,
        box,
        h(
          'div',
          { class: 'review-item-body' },
          h(
            'div',
            { class: 'choice-head' },
            h(
              'span',
              { class: 'choice-title' },
              `${DATE_LABEL_NAMES[item.label] ?? 'Date'} · ${usable ? dateText(item.value, item.time) : `${item.matchedText} (incomplete)`}`,
            ),
            confidenceChip(item),
          ),
          note ? h('p', { class: 'choice-note' }, `Duration: ${note}`) : null,
          evidence(item.source, item.notes),
        ),
      );
    }),
  );
  return {
    count: dates.length,
    element: list,
    values: () =>
      rows
        .filter((row) => row.box.checked && row.item.value)
        .map((row) => ({
          label: Object.hasOwn(RELATED_DATE_LABELS, row.item.label) ? row.item.label : 'other',
          date: row.item.value,
          time: row.item.time,
          note: row.note,
        })),
  };
}

/** Form for creating a new deadline from a candidate. */
function newDeadlineForm(candidate, settings) {
  const title = text('title', candidate.title?.value);
  const moduleName = text('moduleName', candidate.moduleName?.value);
  const moduleCode = text('moduleCode', candidate.moduleCode?.value);
  const category = h(
    'select',
    { class: 'input select', name: 'category' },
    getCategories(settings).map((item) =>
      h(
        'option',
        {
          value: item.id,
          selected: item.id === (candidate.assessmentType?.value ?? settings.defaultCategory),
        },
        item.label,
      ),
    ),
  );
  const dueTime = h('input', {
    class: 'input',
    type: 'time',
    name: 'dueTime',
    value: candidate.submissionTime?.value ?? '',
  });
  const deadline = deadlineChooser(candidate, dueTime);
  const weighting = h('input', {
    class: 'input',
    type: 'number',
    name: 'weighting',
    min: 0,
    max: 100,
    step: 'any',
    value: candidate.weighting?.value ?? '',
  });
  const method = text('submissionMethod', candidate.submissionMethod?.value);
  const wordCount = text('wordCount', candidate.wordCount?.value);
  const groupSize = text('groupSize', candidate.groupSize?.value);
  const notes = h('textarea', {
    class: 'input textarea',
    name: 'notes',
    rows: 2,
    placeholder: 'Your own notes (optional)',
  });
  const deliverables = itemList(candidate.deliverables, { addLabel: 'Add deliverable' });
  const instructions = itemList(candidate.instructions);
  const criteria = itemList(candidate.markingCriteria);
  const related = relatedDatesChooser(candidate);

  const weightHint = candidate.weighting?.alternatives?.length
    ? `Percentages found: ${candidate.weighting.alternatives.map((value) => `${value}%`).join(', ')}`
    : undefined;

  const element = h(
    'div',
    { class: 'review-form' },
    inputRow('Title', title, candidate.title, { name: 'title' }),
    h(
      'div',
      { class: 'field-row' },
      inputRow('Module', moduleName, candidate.moduleName, { name: 'moduleName' }),
      inputRow('Module code', moduleCode, candidate.moduleCode, { name: 'moduleCode' }),
    ),
    h(
      'div',
      { class: 'field-row' },
      inputRow('Category', category, candidate.assessmentType, { name: 'category' }),
      inputRow('Weighting (%)', weighting, candidate.weighting, {
        name: 'weighting',
        hint: weightHint,
      }),
    ),
    deadline.element,
    inputRow('Submission time', dueTime, candidate.submissionTime, {
      name: 'dueTime',
      hint: 'Leave empty if the deadline is the end of the day.',
    }),
    section(
      'Submission requirements',
      [
        inputRow('Submission method', method, candidate.submissionMethod, {
          name: 'submissionMethod',
        }),
        h(
          'div',
          { class: 'field-row' },
          inputRow('Word count', wordCount, candidate.wordCount, { name: 'wordCount' }),
          inputRow('Group size', groupSize, candidate.groupSize, { name: 'groupSize' }),
        ),
      ],
      { open: Boolean(candidate.submissionMethod || candidate.wordCount || candidate.groupSize) },
    ),
    section('Deliverables', deliverables.element, {
      count: candidate.deliverables.length,
      open: candidate.deliverables.length > 0,
    }),
    section('Important instructions', instructions.element, {
      count: candidate.instructions.length,
      open: false,
    }),
    section('Marking criteria', criteria.element, {
      count: candidate.markingCriteria.length,
      open: false,
    }),
    related.count
      ? section('Other dates in this brief', related.element, { count: related.count, open: false })
      : null,
    inputRow('Notes', notes, undefined, { name: 'notes' }),
  );

  return {
    element,
    collect() {
      const chosen = deadline.value();
      return {
        deadline: chosen.item,
        values: {
          title: title.value,
          dueDate: chosen.date,
          dueTime: dueTime.value || null,
          timeZone: settings.timeZone,
          category: category.value,
          priority: settings.defaultPriority,
          moduleName: moduleName.value,
          moduleCode: moduleCode.value,
          weighting: weighting.value,
          submissionMethod: method.value,
          wordCount: wordCount.value,
          groupSize: groupSize.value,
          notes: notes.value,
          checklist: deliverables.values().map((value) => ({ text: value })),
          instructions: instructions.values(),
          markingCriteria: criteria.values(),
          relatedDates: related.values(),
        },
      };
    },
    showErrors(errors) {
      for (const node of element.querySelectorAll('[data-field]')) {
        const message = errors[node.dataset.field];
        const error = node.querySelector(':scope > .field-error');
        if (!error) continue;
        error.hidden = !message;
        error.textContent = message ?? '';
      }
      element
        .querySelector('.field-error:not([hidden])')
        ?.closest('[data-field]')
        ?.scrollIntoView({ block: 'center' });
    },
  };
}

function displayValue(value) {
  if (Array.isArray(value)) return value.length ? value.join('; ') : '—';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/** Comparison of an existing deadline with the new document. */
function updateForm(candidate, target, sourceType) {
  const extraction = candidateToExtraction(candidate, sourceType);
  const differences = compareWithExtraction(target, extraction);
  const boxes = [];
  const rows = differences.map((difference) => {
    const box = h('input', {
      type: 'checkbox',
      checked: difference.selectedByDefault,
      'aria-label': `Apply ${difference.label}`,
    });
    boxes.push({ box, field: difference.field });
    return h(
      'tr',
      null,
      h('td', null, box),
      h(
        'th',
        { scope: 'row' },
        difference.label,
        difference.confirmed
          ? h('span', { class: 'badge badge-accent' }, 'You entered this')
          : null,
      ),
      h('td', { class: 'compare-old' }, displayValue(difference.current)),
      h(
        'td',
        { class: 'compare-new' },
        displayValue(difference.proposed),
        difference.sourceText
          ? h(
              'details',
              { class: 'evidence' },
              h('summary', null, 'Source'),
              h('blockquote', null, difference.sourceText),
            )
          : null,
      ),
    );
  });
  const ambiguous =
    candidate.deadlineCandidates.length > 1 ||
    (candidate.submissionDeadline && !candidate.submissionDeadline.value);
  const element = h(
    'div',
    { class: 'review-form' },
    h(
      'p',
      { class: 'field-hint' },
      `Compared with your deadline “${target.title}”. Ticked changes will be applied; everything else, including your notes, progress and reminders, stays as it is.`,
    ),
    ambiguous
      ? h(
          'p',
          { class: 'notice notice-warning' },
          icon('alert', { size: 14 }),
          'This document lists an unclear deadline, so the due date is not offered as a change. Edit it yourself if needed.',
        )
      : null,
    differences.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'compare' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, h('span', { class: 'sr-only' }, 'Apply')),
                h('th', null, 'Field'),
                h('th', null, 'Current'),
                h('th', null, 'In this document'),
              ),
            ),
            h('tbody', null, rows),
          ),
        )
      : h(
          'p',
          { class: 'muted' },
          'No differences found. Saving links this document to the deadline.',
        ),
  );
  return {
    element,
    collect: () => ({
      assessmentId: target.id,
      extraction,
      candidate,
      selectedFields: boxes.filter((row) => row.box.checked).map((row) => row.field),
    }),
  };
}

/**
 * @param {object} options
 * @param {object} options.item import queue item: { file, result, classification, attachTo }
 * @param {object} options.app page context (services/app.js)
 * @param {(payload: object) => Promise<object>} options.onSave
 * @param {() => void} options.onDiscard
 */
export function createReviewPanel({ item, app, onSave, onDiscard }) {
  const { result, classification } = item;
  const settings = app.getSettings();
  const assessments = app.getState().assessments;
  const candidates = result.extraction.assessments;
  const duplicateFile = classification.kind === 'identical' || classification.kind === 'renamed';

  const states = candidates.map((candidate, index) => {
    const match = classification.matches?.[index];
    const attachTarget = item.attachTo && index === 0 ? item.attachTo : null;
    const targetId = attachTarget ?? (match?.kind === 'update' ? match.assessmentId : null);
    return {
      candidate,
      match,
      mode: duplicateFile ? 'skip' : targetId ? 'update' : 'new',
      targetId: targetId ?? match?.assessmentId ?? null,
      form: null,
      container: h('section', { class: 'candidate' }),
    };
  });

  function renderCandidate(state, index) {
    const { candidate } = state;
    const target = assessments.find((assessment) => assessment.id === state.targetId) ?? null;
    const heading = h(
      'div',
      { class: 'candidate-head' },
      h(
        'h3',
        null,
        candidates.length > 1 ? `Assessment ${index + 1} of ${candidates.length}` : 'Assessment',
      ),
      h('span', { class: 'candidate-title muted' }, candidate.title?.value ?? ''),
    );
    const switches = [];
    if (state.mode !== 'skip' && target) {
      switches.push(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            on: {
              click: () => {
                state.mode = state.mode === 'update' ? 'new' : 'update';
                renderCandidate(state, index);
              },
            },
          },
          state.mode === 'update'
            ? 'Create as a new deadline instead'
            : `Update “${target.title}” instead`,
        ),
      );
    }
    switches.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-ghost',
          on: {
            click: () => {
              state.mode =
                state.mode === 'skip'
                  ? target && state.match?.kind === 'update'
                    ? 'update'
                    : 'new'
                  : 'skip';
              renderCandidate(state, index);
            },
          },
        },
        state.mode === 'skip' ? 'Include' : 'Don’t import this one',
      ),
    );

    let body;
    if (state.mode === 'skip') {
      state.form = null;
      body = h('p', { class: 'muted' }, 'This assessment will not be imported.');
    } else if (state.mode === 'update' && target) {
      state.form = updateForm(candidate, target, result.sourceType);
      body = state.form.element;
    } else {
      state.form = newDeadlineForm(candidate, settings);
      body = state.form.element;
    }
    const matchNote =
      state.match && state.mode === 'new'
        ? h(
            'p',
            { class: 'notice' },
            icon('alert', { size: 14 }),
            `Similar to “${state.match.title}” (${state.match.reasons.join(', ')}).`,
          )
        : null;
    state.container.replaceChildren(
      ...[
        heading,
        candidate.warnings.length && state.mode === 'new'
          ? h(
              'ul',
              { class: 'warning-list' },
              candidate.warnings.map((warning) => h('li', null, warning)),
            )
          : null,
        matchNote,
        body,
        h('div', { class: 'candidate-actions' }, switches),
      ].filter(Boolean),
    );
    state.container.classList.toggle('is-skipped', state.mode === 'skip');
    updateSaveLabel();
  }

  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const saveButton = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const keepOnly = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Keep document only');

  function updateSaveLabel() {
    const count = states.filter((state) => state.mode !== 'skip').length;
    saveButton.textContent =
      count === 0
        ? 'Nothing to save'
        : `Confirm and save ${count} ${count === 1 ? 'deadline' : 'deadlines'}`;
    saveButton.disabled = count === 0;
  }

  saveButton.addEventListener('click', async () => {
    formError.hidden = true;
    const create = [];
    const createStates = [];
    const update = [];
    for (const state of states) {
      if (state.mode === 'skip' || !state.form) continue;
      if (state.mode === 'update') update.push(state.form.collect());
      else {
        const draft = state.form.collect();
        create.push({ ...draft, candidate: state.candidate });
        createStates.push(state);
      }
    }
    saveButton.disabled = true;
    try {
      const outcome = await onSave({ create, update });
      if (!outcome.ok) {
        for (const error of outcome.errors) {
          if (error.index >= 0) createStates[error.index].form.showErrors(error.errors);
          else {
            formError.textContent = Object.values(error.errors)[0];
            formError.hidden = false;
          }
        }
        if (outcome.errors.some((error) => error.index >= 0)) {
          formError.textContent =
            'Some details need fixing before saving (see the highlighted fields).';
          formError.hidden = false;
        }
      }
    } catch (error) {
      formError.textContent = error?.message ?? 'Could not save.';
      formError.hidden = false;
    } finally {
      updateSaveLabel();
    }
  });
  keepOnly.addEventListener('click', async () => {
    keepOnly.disabled = true;
    await onSave({ create: [], update: [], keepDocumentOnly: true });
    keepOnly.disabled = false;
  });

  const stats = result.stats;
  const facts = [
    result.sourceType === 'pdf'
      ? `${stats.pageCount} ${stats.pageCount === 1 ? 'page' : 'pages'}`
      : `${stats.paragraphCount} paragraphs`,
    formatBytes(result.size),
    `read in ${stats.durationMs < 1000 ? `${stats.durationMs} ms` : `${(stats.durationMs / 1000).toFixed(1)} s`}`,
  ];
  const warnings = [...result.warnings, ...result.extraction.warnings];

  const duplicateBanner = duplicateFile
    ? h(
        'div',
        { class: 'notice notice-info' },
        icon('file', { size: 14 }),
        h(
          'div',
          null,
          h(
            'p',
            null,
            h('strong', null, IMPORT_KIND_TEXT[classification.kind]),
            classification.kind === 'renamed' ? ` (as “${classification.document.fileName}”)` : '',
            `. First imported ${new Date(classification.document.importedAt).toLocaleDateString()}.`,
          ),
          classification.assessments.length
            ? h(
                'p',
                null,
                `Linked to: ${classification.assessments.map((assessment) => assessment.title).join(', ')}.`,
              )
            : null,
          h(
            'p',
            { class: 'muted' },
            'Nothing will be duplicated. Use “Include” below only if you really want another copy.',
          ),
        ),
      )
    : classification.kind === 'update'
      ? h(
          'div',
          { class: 'notice notice-info' },
          icon('undo', { size: 14 }),
          h(
            'p',
            null,
            h('strong', null, IMPORT_KIND_TEXT.update),
            '. Review the changes below; nothing changes until you save.',
          ),
        )
      : null;

  const panel = h(
    'div',
    { class: 'review' },
    h(
      'header',
      { class: 'review-header' },
      h(
        'div',
        { class: 'review-file' },
        h(
          'span',
          { class: `file-badge file-${result.sourceType}` },
          result.sourceType.toUpperCase(),
        ),
        h('h2', null, result.fileName),
      ),
      h('p', { class: 'muted' }, facts.join(' · ')),
    ),
    duplicateBanner,
    warnings.length
      ? h(
          'details',
          { class: 'review-warnings', open: warnings.length <= 3 },
          h(
            'summary',
            null,
            icon('alert', { size: 14 }),
            `${warnings.length} ${warnings.length === 1 ? 'note' : 'notes'} about this document`,
          ),
          h(
            'ul',
            { class: 'warning-list' },
            warnings.map((warning) => h('li', null, warning)),
          ),
        )
      : null,
    states.map((state) => state.container),
    formError,
    h(
      'footer',
      { class: 'review-footer' },
      h('button', { type: 'button', class: 'btn', on: { click: () => onDiscard() } }, 'Discard'),
      duplicateFile || stats.scanned ? keepOnly : null,
      saveButton,
    ),
  );
  states.forEach(renderCandidate);
  return panel;
}
