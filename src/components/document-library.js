/**
 * Document library (dashboard): what the extension remembers about imported briefs.
 * Shows file name, type, import date, linked deadlines, extraction status, duplicate
 * and version history, and the stored source evidence. Users can delete a record.
 */

import { DOCUMENT_STATUSES } from '../models/document.js';
import { createImportService } from '../services/imports.js';
import { fileStore } from '../services/file-store.js';
import { formatBytes, h } from '../utils/dom.js';
import { confirmDialog } from './dialog.js';
import { emptyState } from './assessment-card.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

const dateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function versionNotes(record, documents) {
  const notes = [];
  if (record.aliases.length)
    notes.push(
      `Also imported as ${record.aliases.map((name) => `“${name}”`).join(', ')} (identical copy)`,
    );
  const previous = documents.find((item) => item.id === record.previousDocumentId);
  if (previous) notes.push(`Updated version of “${previous.fileName}”`);
  else if (record.previousDocumentId) notes.push('Updated version of an earlier document');
  const newer = documents.find((item) => item.previousDocumentId === record.id);
  if (newer) notes.push(`Replaced by “${newer.fileName}”`);
  return notes;
}

async function download(record) {
  const blob = await fileStore.get(record.id);
  if (!blob) return showToast('The original file is no longer stored.', { tone: 'danger' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: record.fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function documentCard(record, { app, documents, assessments, onOpenDeadline }) {
  const linked = record.assessmentIds
    .map((id) => assessments.find((item) => item.id === id))
    .filter(Boolean);
  const facts = [
    record.fileType === 'pdf'
      ? record.pageCount !== null
        ? `${record.pageCount} ${record.pageCount === 1 ? 'page' : 'pages'}`
        : null
      : null,
    record.fileType === 'docx' && record.paragraphCount !== null
      ? `${record.paragraphCount} paragraphs`
      : null,
    record.size !== null ? formatBytes(record.size) : null,
    `Imported ${dateTime(record.importedAt)}`,
    record.lastImportedAt !== record.importedAt
      ? `last seen ${dateTime(record.lastImportedAt)}`
      : null,
  ].filter(Boolean);

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: 'Delete document information?',
      message: `The library entry for “${record.fileName}”, its source evidence${record.fileStored ? ' and the stored file' : ''} will be removed. Linked deadlines stay, with the file name still shown.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    await createImportService({ storage: app.storage }).deleteDocument(record.id);
    if (record.fileStored) await fileStore.delete(record.id).catch(() => {});
    showToast(`Deleted “${record.fileName}” from the library`);
  };

  return h(
    'article',
    { class: 'doc-card' },
    h(
      'div',
      { class: 'doc-head' },
      h('span', { class: `file-badge file-${record.fileType}` }, record.fileType.toUpperCase()),
      h('h3', { class: 'doc-name' }, record.fileName),
      h('span', { class: `status-chip status-${record.status}` }, DOCUMENT_STATUSES[record.status]),
    ),
    h(
      'p',
      { class: 'doc-meta' },
      facts.map((fact) => h('span', null, fact)),
    ),
    versionNotes(record, documents).map((note) => h('p', { class: 'field-hint' }, note)),
    h(
      'div',
      { class: 'doc-links' },
      linked.length
        ? linked.map((assessment) =>
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm',
                title: 'Open deadline',
                on: { click: () => onOpenDeadline(assessment.id) },
              },
              icon('calendar', { size: 13 }),
              assessment.title,
            ),
          )
        : h('span', { class: 'muted' }, 'Not linked to a deadline'),
    ),
    record.warnings.length
      ? h(
          'details',
          null,
          h(
            'summary',
            { class: 'link' },
            `${record.warnings.length} extraction ${record.warnings.length === 1 ? 'note' : 'notes'}`,
          ),
          h(
            'ul',
            { class: 'warning-list' },
            record.warnings.map((warning) => h('li', null, warning)),
          ),
        )
      : null,
    record.evidence.length
      ? h(
          'details',
          null,
          h('summary', { class: 'link' }, `Source evidence (${record.evidence.length})`),
          h(
            'ul',
            { class: 'evidence-list' },
            record.evidence.map((item) =>
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
      : h('p', { class: 'muted' }, 'No source evidence stored.'),
    h(
      'div',
      { class: 'doc-actions' },
      record.fileStored
        ? h(
            'button',
            { type: 'button', class: 'btn btn-sm', on: { click: () => download(record) } },
            icon('download', { size: 13 }),
            'Download original',
          )
        : null,
      h(
        'button',
        { type: 'button', class: 'btn btn-sm btn-ghost-danger', on: { click: remove } },
        icon('trash', { size: 13 }),
        'Delete information',
      ),
    ),
  );
}

/** Render the library into `container`. `search` filters by file name. */
export function renderLibrary(container, { app, search = '', onOpenDeadline }) {
  const { documents = [], assessments, settings } = app.getState();
  const query = search.trim().toLowerCase();
  const visible = documents
    .filter(
      (record) =>
        !query ||
        [record.fileName, ...record.aliases].some((name) => name.toLowerCase().includes(query)),
    )
    .sort((a, b) => b.lastImportedAt.localeCompare(a.lastImportedAt));

  const intro = h(
    'p',
    { class: 'library-intro' },
    settings.retainDocumentFiles
      ? 'For each imported brief the extension keeps its details, a fingerprint (SHA-256) used to spot duplicates, short source quotes, and a copy of the file (“Keep original files” is on).'
      : 'For each imported brief the extension keeps its details, a fingerprint (SHA-256) used to spot duplicates, and short source quotes. The original files are not kept.',
  );
  const importButton = h(
    'button',
    { type: 'button', class: 'btn btn-primary btn-sm', on: { click: () => app.openImportPage() } },
    icon('upload', { size: 14 }),
    'Import documents',
  );
  container.replaceChildren(
    h(
      'div',
      { class: 'library' },
      h('div', { class: 'inline-row wrap' }, intro, importButton),
      visible.length
        ? visible.map((record) =>
            documentCard(record, { app, documents, assessments, onOpenDeadline }),
          )
        : emptyState({
            title: query ? 'No matching documents' : 'No documents yet',
            message: query
              ? 'Try a different search.'
              : 'Imported PDF and Word briefs appear here.',
          }),
    ),
  );
}
