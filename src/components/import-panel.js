/**
 * Document import panel.
 *
 * Stage 1 is honest about what works: the user can pick or drop a PDF/DOCX, the file
 * is checked (type, size, signature), and they can continue to the manual form with
 * the document linked. Automatic extraction is clearly labelled as coming in Stage 2.
 * No document parser is loaded.
 */

import { createDocumentReference, validateDocumentFile } from '../services/documents.js';
import { formatBytes, h, uniqueId } from '../utils/dom.js';
import { icon } from './icons.js';

/** Read the first bytes of a File for signature checks without loading the whole file. */
export async function readHeader(file) {
  return new Uint8Array(await file.slice(0, 8).arrayBuffer());
}

/** Validate a File and return a document reference, or an error message. */
export async function checkDocument(file) {
  const result = validateDocumentFile(file, await readHeader(file));
  if (!result.ok) return result;
  return { ok: true, document: createDocumentReference(file, result.sourceType) };
}

/** A hidden <input type=file> for PDF/DOCX, returned with a function that opens it. */
export function documentPicker(onFile) {
  const input = h('input', {
    type: 'file',
    accept:
      '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) onFile(file);
  });
  return { input, open: () => input.click() };
}

/**
 * @param {object} options
 * @param {(documentRef: object) => void} options.onContinueManually
 */
export function createImportPanel({ onContinueManually }) {
  const statusId = uniqueId('import-status');
  const status = h('div', { class: 'import-status', id: statusId, 'aria-live': 'polite' });
  const picker = documentPicker(handleFile);

  const dropzone = h(
    'div',
    { class: 'dropzone' },
    h('div', { class: 'dropzone-icon' }, icon('upload', { size: 20 })),
    h('p', { class: 'dropzone-title' }, 'Drop a PDF or Word brief here'),
    h('p', { class: 'dropzone-hint' }, '.pdf or .docx, up to 30 MB'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm',
        'aria-describedby': statusId,
        on: { click: () => picker.open() },
      },
      'Choose file',
    ),
    picker.input,
  );

  async function handleFile(file) {
    status.replaceChildren(h('p', { class: 'muted' }, 'Checking file…'));
    const result = await checkDocument(file);
    if (!result.ok) {
      status.replaceChildren(h('p', { class: 'form-error' }, result.error));
      return;
    }
    const doc = result.document;
    status.replaceChildren(
      h(
        'div',
        { class: 'import-result' },
        h(
          'div',
          { class: 'attached-doc' },
          icon('file', { size: 14 }),
          h('span', null, `${doc.name} · ${formatBytes(doc.size)}`),
        ),
        h(
          'p',
          { class: 'muted' },
          'Automatic extraction is not available yet. Enter the details yourself and the document will be linked to the deadline.',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            on: { click: () => onContinueManually(doc) },
          },
          'Enter details manually',
        ),
      ),
    );
  }

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, () => dropzone.classList.remove('is-dragging'));
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  return h(
    'div',
    { class: 'import-panel' },
    h(
      'div',
      { class: 'notice' },
      h('span', { class: 'badge badge-accent' }, 'In development'),
      h(
        'p',
        null,
        'Reading deadlines from PDF and Word briefs is coming in the next update. You can already link a brief to a deadline.',
      ),
    ),
    dropzone,
    status,
  );
}
