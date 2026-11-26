/**
 * Saving a reviewed import.
 *
 * Nothing extracted is ever saved automatically. The review screen collects what the
 * user confirmed and calls `saveReviewedImport`, which in one storage write:
 *   - creates the confirmed new deadlines (sourceType 'pdf' or 'docx'),
 *   - applies the field changes the user ticked to existing deadlines (updates),
 *   - adds or updates the document library record (hash, evidence, links).
 *
 * Manual deadlines use the same assessment model and storage list; this module only
 * adds the document-specific bookkeeping.
 */

import { createAssessment, createId } from '../models/assessment.js';
import {
  createDocumentRecord,
  documentReference,
  normalizeDocumentRecord,
} from '../models/document.js';
import { getCategories } from '../models/settings.js';
import { validateAssessmentInput } from '../utils/validation.js';
import { applyDocumentChanges } from './documents.js';

const EVIDENCE_FIELDS = [
  ['title', 'Title'],
  ['moduleName', 'Module'],
  ['moduleCode', 'Module code'],
  ['assessmentType', 'Assessment type'],
  ['weighting', 'Weighting'],
  ['submissionTime', 'Submission time'],
  ['submissionMethod', 'Submission method'],
  ['wordCount', 'Word count'],
  ['groupSize', 'Group size'],
];

const formatValue = (field, value) =>
  field === 'weighting' && typeof value === 'number' ? `${value}%` : value;

/** Supporting source lines for what was extracted, kept in the document library. */
export function buildEvidence(candidate, assessmentId, chosenDeadline) {
  const evidence = [];
  const add = (field, label, item) => {
    if (!item?.source?.text) return;
    evidence.push({
      assessmentId,
      field,
      label,
      value:
        item.value === null || item.value === undefined
          ? null
          : String(formatValue(field, item.value)),
      text: item.source.text,
      location: item.source.location,
      confidence: item.confidence ?? null,
    });
  };
  const deadline = chosenDeadline ?? candidate.submissionDeadline;
  if (deadline)
    add('dueDate', 'Submission deadline', {
      ...deadline,
      value: deadline.value ?? deadline.matchedText,
    });
  for (const [field, label] of EVIDENCE_FIELDS) add(field, label, candidate[field]);
  add('presentationDuration', 'Presentation duration', candidate.presentation?.duration);
  for (const date of candidate.presentation?.dates ?? [])
    add('presentationDate', 'Presentation date', date);
  for (const item of candidate.deliverables ?? []) add('deliverable', 'Deliverable', item);
  for (const item of (candidate.markingCriteria ?? []).slice(0, 8))
    add('markingCriterion', 'Marking criterion', item);
  for (const item of (candidate.instructions ?? []).slice(0, 8))
    add('instruction', 'Instruction', item);
  return evidence;
}

/** Convert an engine candidate to the comparison shape used for updates. */
export function candidateToExtraction(candidate, sourceType) {
  const fields = {};
  const put = (name, item, value = item?.value) => {
    if (item && value !== null && value !== undefined) {
      fields[name] = { value, confidence: item.confidence, sourceText: item.source?.text ?? null };
    }
  };
  put('title', candidate.title);
  put('moduleName', candidate.moduleName);
  put('moduleCode', candidate.moduleCode);
  put('dueDate', candidate.submissionDeadline);
  put('dueTime', candidate.submissionTime);
  put('weighting', candidate.weighting);
  put('submissionMethod', candidate.submissionMethod);
  put('wordCount', candidate.wordCount);
  put('groupSize', candidate.groupSize);
  return {
    sourceType,
    confidence: candidate.needsConfirmation ? 'medium' : 'high',
    fields,
    deliverables: candidate.deliverables.map((item) => item.value),
    instructions: candidate.instructions.map((item) => item.value),
    markingCriteria: candidate.markingCriteria.map((item) => item.value),
  };
}

function documentStatus(stats) {
  if (stats.scanned) return 'no-text';
  if (stats.truncated || stats.emptyPages?.length) return 'partial';
  return 'complete';
}

export function createImportService({ storage, now = () => new Date(), idFactory = createId }) {
  /**
   * @param {object} processed the pipeline result (hash, fileName, size, sourceType, stats, warnings)
   * @param {object} review
   * @param {Array<{ values: object, candidate: object, deadline?: object }>} review.create
   *   confirmed new deadlines: form values plus the candidate they came from
   * @param {Array<{ assessmentId: string, extraction: object, selectedFields: string[], candidate: object }>} [review.update]
   * @param {boolean} [review.keepDocumentOnly] save the library record even with no deadlines
   * @returns {Promise<{ ok: true, document: object, created: object[], updated: object[] } | { ok: false, errors: object[] }>}
   */
  async function saveReviewedImport(
    processed,
    { create = [], update = [], keepDocumentOnly = false },
  ) {
    const settings = await storage.getSettings();
    const categoryIds = getCategories(settings).map((category) => category.id);
    const timestamp = now();

    // Validate everything first so a bad draft never leaves a half-saved import.
    const errors = [];
    const validated = create.map((draft, index) => {
      const result = validateAssessmentInput(draft.values, { categoryIds });
      if (!result.valid) errors.push({ index, errors: result.errors });
      return result.value;
    });
    if (errors.length) return { ok: false, errors };
    if (create.length === 0 && update.length === 0 && !keepDocumentOnly) {
      return {
        ok: false,
        errors: [{ index: -1, errors: { form: 'Choose at least one deadline to save.' } }],
      };
    }

    let outcome = null;
    await storage.updateLibrary(({ assessments, documents }) => {
      const existingRecord = documents.find((record) => record.hash === processed.hash);
      const record = existingRecord
        ? { ...existingRecord }
        : createDocumentRecord(
            {
              hash: processed.hash,
              fileName: processed.fileName,
              fileType: processed.sourceType,
              size: processed.size,
              status: documentStatus(processed.stats),
              pageCount: processed.stats.pageCount,
              paragraphCount: processed.stats.paragraphCount,
              textLength: processed.stats.textLength,
              truncated: processed.stats.truncated,
              durationMs: processed.stats.durationMs,
              warnings: processed.warnings,
              assessmentIds: [],
              evidence: [],
            },
            { now: timestamp, idFactory },
          );
      if (existingRecord) {
        record.lastImportedAt = timestamp.toISOString();
        if (
          record.fileName !== processed.fileName &&
          !record.aliases.includes(processed.fileName)
        ) {
          record.aliases = [...record.aliases, processed.fileName];
        }
      }
      const reference = documentReference(record, timestamp);

      const created = validated.map((value) =>
        createAssessment(
          {
            ...value,
            sourceType: processed.sourceType,
            userConfirmed: true,
            sourceDocument: reference,
          },
          { now: timestamp, idFactory, timeZone: settings.timeZone },
        ),
      );
      created.forEach((assessment, index) => {
        assessment.extractionConfidence = create[index].candidate?.needsConfirmation
          ? 'medium'
          : 'high';
      });

      const updated = [];
      let nextAssessments = [...assessments, ...created];
      for (const change of update) {
        const index = nextAssessments.findIndex((item) => item.id === change.assessmentId);
        if (index === -1) continue;
        const previous = nextAssessments[index];
        if (
          previous.sourceDocument &&
          previous.sourceDocument.id !== record.id &&
          !record.previousDocumentId
        ) {
          record.previousDocumentId = previous.sourceDocument.id;
        }
        const changed = applyDocumentChanges(previous, change.extraction, change.selectedFields, {
          now: timestamp,
          document: reference,
          idFactory,
        });
        nextAssessments = nextAssessments.map((item, i) => (i === index ? changed : item));
        updated.push(changed);
      }

      const evidence = [
        ...created.flatMap((assessment, index) =>
          buildEvidence(create[index].candidate ?? {}, assessment.id, create[index].deadline),
        ),
        ...update.flatMap((change) => buildEvidence(change.candidate ?? {}, change.assessmentId)),
      ];
      record.assessmentIds = [
        ...new Set([
          ...record.assessmentIds,
          ...created.map((item) => item.id),
          ...updated.map((item) => item.id),
        ]),
      ];
      // Keep the newest evidence first; older entries for the same deadline are replaced.
      const refreshed = new Set(evidence.map((item) => item.assessmentId));
      record.evidence = [
        ...evidence,
        ...record.evidence.filter((item) => !refreshed.has(item.assessmentId)),
      ];

      const normalized = normalizeDocumentRecord(record);
      outcome = { ok: true, document: normalized, created, updated };
      return {
        assessments: nextAssessments,
        documents: existingRecord
          ? documents.map((item) => (item.id === existingRecord.id ? normalized : item))
          : [...documents, normalized],
      };
    });
    return outcome;
  }

  /**
   * Delete a document's library record (metadata and evidence). Deadlines stay; they
   * keep the file name in `sourceDocument` so you can still see where they came from.
   */
  async function deleteDocument(id) {
    let removed = null;
    await storage.updateDocuments((documents) => {
      removed = documents.find((record) => record.id === id) ?? null;
      return removed ? documents.filter((record) => record.id !== id) : documents;
    });
    return removed;
  }

  return { saveReviewedImport, deleteDocument };
}
