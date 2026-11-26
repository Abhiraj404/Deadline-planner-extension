/**
 * Document library record: what the extension remembers about an imported brief.
 *
 * Stored in chrome.storage.local under `documents`. Only metadata and short pieces
 * of supporting evidence are kept (never the full text). The original file is kept
 * only if the user turned on "Keep original files" (then it lives in IndexedDB,
 * see services/file-store.js, and `fileStored` is true).
 */

import { createId } from './assessment.js';

export const DOCUMENT_STATUSES = Object.freeze({
  complete: 'Text extracted',
  partial: 'Partly extracted',
  'no-text': 'No readable text',
});

const MAX_EVIDENCE = 60;
const MAX_WARNINGS = 12;

const text = (value, max) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function normalizeEvidence(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object' && text(item.text, 300))
    .slice(0, MAX_EVIDENCE)
    .map((item) => ({
      assessmentId: text(item.assessmentId, 64),
      field: text(item.field, 40) ?? 'other',
      label: text(item.label, 60) ?? 'Value',
      value: text(String(item.value ?? ''), 300),
      text: text(item.text, 300),
      location: text(item.location, 80),
      confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : null,
    }));
}

/** Coerce stored or restored data into a valid record, or `null` if unusable. */
export function normalizeDocumentRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^[0-9a-f]{64}$/.test(raw.hash ?? '')) return null;
  if (raw.fileType !== 'pdf' && raw.fileType !== 'docx') return null;
  const importedAt =
    typeof raw.importedAt === 'string' ? raw.importedAt : new Date(0).toISOString();
  return {
    id: raw.id,
    hash: raw.hash,
    fileName: text(raw.fileName, 255) ?? 'document',
    fileType: raw.fileType,
    size: count(raw.size),
    importedAt,
    lastImportedAt: typeof raw.lastImportedAt === 'string' ? raw.lastImportedAt : importedAt,
    aliases: Array.isArray(raw.aliases)
      ? [...new Set(raw.aliases.map((name) => text(name, 255)).filter(Boolean))].slice(0, 20)
      : [],
    status: Object.hasOwn(DOCUMENT_STATUSES, raw.status) ? raw.status : 'complete',
    pageCount: count(raw.pageCount),
    paragraphCount: count(raw.paragraphCount),
    textLength: count(raw.textLength),
    truncated: raw.truncated === true,
    durationMs: count(raw.durationMs),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings
          .map((warning) => text(warning, 300))
          .filter(Boolean)
          .slice(0, MAX_WARNINGS)
      : [],
    assessmentIds: Array.isArray(raw.assessmentIds)
      ? [...new Set(raw.assessmentIds.filter((id) => typeof id === 'string'))]
      : [],
    evidence: normalizeEvidence(raw.evidence),
    previousDocumentId: text(raw.previousDocumentId, 64),
    fileStored: raw.fileStored === true,
  };
}

/** Build a record from a processed import. */
export function createDocumentRecord(input, { now = new Date(), idFactory = createId } = {}) {
  const timestamp = now.toISOString();
  return normalizeDocumentRecord({
    ...input,
    id: input.id ?? idFactory(),
    importedAt: timestamp,
    lastImportedAt: timestamp,
  });
}

/** The reference stored on an assessment (`sourceDocument`). */
export function documentReference(record, now = new Date()) {
  return {
    id: record.id,
    name: record.fileName,
    type: record.fileType,
    size: record.size,
    attachedAt: now.toISOString(),
  };
}
