/**
 * Document helpers that do not need a PDF or Word parser.
 *
 * Stage 1 can check a chosen file and link it to a deadline (name, type and size
 * only; the file contents are not stored). Extraction itself arrives in Stage 2,
 * which will produce an `Extraction` object and use `compareWithExtraction` and
 * `applyDocumentChanges` below to let the user approve each change.
 *
 * Extraction shape (produced by Stage 2):
 *   {
 *     sourceType: 'pdf' | 'docx',
 *     confidence: 'high' | 'medium' | 'low',          // overall
 *     fields: { title?: { value, confidence, sourceText }, moduleName?, moduleCode?,
 *               dueDate?, dueTime?, weighting?, description? },
 *     deliverables?: [{ value, sourceText }]
 *   }
 */

import { createId, normalizeAssessment } from '../models/assessment.js';

export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

export const MERGEABLE_FIELDS = Object.freeze([
  { field: 'title', label: 'Title' },
  { field: 'moduleName', label: 'Module' },
  { field: 'moduleCode', label: 'Module code' },
  { field: 'dueDate', label: 'Due date' },
  { field: 'dueTime', label: 'Submission time' },
  { field: 'weighting', label: 'Weighting' },
  { field: 'description', label: 'Requirements' },
]);

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" (DOCX is a ZIP archive)

function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Check a user-chosen file before anything else touches it. The extension and the
 * first bytes must agree, which rejects renamed files. Macro-enabled .docm files
 * are refused outright.
 *
 * @param {{ name: string, size: number }} file
 * @param {Uint8Array} headerBytes at least the first 4 bytes of the file
 */
export function validateDocumentFile(file, headerBytes) {
  const name = String(file?.name ?? '');
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'docm') {
    return { ok: false, error: 'Macro-enabled Word files (.docm) are not supported.' };
  }
  if (extension !== 'pdf' && extension !== 'docx') {
    return { ok: false, error: 'Choose a PDF (.pdf) or Word (.docx) file.' };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: 'This file is empty.' };
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: 'Files larger than 30 MB are not supported.' };
  }
  const bytes = headerBytes ?? new Uint8Array();
  const signatureOk =
    extension === 'pdf' ? startsWith(bytes, PDF_SIGNATURE) : startsWith(bytes, ZIP_SIGNATURE);
  if (!signatureOk) {
    return { ok: false, error: `This does not look like a real .${extension} file.` };
  }
  return { ok: true, sourceType: extension };
}

/** Metadata stored on the assessment. No file contents are kept. */
export function createDocumentReference(
  file,
  sourceType,
  { now = new Date(), idFactory = createId } = {},
) {
  return {
    id: idFactory(),
    name: String(file.name).slice(0, 255),
    type: sourceType,
    size: file.size,
    attachedAt: now.toISOString(),
  };
}

function normalizeText(value) {
  return String(value).trim().toLowerCase();
}

/**
 * List what an extraction would change on an existing deadline.
 * A difference is pre-selected only when it fills an empty field, or when it is a
 * high-confidence value for a field the user never confirmed. Anything the user typed
 * or confirmed needs an explicit tick to be replaced.
 */
export function compareWithExtraction(assessment, extraction) {
  const differences = [];
  const fields = extraction?.fields ?? {};
  const confirmed = new Set(assessment.confirmedFields ?? []);

  for (const { field, label } of MERGEABLE_FIELDS) {
    const proposed = fields[field]?.value;
    if (proposed === null || proposed === undefined || proposed === '') continue;
    const current = assessment[field] ?? null;
    const status =
      current === null
        ? 'new'
        : normalizeText(current) === normalizeText(proposed)
          ? 'same'
          : 'different';
    if (status === 'same') continue;
    const confidence = fields[field].confidence ?? 'low';
    differences.push({
      field,
      label,
      current,
      proposed,
      confidence,
      sourceText: fields[field].sourceText ?? null,
      confirmed: confirmed.has(field),
      status,
      selectedByDefault: status === 'new' || (!confirmed.has(field) && confidence === 'high'),
    });
  }

  const existingItems = new Set(assessment.checklist.map((item) => normalizeText(item.text)));
  const newDeliverables = (extraction?.deliverables ?? [])
    .map((item) => (typeof item === 'string' ? item : item?.value))
    .filter((text) => typeof text === 'string' && text.trim())
    .filter((text) => !existingItems.has(normalizeText(text)));
  if (newDeliverables.length > 0) {
    differences.push({
      field: 'checklist',
      label: 'Deliverables',
      current: assessment.checklist.map((item) => item.text),
      proposed: newDeliverables,
      confidence: 'medium',
      sourceText: null,
      confirmed: false,
      status: 'new',
      selectedByDefault: true,
    });
  }
  return differences;
}

/**
 * Apply only the user-selected fields from an extraction. Notes, completion,
 * checklist progress and reminder preferences are always preserved; new
 * deliverables are appended, never replacing existing checklist items.
 */
export function applyDocumentChanges(
  existing,
  extraction,
  selectedFields,
  { now = new Date(), document = null, idFactory = createId } = {},
) {
  const selected = new Set(selectedFields ?? []);
  const differences = compareWithExtraction(existing, extraction).filter((difference) =>
    selected.has(difference.field),
  );
  if (differences.length === 0 && !document) return existing;

  const next = { ...existing, checklist: existing.checklist.map((item) => ({ ...item })) };
  for (const difference of differences) {
    if (difference.field === 'checklist') {
      for (const text of difference.proposed) {
        next.checklist.push({ id: idFactory(), text, done: false });
      }
    } else {
      next[difference.field] = difference.proposed;
    }
  }
  if (document) next.sourceDocument = document;
  if (extraction?.confidence) next.extractionConfidence = extraction.confidence;

  const normalized = normalizeAssessment(next, { idFactory });
  if (!normalized) return existing; // an extraction must never break a valid record
  normalized.updatedAt = now.toISOString();
  // The user approved these values, so they now count as confirmed.
  normalized.confirmedFields = [
    ...new Set([...existing.confirmedFields, ...differences.map((difference) => difference.field)]),
  ];
  return normalized;
}
