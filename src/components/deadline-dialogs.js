/**
 * Dialog flows shared by the popup and dashboard: add/edit, details, delete with
 * undo, completion with undo. `app` is the small context object created in
 * services/app.js.
 */

import { categoryLabel, slugifyCategory, getCategories } from '../models/settings.js';
import { moduleLabel } from '../models/assessment.js';
import { getDeadlineState } from '../services/query.js';
import { computeReminders, describeOffset, effectiveOffsets } from '../services/reminders.js';
import { formatDate, formatInstant, formatTime } from '../utils/dates.js';
import { formatBytes, h } from '../utils/dom.js';
import { dueBadge, priorityIndicator } from './assessment-card.js';
import { createDeadlineForm } from './deadline-form.js';
import { confirmDialog, openDialog } from './dialog.js';
import { icon } from './icons.js';
import { checkDocument, createImportPanel, documentPicker } from './import-panel.js';
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
  { assessment, initial, tab = 'manual', documentRef = null, openAdvanced = false } = {},
) {
  const mode = assessment ? 'edit' : 'create';
  let linkedDocument = documentRef;
  const panel = h('div', { class: 'editor-panel' });

  function showManual(values = initial, focus = true) {
    const form = createDeadlineForm({
      mode,
      initial: assessment ?? values ?? {},
      settings: app.getSettings(),
      document: linkedDocument,
      openAdvanced,
      onAddCategory: (label) => addCategory(app, label),
      onCancel: () => handle.close(),
      onSubmit: async (value) => {
        const result = assessment
          ? await app.service.update(assessment.id, value)
          : await app.service.create({ ...value, sourceDocument: linkedDocument });
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

  function showImport() {
    panel.replaceChildren(
      createImportPanel({
        onContinueManually: (doc) => {
          linkedDocument = doc;
          selectTab('manual');
        },
      }),
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

function renderDetails(app, assessment, handle) {
  const settings = app.getSettings();
  const now = app.now();
  const state = getDeadlineState(assessment, { now, dueSoonDays: settings.dueSoonDays });
  const timeZoneNote = assessment.timeZone !== settings.timeZone ? ` (${assessment.timeZone})` : '';
  const due = `${formatDate(assessment.dueDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${
    assessment.dueTime ? ` at ${formatTime(assessment.dueTime)}` : ''
  }${timeZoneNote}`;

  const reminders = computeReminders([assessment], settings, Number(now));
  const offsets = effectiveOffsets(assessment, settings);

  const picker = documentPicker(async (file) => {
    const result = await checkDocument(file);
    if (!result.ok) return showToast(result.error, { tone: 'danger' });
    await app.service.attachDocument(assessment.id, result.document);
    showToast('Document linked. Extraction will be available in a later update.');
  });

  const checklist = assessment.checklist.length
    ? h(
        'ul',
        { class: 'checklist' },
        assessment.checklist.map((item) =>
          h(
            'li',
            null,
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
          ),
        ),
      )
    : null;

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
    checklist
      ? section(
          `Checklist · ${assessment.checklist.filter((item) => item.done).length}/${assessment.checklist.length}`,
          checklist,
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
      'Document',
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
        : h(
            'div',
            { class: 'inline-row' },
            h(
              'button',
              { type: 'button', class: 'btn btn-sm', on: { click: () => picker.open() } },
              icon('upload', { size: 14 }),
              'Link a PDF or Word brief',
            ),
            picker.input,
          ),
      h(
        'p',
        { class: 'field-hint' },
        'Only the file name and size are saved. Reading details from the brief arrives in a later update; your own entries will never be replaced without asking.',
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
