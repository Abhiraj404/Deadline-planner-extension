/**
 * Merging extracted values into an existing deadline (pure functions).
 *
 * When an updated brief is imported for a deadline the user already has,
 * `compareWithExtraction` lists what would change and `applyDocumentChanges` applies
 * only the fields the user ticked. File validation lives in documents/file-checks.js.
 *
 * Extraction shape (built by services/imports.js `candidateToExtraction`):
 *   {
 *     sourceType: 'pdf' | 'docx',
 *     confidence: 'high' | 'medium' | 'low',          // overall
 *     fields: { title?: { value, confidence, sourceText }, moduleName?, moduleCode?,
 *               dueDate?, dueTime?, weighting?, description?, submissionMethod?,
 *               wordCount?, groupSize? },
 *     deliverables?: string[], instructions?: string[], markingCriteria?: string[]
 *   }
 */

import { createId, normalizeAssessment } from '../models/assessment.js';

export const MERGEABLE_FIELDS = Object.freeze([
  { field: 'title', label: 'Title' },
  { field: 'moduleName', label: 'Module' },
  { field: 'moduleCode', label: 'Module code' },
  { field: 'dueDate', label: 'Due date' },
  { field: 'dueTime', label: 'Submission time' },
  { field: 'weighting', label: 'Weighting' },
  { field: 'description', label: 'Requirements' },
  { field: 'submissionMethod', label: 'Submission method' },
  { field: 'wordCount', label: 'Word count' },
  { field: 'groupSize', label: 'Group size' },
]);

/** List fields: new items are appended, existing items are never removed. */
const LIST_FIELDS = [
  {
    field: 'checklist',
    source: 'deliverables',
    label: 'Deliverables',
    current: (a) => a.checklist.map((item) => item.text),
  },
  {
    field: 'instructions',
    source: 'instructions',
    label: 'Important instructions',
    current: (a) => a.instructions ?? [],
  },
  {
    field: 'markingCriteria',
    source: 'markingCriteria',
    label: 'Marking criteria',
    current: (a) => a.markingCriteria ?? [],
  },
];

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

  for (const list of LIST_FIELDS) {
    const currentItems = list.current(assessment);
    const existingItems = new Set(currentItems.map(normalizeText));
    const additions = (extraction?.[list.source] ?? [])
      .map((item) => (typeof item === 'string' ? item : item?.value))
      .filter((text) => typeof text === 'string' && text.trim())
      .filter((text) => !existingItems.has(normalizeText(text)));
    if (additions.length === 0) continue;
    differences.push({
      field: list.field,
      label: list.label,
      current: currentItems,
      proposed: additions,
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

  const next = {
    ...existing,
    checklist: existing.checklist.map((item) => ({ ...item })),
    instructions: [...(existing.instructions ?? [])],
    markingCriteria: [...(existing.markingCriteria ?? [])],
  };
  for (const difference of differences) {
    if (difference.field === 'checklist') {
      for (const text of difference.proposed) {
        next.checklist.push({ id: idFactory(), text, done: false });
      }
    } else if (difference.field === 'instructions' || difference.field === 'markingCriteria') {
      next[difference.field].push(...difference.proposed);
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
