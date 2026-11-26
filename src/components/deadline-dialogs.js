/**
 * Dialog flows shared by the popup and dashboard: add/edit, details, delete with
 * undo, completion with undo. `app` is the small context object created in
 * services/app.js.
 */

import { categoryLabel, slugifyCategory, getCategories } from '../models/settings.js';
import { RELATED_DATE_LABELS, moduleLabel } from '../models/assessment.js';
import { getDeadlineState } from '../services/query.js';
import { computeReminders, describeOffset, effectiveOffsets } from '../services/reminders.js';
import { formatDate, formatInstant, formatTime } from '../utils/dates.js';
import { formatBytes, h } from '../utils/dom.js';
import { dueBadge, priorityIndicator } from './assessment-card.js';
import { createDeadlineForm } from './deadline-form.js';
import { confirmDialog, openDialog } from './dialog.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

export async function addCategory(app, label) {
  const settings = app.getSettings();
  const id = slugifyCategory(label);
  if (!id) return null;
  const existing = getCategories(settings).find((category) => category.id === id);
  if (existing) return existing;
  const category = { id, label: label.trim().slice(0, 40) };
  await app.storage.saveSettings({
    ...settings,
    customCategories: [...settings.customCategories, category],
  });
  return category;
}

/**
 * Add or edit a deadline.
 * @param {object} options
 * @param {object} [options.assessment] edit this record; omit to create
 * @param {object} [options.initial] prefilled values for a new deadline
 * @param {'manual'|'import'} [options.tab] which create tab opens first
 */
export function openDeadlineEditor(
  app,
  { assessment, initial, tab = 'manual', openAdvanced = false } = {},
) {
  const mode = assessment ? 'edit' : 'create';
  const panel = h('div', { class: 'editor-panel' });

  function showManual(values = initial, focus = true) {
    const form = createDeadlineForm({
      mode,
      initial: assessment ?? values ?? {},
      settings: app.getSettings(),
      openAdvanced,
      onAddCategory: (label) => addCategory(app, label),
      onCancel: () => handle.close(),
      onSubmit: async (value) => {
        const result = assessment
          ? await app.service.update(assessment.id, value)
          : await app.service.create(value);
        if (result.ok) {
          handle.close();
          showToast(assessment ? 'Changes saved' : `Added “${result.assessment.title}”`, {
            tone: 'success',
          });
        }
        return result;
      },
    });
    panel.replaceChildren(form.element);
    if (focus) form.focus();
  }

  // Documents are processed on the import page, in their own tab, so a long import
  // never depends on the popup staying open.
  function showImport() {
    panel.replaceChildren(
      h(
        'div',
        { class: 'import-panel' },
        h(
          'div',
          { class: 'notice' },
          h(
            'p',
            null,
            'Import PDF or Word assessment briefs. Each file is read on this device, the deadline and details are found for you, and you confirm everything before it is saved.',
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            on: {
              click: () => {
                handle.close();
                app.openImportPage();
                if (app.isExtension && document.body.classList.contains('popup')) window.close();
              },
            },
          },
          icon('upload', { size: 15 }),
          'Open the import page',
        ),
      ),
    );
  }

  const tabs = [
    { id: 'manual', label: 'Add manually', icon: 'edit' },
    { id: 'import', label: 'Import document', icon: 'upload' },
  ];
  const tabButtons = tabs.map((item) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'segment',
        dataset: { tab: item.id },
        on: { click: () => selectTab(item.id) },
      },
      icon(item.icon, { size: 14 }),
      item.label,
    ),
  );
  const tabList = h(
    'div',
    { class: 'segmented', role: 'tablist', 'aria-label': 'How to add' },
    tabButtons,
  );
  tabList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabButtons.indexOf(document.activeElement);
    const next =
      tabButtons[
        (index + (event.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length
      ];
    next.focus();
    selectTab(next.dataset.tab);
  });

  function selectTab(id) {
    for (const button of tabButtons) {
      const selected = button.dataset.tab === id;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (id === 'manual') showManual();
    else showImport();
  }

  const handle = openDialog({
    title: assessment ? 'Edit deadline' : 'New deadline',
    body: [mode === 'create' ? tabList : null, panel],
    size: 'md',
  });
  if (mode === 'create') {
    selectTab(tab);
    if (tab === 'import') tabButtons[1].focus();
  } else showManual();
  return handle;
}

export async function toggleComplete(app, assessment) {
  const completed = !assessment.completed;
  const result = await app.service.setCompleted(assessment.id, completed);
  if (!result.ok) return showToast(result.errors?.form ?? 'Could not update.', { tone: 'danger' });
  showToast(completed ? `Marked “${assessment.title}” as done` : `Restored “${assessment.title}”`, {
    action: { label: 'Undo', onClick: () => app.service.setCompleted(assessment.id, !completed) },
  });
  return result;
}

export async function deleteWithUndo(app, assessment) {
  const confirmed = await confirmDialog({
    title: 'Delete deadline?',
    message: `“${assessment.title}” and its notes, checklist and reminders will be removed.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return false;
  const removed = await app.service.remove(assessment.id);
  if (removed) {
    showToast(`Deleted “${removed.title}”`, {
      action: { label: 'Undo', onClick: () => app.service.restore(removed) },
      duration: 7000,
    });
  }
  return Boolean(removed);
}

function fact(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return h('div', { class: 'fact' }, h('dt', null, label), h('dd', null, value));
}

const SOURCE_LABELS = {
  manual: 'Added manually',
  pdf: 'Imported from PDF',
  docx: 'Imported from Word',
};

function renderDetails(app, stored, handle) {
  // Records written by an older version may lack the Stage 2 list fields.
  const assessment = {
    ...stored,
    instructions: stored.instructions ?? [],
    markingCriteria: stored.markingCriteria ?? [],
    relatedDates: stored.relatedDates ?? [],
  };
  const settings = app.getSettings();
  const now = app.now();
  const state = getDeadlineState(assessment, { now, dueSoonDays: settings.dueSoonDays });
  const timeZoneNote = assessment.timeZone !== settings.timeZone ? ` (${assessment.timeZone})` : '';
  const due = `${formatDate(assessment.dueDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${
    assessment.dueTime ? ` at ${formatTime(assessment.dueTime)}` : ''
  }${timeZoneNote}`;

  const reminders = computeReminders([assessment], settings, Number(now));
  const offsets = effectiveOffsets(assessment, settings);

  // A simple editable checklist: tick, remove, or add a deliverable in place.
  const newItem = h('input', {
    class: 'input input-sm',
    type: 'text',
    maxlength: 300,
    placeholder: 'Add a deliverable',
    'aria-label': 'New checklist item',
  });
  const addItem = () => {
    const text = newItem.value.trim();
    if (!text) return;
    app.service.update(assessment.id, {
      checklist: [...assessment.checklist, { text, done: false }],
    });
  };
  newItem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addItem();
    }
  });
  const checklist = h(
    'div',
    { class: 'checklist-field' },
    h(
      'ul',
      { class: 'checklist' },
      assessment.checklist.map((item) =>
        h(
          'li',
          { class: 'checklist-row' },
          h(
            'label',
            { class: 'checkbox-row' },
            h('input', {
              type: 'checkbox',
              checked: item.done,
              on: { change: () => app.service.toggleChecklistItem(assessment.id, item.id) },
            }),
            h('span', { class: item.done ? 'is-done' : '' }, item.text),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button icon-button-sm',
              'aria-label': `Remove “${item.text}”`,
              on: {
                click: () =>
                  app.service.update(assessment.id, {
                    checklist: assessment.checklist.filter((other) => other.id !== item.id),
                  }),
              },
            },
            icon('x', { size: 13 }),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'inline-row' },
      newItem,
      h('button', { type: 'button', class: 'btn btn-sm', on: { click: addItem } }, 'Add'),
    ),
  );

  const record = assessment.sourceDocument
    ? (app.getState().documents ?? []).find((item) => item.id === assessment.sourceDocument.id)
    : null;
  const evidence = record
    ? record.evidence.filter((item) => item.assessmentId === assessment.id)
    : [];
  const requirements = [
    fact('Submission method', assessment.submissionMethod),
    fact('Word count', assessment.wordCount),
    fact('Group size', assessment.groupSize),
  ].filter(Boolean);

  const section = (title, ...content) =>
    h('section', { class: 'detail-section' }, h('h3', { class: 'detail-heading' }, title), content);

  return h(
    'div',
    { class: 'details' },
    h(
      'div',
      { class: 'details-top' },
      dueBadge(state),
      priorityIndicator(assessment.priority, { showLabel: true }),
      assessment.completed ? h('span', { class: 'badge badge-success' }, 'Completed') : null,
    ),
    h(
      'div',
      { class: 'details-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          on: { click: () => toggleComplete(app, assessment) },
        },
        icon(assessment.completed ? 'undo' : 'check', { size: 14 }),
        assessment.completed ? 'Restore' : 'Mark as done',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm',
          on: {
            click: () => {
              handle.close();
              openDeadlineEditor(app, { assessment });
            },
          },
        },
        icon('edit', { size: 14 }),
        'Edit',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm',
          'aria-pressed': String(assessment.pinned === true),
          on: { click: () => app.service.togglePinned(assessment.id) },
        },
        icon('pin', { size: 14 }),
        assessment.pinned ? 'Unpin' : 'Pin',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-ghost-danger',
          on: {
            click: async () => {
              if (await deleteWithUndo(app, assessment)) handle.close();
            },
          },
        },
        icon('trash', { size: 14 }),
        'Delete',
      ),
    ),
    h(
      'dl',
      { class: 'facts' },
      fact('Due', due),
      fact('Module', moduleLabel(assessment)),
      fact('Category', categoryLabel(assessment.category, settings)),
      fact('Weighting', assessment.weighting !== null ? `${assessment.weighting}%` : null),
      fact(
        'Estimated time',
        assessment.estimatedMinutes
          ? `${Math.round((assessment.estimatedMinutes / 60) * 100) / 100} hours`
          : null,
      ),
      fact(
        'Tags',
        assessment.tags.length ? assessment.tags.map((tag) => `#${tag}`).join(' ') : null,
      ),
      fact(
        'Submission',
        assessment.submissionUrl
          ? h(
              'a',
              {
                href: assessment.submissionUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'link',
              },
              icon('link', { size: 13 }),
              new URL(assessment.submissionUrl).host,
            )
          : null,
      ),
      fact('Source', SOURCE_LABELS[assessment.sourceType]),
    ),
    assessment.description
      ? section('Description', h('p', { class: 'prose' }, assessment.description))
      : null,
    requirements.length
      ? section('Submission requirements', h('dl', { class: 'facts' }, requirements))
      : null,
    section(
      assessment.checklist.length
        ? `Deliverables · ${assessment.checklist.filter((item) => item.done).length}/${assessment.checklist.length} done`
        : 'Deliverables',
      checklist,
    ),
    assessment.instructions.length
      ? section(
          'Important instructions',
          h(
            'ul',
            { class: 'plain-list' },
            assessment.instructions.map((item) => h('li', null, item)),
          ),
        )
      : null,
    assessment.markingCriteria.length
      ? section(
          'Marking criteria',
          h(
            'details',
            null,
            h('summary', { class: 'link' }, `Show ${assessment.markingCriteria.length} criteria`),
            h(
              'ul',
              { class: 'plain-list' },
              assessment.markingCriteria.map((item) => h('li', null, item)),
            ),
          ),
        )
      : null,
    assessment.relatedDates.length
      ? section(
          'Other dates',
          h(
            'ul',
            { class: 'related-list' },
            assessment.relatedDates.map((item) =>
              h(
                'li',
                null,
                h('strong', null, RELATED_DATE_LABELS[item.label]),
                h(
                  'span',
                  null,
                  `${formatDate(item.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${item.time ? ` · ${formatTime(item.time)}` : ''}`,
                ),
                item.note ? h('span', { class: 'muted' }, item.note) : null,
              ),
            ),
          ),
        )
      : null,
    assessment.notes ? section('Notes', h('p', { class: 'prose' }, assessment.notes)) : null,
    section(
      'Reminders',
      !settings.notificationsEnabled
        ? h('p', { class: 'muted' }, 'Notifications are turned off in settings.')
        : offsets.length === 0
          ? h('p', { class: 'muted' }, 'No reminders for this deadline.')
          : h(
              'ul',
              { class: 'reminder-list' },
              offsets.map((offset) => {
                const scheduled = reminders.find((reminder) => reminder.offset === offset);
                return h(
                  'li',
                  { class: scheduled ? '' : 'is-past' },
                  icon('bell', { size: 13 }),
                  h('span', null, describeOffset(offset)),
                  h(
                    'span',
                    { class: 'muted' },
                    scheduled
                      ? formatInstant(scheduled.when, assessment.timeZone)
                      : assessment.completed
                        ? 'Off (completed)'
                        : 'Passed',
                  ),
                );
              }),
            ),
    ),
    section(
      'Source document',
      assessment.sourceDocument
        ? h(
            'div',
            { class: 'attached-doc' },
            icon('file', { size: 14 }),
            h(
              'span',
              null,
              `${assessment.sourceDocument.name} · ${formatBytes(assessment.sourceDocument.size)}`,
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-ghost',
                on: { click: () => app.service.detachDocument(assessment.id) },
              },
              'Unlink',
            ),
          )
        : h('p', { class: 'muted' }, 'No document is linked to this deadline.'),
      evidence.length
        ? h(
            'details',
            null,
            h('summary', { class: 'link' }, `Show extracted evidence (${evidence.length})`),
            h(
              'ul',
              { class: 'evidence-list' },
              evidence.map((item) =>
                h(
                  'li',
                  null,
                  h('strong', null, `${item.label}${item.value ? `: ${item.value}` : ''}`),
                  h('blockquote', null, item.text),
                  item.location ? h('span', { class: 'muted' }, item.location) : null,
                ),
              ),
            ),
          )
        : assessment.sourceDocument && !record
          ? h(
              'p',
              { class: 'field-hint' },
              'The document information was deleted from the library, so no evidence is available.',
            )
          : null,
      h(
        'div',
        { class: 'inline-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            on: {
              click: () => {
                handle.close();
                app.openImportPage(`#attach=${encodeURIComponent(assessment.id)}`);
              },
            },
          },
          icon('upload', { size: 14 }),
          assessment.sourceDocument
            ? 'Import an updated brief'
            : 'Import a brief for this deadline',
        ),
      ),
      h(
        'p',
        { class: 'field-hint' },
        'Changes found in a brief are shown for you to approve. Your own entries, notes and progress are never replaced without asking.',
      ),
    ),
    h(
      'p',
      { class: 'details-meta' },
      `Created ${new Date(assessment.createdAt).toLocaleString()} · Updated ${new Date(assessment.updatedAt).toLocaleString()}`,
    ),
  );
}

/** Details dialog. It re-renders itself when the record changes in storage. */
export function openDeadlineDetails(app, id) {
  const assessment = app.getAssessment(id);
  if (!assessment) return null;
  const handle = openDialog({ title: assessment.title, size: 'md' });
  const render = () => {
    const current = app.getAssessment(id);
    if (!current) return handle.close();
    handle.setTitle(current.title);
    handle.body.replaceChildren(renderDetails(app, current, handle));
  };
  render();
  const unsubscribe = app.onChange(render);
  handle.dialog.addEventListener('close', unsubscribe);
  return handle;
}
