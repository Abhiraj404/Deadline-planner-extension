/**
 * Document import page.
 *
 * Runs in its own tab so long imports never depend on the popup staying open.
 * Files are processed a couple at a time (bounded concurrency), each one can be
 * cancelled or removed, and nothing is saved until the user confirms a review.
 *
 * Hash route: #attach=<deadline id> imports a brief for an existing deadline, so the
 * review shows a comparison instead of creating a new deadline.
 */

import { icon } from '../components/icons.js';
import { createReviewPanel } from '../components/import-review.js';
import { showToast } from '../components/toast.js';
import { loadPdfjs, readDocxInWorker } from '../documents/loaders.js';
import { STAGES, createImportPipeline } from '../documents/pipeline.js';
import { createApp } from '../services/app.js';
import { classifyImport } from '../services/duplicates.js';
import { fileStore } from '../services/file-store.js';
import { createImportService } from '../services/imports.js';
import { THEME_LABELS, nextTheme } from '../services/theme.js';
import { todayInTimeZone } from '../utils/dates.js';
import { formatBytes, h } from '../utils/dom.js';

const CONCURRENCY = 2;
const THEME_ICONS = { system: 'system', light: 'sun', dark: 'moon' };
const STATUS_TEXT = {
  queued: 'Waiting',
  processing: 'Processing',
  review: 'Ready to review',
  saved: 'Saved',
  discarded: 'Discarded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

let nextId = 0;

async function main() {
  const root = document.getElementById('app');
  let app;
  try {
    app = await createApp();
  } catch (error) {
    root.replaceChildren(
      h('p', { class: 'form-error page-error' }, error?.message ?? 'Could not load.'),
    );
    return;
  }
  const imports = createImportService({ storage: app.storage });
  const pipeline = createImportPipeline({ loadPdfjs, readDocx: readDocxInWorker });

  const attachMatch = /^#attach=(.+)$/.exec(decodeURIComponent(location.hash));
  const attachTo = attachMatch && app.getAssessment(attachMatch[1]) ? attachMatch[1] : null;

  /** @type {Array<object>} */
  const queue = [];
  let selectedId = null;
  let running = 0;

  // ---------- Layout ----------
  const themeButton = h('button', {
    type: 'button',
    class: 'icon-button',
    on: {
      click: () => {
        const settings = app.getSettings();
        app.storage.saveSettings({ ...settings, theme: nextTheme(settings.theme) });
      },
    },
  });
  const topbar = h(
    'header',
    { class: 'topbar import-topbar' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark' }, icon('logo', { size: 16 })),
      h('h1', { class: 'brand-name' }, 'Import documents'),
    ),
    h(
      'div',
      { class: 'topbar-actions' },
      themeButton,
      h(
        'a',
        {
          class: 'btn',
          href: app.isExtension
            ? chrome.runtime.getURL('dashboard/dashboard.html')
            : '/dashboard/dashboard.html',
        },
        icon('list', { size: 15 }),
        'Dashboard',
      ),
    ),
  );

  const input = h('input', {
    type: 'file',
    multiple: true,
    accept:
      '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  input.addEventListener('change', () => {
    addFiles([...(input.files ?? [])]);
    input.value = '';
  });
  const limitsText = h('p', { class: 'dropzone-hint' });
  const retentionText = h('p', { class: 'field-hint retention' });
  const dropzone = h(
    'div',
    { class: 'dropzone dropzone-large' },
    h('div', { class: 'dropzone-icon' }, icon('upload', { size: 22 })),
    h('p', { class: 'dropzone-title' }, 'Drop PDF or Word briefs here'),
    limitsText,
    h(
      'button',
      { type: 'button', class: 'btn btn-primary btn-sm', on: { click: () => input.click() } },
      'Choose files',
    ),
    input,
  );
  const attachBanner = attachTo
    ? h(
        'div',
        { class: 'notice notice-info' },
        icon('link', { size: 14 }),
        h(
          'p',
          null,
          'Importing a brief for ',
          h('strong', null, app.getAssessment(attachTo).title),
          '. You will see the differences before anything changes.',
        ),
      )
    : null;
  const queueList = h('ul', {
    class: 'queue',
    'aria-label': 'Imported files',
    'aria-live': 'polite',
  });
  const queueSummary = h('p', { class: 'muted queue-summary' });
  const reviewArea = h('section', { class: 'review-area', 'aria-label': 'Review' });

  root.replaceChildren(
    topbar,
    h(
      'main',
      { class: 'import-layout' },
      h(
        'div',
        { class: 'import-side' },
        attachBanner,
        dropzone,
        retentionText,
        queueSummary,
        queueList,
      ),
      reviewArea,
    ),
  );
  root.removeAttribute('aria-busy');

  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    });
  }
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) dropzone.classList.remove('is-dragging');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    addFiles([...(event.dataTransfer?.files ?? [])]);
  });
  window.addEventListener('beforeunload', (event) => {
    if (queue.some((item) => item.status === 'processing' || item.status === 'review'))
      event.preventDefault();
  });

  // ---------- Queue ----------
  function addFiles(files) {
    if (files.length === 0) return;
    const { maxBatchSize } = app.getSettings().importLimits;
    const active = queue.filter((item) =>
      ['queued', 'processing', 'review'].includes(item.status),
    ).length;
    const room = Math.max(0, maxBatchSize - active);
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      showToast(
        `Only ${maxBatchSize} files can be imported at once. ${files.length - accepted.length} ${files.length - accepted.length === 1 ? 'was' : 'were'} not added.`,
        { tone: 'danger' },
      );
    }
    for (const file of accepted) {
      queue.push({
        id: `item-${(nextId += 1)}`,
        file,
        status: 'queued',
        stage: 'queued',
        progress: null,
        error: null,
        result: null,
        classification: null,
        controller: null,
      });
    }
    renderQueue();
    pump();
  }

  function pump() {
    while (running < CONCURRENCY) {
      const item = queue.find((entry) => entry.status === 'queued');
      if (!item) break;
      running += 1;
      processItem(item).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  async function processItem(item) {
    item.status = 'processing';
    item.controller = new AbortController();
    renderQueue();
    const settings = app.getSettings();
    try {
      item.result = await pipeline.processFile(item.file, {
        limits: settings.importLimits,
        timeZone: settings.timeZone,
        referenceDate: todayInTimeZone(settings.timeZone),
        signal: item.controller.signal,
        onStage: (stage, detail) => {
          item.stage = stage;
          item.progress = detail?.pages ? detail : null;
          renderQueueItem(item);
        },
      });
      const { documents, assessments } = app.getState();
      item.classification = classifyImport(
        {
          hash: item.result.hash,
          fileName: item.result.fileName,
          candidates: item.result.extraction.assessments.map((candidate) => ({
            title: candidate.title?.value,
            moduleCode: candidate.moduleCode?.value,
            dueDate: candidate.submissionDeadline?.value,
          })),
        },
        { documents, assessments },
      );
      item.status = 'review';
      if (!selectedId) select(item.id);
    } catch (error) {
      item.status = error?.code === 'cancelled' ? 'cancelled' : 'failed';
      item.error = error?.code ? error.message : 'Something went wrong while reading this file.';
      if (!error?.code) console.error(error);
    } finally {
      item.controller = null;
      renderQueue();
    }
  }

  function remove(item) {
    item.controller?.abort();
    queue.splice(queue.indexOf(item), 1);
    if (selectedId === item.id)
      select(queue.find((entry) => entry.status === 'review')?.id ?? null);
    renderQueue();
  }

  function select(id) {
    selectedId = id;
    renderReview();
    renderQueue();
  }

  function stageText(item) {
    if (item.status !== 'processing') return item.error ?? STATUS_TEXT[item.status];
    if (item.stage === 'reading' && item.progress?.pages)
      return `Reading page ${item.progress.page} of ${item.progress.pages}`;
    return STAGES[item.stage] ?? 'Processing';
  }

  const rows = new Map();
  function renderQueueItem(item) {
    const status = h('p', { class: `queue-status status-${item.status}` }, stageText(item));
    const percent =
      item.status === 'processing' && item.progress?.pages
        ? Math.round((item.progress.page / item.progress.pages) * 100)
        : null;
    const bar =
      item.status === 'processing'
        ? h(
            'div',
            {
              class: ['progress', percent === null ? 'is-indeterminate' : null],
              role: 'progressbar',
              'aria-label': `Progress for ${item.file.name}`,
              'aria-valuemin': percent === null ? null : '0',
              'aria-valuemax': percent === null ? null : '100',
              'aria-valuenow': percent === null ? null : String(percent),
            },
            h('span', { class: 'progress-bar', dataset: { percent: String(percent ?? 0) } }),
          )
        : null;
    if (bar && percent !== null) bar.firstChild.style.width = `${percent}%`;

    const actions = [];
    if (item.status === 'processing') {
      actions.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-sm', on: { click: () => item.controller?.abort() } },
          'Cancel',
        ),
      );
    }
    if (item.status === 'review') {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-primary',
            'aria-pressed': String(selectedId === item.id),
            on: { click: () => select(item.id) },
          },
          'Review',
        ),
      );
    }
    if (item.status === 'failed' || item.status === 'cancelled') {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            on: {
              click: () => {
                Object.assign(item, { status: 'queued', stage: 'queued', error: null });
                renderQueue();
                pump();
              },
            },
          },
          'Retry',
        ),
      );
    }
    if (item.status !== 'processing') {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button icon-button-sm',
            'aria-label': `Remove ${item.file.name}`,
            title: 'Remove from list',
            on: { click: () => remove(item) },
          },
          icon('x', { size: 14 }),
        ),
      );
    }
    const badge =
      item.classification && item.status === 'review' && item.classification.kind !== 'new'
        ? h(
            'span',
            { class: 'badge badge-accent' },
            {
              identical: 'Duplicate',
              renamed: 'Renamed copy',
              update: 'Updated version',
              similar: 'Similar',
            }[item.classification.kind],
          )
        : null;
    const row = h(
      'li',
      { class: ['queue-item', selectedId === item.id ? 'is-selected' : null] },
      h(
        'span',
        {
          class: `file-badge file-${item.file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'}`,
        },
        item.file.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'DOCX',
      ),
      h(
        'div',
        { class: 'queue-body' },
        h('p', { class: 'queue-name', title: item.file.name }, item.file.name),
        h(
          'p',
          { class: 'queue-meta' },
          formatBytes(item.file.size),
          item.result
            ? h(
                'span',
                { dataset: { ms: String(item.result.stats.durationMs) } },
                `read in ${item.result.stats.durationMs} ms`,
              )
            : null,
          badge,
        ),
        status,
        bar,
      ),
      h('div', { class: 'queue-actions' }, actions),
    );
    const previous = rows.get(item.id);
    if (previous?.isConnected) previous.replaceWith(row);
    rows.set(item.id, row);
    return row;
  }

  function renderQueue() {
    const settings = app.getSettings();
    const limits = settings.importLimits;
    limitsText.textContent = `.pdf or .docx · up to ${limits.maxFileSizeMB} MB each · ${limits.maxBatchSize} files at a time`;
    retentionText.textContent = settings.retainDocumentFiles
      ? 'Files are read on this device only. Confirmed details, short source quotes and a fingerprint (SHA-256) are saved, and a copy of each file is kept because “Keep original files” is on in Settings.'
      : 'Files are read on this device only. Confirmed details, short source quotes and a fingerprint (SHA-256) are saved; the original file is not kept.';
    queueList.replaceChildren(...queue.map(renderQueueItem));
    const counts = queue.reduce(
      (all, item) => ({ ...all, [item.status]: (all[item.status] ?? 0) + 1 }),
      {},
    );
    queueSummary.textContent = queue.length
      ? Object.entries(counts)
          .map(([status, count]) => `${count} ${STATUS_TEXT[status].toLowerCase()}`)
          .join(' · ')
      : '';
    themeButton.replaceChildren(icon(THEME_ICONS[settings.theme]));
    themeButton.setAttribute('aria-label', `${THEME_LABELS[settings.theme]}. Switch theme`);
  }

  function renderReview() {
    const item = queue.find((entry) => entry.id === selectedId && entry.status === 'review');
    if (!item) {
      reviewArea.replaceChildren(
        h(
          'div',
          { class: 'empty-state review-empty' },
          h('div', { class: 'empty-icon' }, icon('file', { size: 22 })),
          h(
            'p',
            { class: 'empty-title' },
            queue.some((entry) => entry.status === 'processing')
              ? 'Reading your documents…'
              : 'Nothing to review yet',
          ),
          h(
            'p',
            { class: 'empty-message' },
            'Add PDF or Word briefs. Each one is checked, read on this device and shown here for you to confirm. Nothing is saved until you do.',
          ),
        ),
      );
      return;
    }
    reviewArea.replaceChildren(
      createReviewPanel({
        item: { ...item, attachTo },
        app,
        onDiscard: () => {
          item.status = 'discarded';
          select(queue.find((entry) => entry.status === 'review')?.id ?? null);
        },
        onSave: async (payload) => {
          const outcome = await imports.saveReviewedImport(item.result, payload);
          if (!outcome.ok) return outcome;
          if (app.getSettings().retainDocumentFiles) {
            try {
              await fileStore.put(outcome.document.id, item.file);
              await app.storage.updateDocuments((documents) =>
                documents.map((record) =>
                  record.id === outcome.document.id ? { ...record, fileStored: true } : record,
                ),
              );
            } catch {
              showToast('The details were saved, but the original file could not be kept.', {
                tone: 'danger',
              });
            }
          }
          item.status = 'saved';
          const total = outcome.created.length + outcome.updated.length;
          showToast(
            total
              ? `Saved ${total} ${total === 1 ? 'deadline' : 'deadlines'} from ${item.file.name}`
              : `Kept ${item.file.name} in the library`,
            {
              tone: 'success',
              action: {
                label: 'Open dashboard',
                onClick: () =>
                  (location.href = app.isExtension
                    ? chrome.runtime.getURL('dashboard/dashboard.html')
                    : '/dashboard/dashboard.html'),
              },
            },
          );
          select(queue.find((entry) => entry.status === 'review')?.id ?? null);
          return outcome;
        },
      }),
    );
    reviewArea.querySelector('h2')?.setAttribute('tabindex', '-1');
    reviewArea.querySelector('h2')?.focus();
  }

  app.onChange(() => renderQueue());
  renderQueue();
  renderReview();
}

main();
