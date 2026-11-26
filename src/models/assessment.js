/**
 * The assessment (deadline) model.
 *
 * One plain JSON object describes every deadline, whether the user typed it in or it
 * was extracted from a PDF or Word brief. The model knows nothing about the UI or
 * about chrome.storage; it only creates, normalises and changes plain objects.
 *
 * Rule: unknown information stays `null`. Nothing is guessed or defaulted to a value
 * that could be mistaken for something the user said (for example, a weighting).
 * See docs/ARCHITECTURE.md for the full field reference.
 */

import { isValidISODate, isValidTime, isValidTimeZone } from '../utils/dates.js';
import { DEFAULT_TIME_ZONE, normalizeOffsets, slugifyCategory } from './settings.js';

export const SOURCE_TYPES = Object.freeze(['manual', 'pdf', 'docx']);
export const PRIORITIES = Object.freeze(['low', 'medium', 'high']);
export const PRIORITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

/** Fields a person can type or confirm. Used for edits and for document comparison. */
export const USER_FIELDS = Object.freeze([
  'title',
  'category',
  'moduleName',
  'moduleCode',
  'dueDate',
  'dueTime',
  'timeZone',
  'weighting',
  'priority',
  'description',
  'notes',
  'submissionUrl',
  'checklist',
  'reminderOffsets',
  'estimatedMinutes',
  'tags',
  'submissionMethod',
  'wordCount',
  'groupSize',
  'instructions',
  'markingCriteria',
  'relatedDates',
  'pinned',
]);

/** Kinds of related (non-deadline) dates, e.g. a presentation slot after submission. */
export const RELATED_DATE_LABELS = Object.freeze({
  presentation: 'Presentation',
  exam: 'Examination',
  release: 'Released',
  feedback: 'Feedback',
  revision: 'Revision',
  late_submission: 'Late submission',
  other: 'Other',
});

export function createId() {
  return globalThis.crypto.randomUUID();
}

function nullableString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function nullableNumber(value, { min, max, integer = false }) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  if (integer && !Number.isInteger(number)) return null;
  return number;
}

export function normalizeChecklist(value, idFactory = createId) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const item of value) {
    const text = nullableString(typeof item === 'string' ? item : item?.text, 300);
    if (!text) continue;
    items.push({
      id: typeof item?.id === 'string' && item.id ? item.id : idFactory(),
      text,
      done: item?.done === true,
    });
  }
  return items.slice(0, 50);
}

export function normalizeTags(value) {
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const seen = new Set();
  const tags = [];
  for (const raw of list) {
    const tag = nullableString(raw, 30);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags.slice(0, 20);
}

/** A list of short strings (instructions, marking criteria). Accepts text with one item per line. */
export function normalizeTextList(value, { maxItems = 30, maxLength = 300 } = {}) {
  const list = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  const items = [];
  for (const raw of list) {
    const text = nullableString(typeof raw === 'string' ? raw : raw?.text, maxLength);
    if (text && !items.includes(text)) items.push(text);
  }
  return items.slice(0, maxItems);
}

export function normalizeRelatedDates(value, idFactory = createId) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !isValidISODate(item.date)) continue;
    items.push({
      id: typeof item.id === 'string' && item.id ? item.id : idFactory(),
      label: Object.hasOwn(RELATED_DATE_LABELS, item.label) ? item.label : 'other',
      date: item.date,
      time: isValidTime(item.time) ? item.time : null,
      note: nullableString(item.note, 200),
    });
  }
  return items.slice(0, 20);
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const type = SOURCE_TYPES.includes(value.type) && value.type !== 'manual' ? value.type : null;
  if (!type) return null;
  return {
    id: value.id,
    name: nullableString(value.name, 255) ?? 'document',
    type,
    size: nullableNumber(value.size, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
    attachedAt: typeof value.attachedAt === 'string' ? value.attachedAt : null,
  };
}

/**
 * Coerce any stored, imported or migrated object into a valid assessment.
 * Returns `null` when the essentials (id, title, due date) are missing, so the
 * caller can skip the record instead of showing broken data.
 */
export function normalizeAssessment(raw, { idFactory = createId } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const title = nullableString(raw.title, 200);
  if (!title || !isValidISODate(raw.dueDate)) return null;

  const completed = raw.completed === true;
  const sourceType = SOURCE_TYPES.includes(raw.sourceType) ? raw.sourceType : 'manual';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString();

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : idFactory(),
    title,
    category: (typeof raw.category === 'string' && slugifyCategory(raw.category)) || 'other',
    moduleName: nullableString(raw.moduleName, 120),
    moduleCode: nullableString(raw.moduleCode, 30),
    dueDate: raw.dueDate,
    dueTime: isValidTime(raw.dueTime) ? raw.dueTime : null,
    timeZone: isValidTimeZone(raw.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE,
    weighting: nullableNumber(raw.weighting, { min: 0, max: 100 }),
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'medium',
    description: nullableString(raw.description, 5000),
    notes: nullableString(raw.notes, 5000),
    submissionUrl: nullableString(raw.submissionUrl, 2048),
    checklist: normalizeChecklist(raw.checklist, idFactory),
    reminderOffsets: Array.isArray(raw.reminderOffsets)
      ? normalizeOffsets(raw.reminderOffsets, [])
      : null,
    estimatedMinutes: nullableNumber(raw.estimatedMinutes, { min: 1, max: 60_000, integer: true }),
    tags: normalizeTags(raw.tags),
    submissionMethod: nullableString(raw.submissionMethod, 200),
    wordCount: nullableString(raw.wordCount, 80),
    groupSize: nullableString(raw.groupSize, 80),
    instructions: normalizeTextList(raw.instructions),
    markingCriteria: normalizeTextList(raw.markingCriteria),
    relatedDates: normalizeRelatedDates(raw.relatedDates, idFactory),
    pinned: raw.pinned === true,
    // Demo records (Settings → Demo data) can be removed without touching real ones.
    isDemo: raw.isDemo === true,
    completed,
    completedAt: completed && typeof raw.completedAt === 'string' ? raw.completedAt : null,
    sourceType,
    sourceDocument: normalizeDocument(raw.sourceDocument),
    extractionConfidence: CONFIDENCE_LEVELS.includes(raw.extractionConfidence)
      ? raw.extractionConfidence
      : null,
    userConfirmed: sourceType === 'manual' ? true : raw.userConfirmed === true,
    confirmedFields: Array.isArray(raw.confirmedFields)
      ? [...new Set(raw.confirmedFields.filter((field) => USER_FIELDS.includes(field)))]
      : [],
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
  };
}

/** Fields that hold a value a person actually supplied (used for `confirmedFields`). */
function suppliedFields(input) {
  return USER_FIELDS.filter((field) => {
    const value = input[field];
    if (value === null || value === undefined || value === '' || value === false) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

/**
 * Build a new assessment from validated input (see utils/validation.js).
 * Manual entries are confirmed by definition: the user typed every value.
 */
export function createAssessment(
  input,
  { now = new Date(), idFactory = createId, timeZone = DEFAULT_TIME_ZONE } = {},
) {
  const timestamp = now.toISOString();
  const sourceType = SOURCE_TYPES.includes(input.sourceType) ? input.sourceType : 'manual';
  const base = normalizeAssessment(
    {
      ...input,
      id: idFactory(),
      timeZone: input.timeZone ?? timeZone,
      sourceType,
      completed: input.completed === true,
      completedAt: input.completed === true ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    { idFactory },
  );
  if (!base) throw new TypeError('createAssessment needs a title and a valid due date');
  base.userConfirmed = sourceType === 'manual' ? true : input.userConfirmed === true;
  // Values the user saw and accepted in the import review count as confirmed too.
  base.confirmedFields = base.userConfirmed ? suppliedFields(base) : [];
  return base;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply user edits. Returns `{ assessment, changed }`; when nothing changed the
 * original object is returned so callers can skip a storage write.
 * Every field the user edits becomes "confirmed", which protects it from being
 * silently replaced by document extraction later.
 */
export function applyChanges(existing, changes, { now = new Date(), idFactory = createId } = {}) {
  const next = { ...existing };
  const changedFields = [];
  for (const field of USER_FIELDS) {
    if (!(field in changes)) continue;
    if (!sameValue(existing[field], changes[field])) {
      next[field] = changes[field];
      changedFields.push(field);
    }
  }
  if ('completed' in changes && changes.completed !== existing.completed) {
    next.completed = changes.completed === true;
    next.completedAt = next.completed ? now.toISOString() : null;
    changedFields.push('completed');
  }
  if (changedFields.length === 0) return { assessment: existing, changed: false };

  const normalized = normalizeAssessment(next, { idFactory });
  if (!normalized) throw new TypeError('Edits would leave the assessment without a title or date');
  normalized.updatedAt = now.toISOString();
  normalized.confirmedFields = [
    ...new Set([
      ...existing.confirmedFields,
      ...changedFields.filter((field) => USER_FIELDS.includes(field)),
    ]),
  ];
  return { assessment: normalized, changed: true };
}

export function setCompleted(existing, completed, options) {
  return applyChanges(existing, { completed }, options);
}

/** A stable key for grouping by module: the code when known, otherwise the name. */
export function moduleKey(assessment) {
  return assessment.moduleCode ?? assessment.moduleName ?? null;
}

export function moduleLabel(assessment) {
  if (assessment.moduleCode && assessment.moduleName) {
    return `${assessment.moduleCode} · ${assessment.moduleName}`;
  }
  return assessment.moduleCode ?? assessment.moduleName ?? null;
}
