/**
 * Validation for deadline input from forms and backups.
 *
 * `validateAssessmentInput` takes loosely typed values (strings from <input>s) and
 * returns either field-level error messages or a clean value object ready for
 * `createAssessment` / `applyChanges`. Empty optional fields become `null`.
 */

import { isValidISODate, isValidTime, isValidTimeZone } from './dates.js';
import {
  PRIORITIES,
  RELATED_DATE_LABELS,
  normalizeChecklist,
  normalizeRelatedDates,
  normalizeTags,
  normalizeTextList,
} from '../models/assessment.js';
import { MAX_REMINDER_OFFSET_MINUTES } from '../models/settings.js';

const LIMITS = Object.freeze({
  title: 200,
  moduleName: 120,
  submissionMethod: 200,
  wordCount: 80,
  groupSize: 80,
  moduleCode: 30,
  description: 5000,
  notes: 5000,
  submissionUrl: 2048,
});

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function optionalText(value) {
  const trimmed = text(value);
  return trimmed === '' ? null : trimmed;
}

export function isSafeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * @param {object} input raw values; any key may be missing
 * @param {object} [options]
 * @param {string[]} [options.categoryIds] allowed category ids; skipped when omitted
 * @returns {{ valid: boolean, errors: Record<string, string>, value: object }}
 */
export function validateAssessmentInput(input = {}, { categoryIds } = {}) {
  const errors = {};
  const value = {};

  const title = text(input.title);
  if (!title) errors.title = 'Enter a title.';
  else if (title.length > LIMITS.title)
    errors.title = `Keep the title under ${LIMITS.title} characters.`;
  value.title = title;

  const dueDate = text(input.dueDate);
  if (!dueDate) errors.dueDate = 'Choose a due date.';
  else if (!isValidISODate(dueDate)) errors.dueDate = 'Enter a real date (YYYY-MM-DD).';
  else {
    const year = Number(dueDate.slice(0, 4));
    if (year < 1970 || year > 2100) errors.dueDate = 'Choose a year between 1970 and 2100.';
  }
  value.dueDate = dueDate;

  const dueTime = optionalText(input.dueTime);
  if (dueTime !== null && !isValidTime(dueTime))
    errors.dueTime = 'Use a 24-hour time such as 17:00.';
  value.dueTime = dueTime;

  if (input.timeZone !== undefined && input.timeZone !== null) {
    if (!isValidTimeZone(input.timeZone)) errors.timeZone = 'Choose a valid time zone.';
    else value.timeZone = input.timeZone;
  }

  for (const field of [
    'moduleName',
    'moduleCode',
    'description',
    'notes',
    'submissionMethod',
    'wordCount',
    'groupSize',
  ]) {
    const fieldValue = optionalText(input[field]);
    if (fieldValue !== null && fieldValue.length > LIMITS[field]) {
      errors[field] = `Keep this under ${LIMITS[field]} characters.`;
    }
    value[field] = fieldValue;
  }

  const category = optionalText(input.category) ?? 'assignment';
  if (categoryIds && !categoryIds.includes(category)) errors.category = 'Choose a category.';
  value.category = category;

  const weightingText = optionalText(input.weighting);
  if (weightingText === null) value.weighting = null;
  else {
    const weighting = Number(String(weightingText).replace(/%$/, ''));
    if (!Number.isFinite(weighting) || weighting < 0 || weighting > 100) {
      errors.weighting = 'Weighting must be a percentage from 0 to 100.';
    }
    value.weighting = Number.isFinite(weighting) ? Math.round(weighting * 100) / 100 : null;
  }

  const priority = optionalText(input.priority) ?? 'medium';
  if (!PRIORITIES.includes(priority)) errors.priority = 'Choose low, medium or high.';
  value.priority = priority;

  const submissionUrl = optionalText(input.submissionUrl);
  if (submissionUrl !== null) {
    if (submissionUrl.length > LIMITS.submissionUrl || !isSafeHttpUrl(submissionUrl)) {
      errors.submissionUrl = 'Enter a full web address starting with https://';
    }
  }
  value.submissionUrl = submissionUrl;

  const estimate = input.estimatedMinutes;
  if (estimate === null || estimate === undefined || estimate === '') value.estimatedMinutes = null;
  else {
    const minutes = Number(estimate);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60_000) {
      errors.estimatedMinutes = 'Estimated time must be between 1 minute and 1,000 hours.';
    }
    value.estimatedMinutes = Number.isFinite(minutes) ? minutes : null;
  }

  if (input.reminderOffsets === null || input.reminderOffsets === undefined) {
    value.reminderOffsets = null;
  } else if (!Array.isArray(input.reminderOffsets)) {
    errors.reminderOffsets = 'Choose when to be reminded.';
  } else {
    const invalid = input.reminderOffsets.some(
      (offset) => !Number.isInteger(offset) || offset < 0 || offset > MAX_REMINDER_OFFSET_MINUTES,
    );
    if (invalid) errors.reminderOffsets = 'Reminders can be at most 60 days before the deadline.';
    value.reminderOffsets = [...new Set(input.reminderOffsets)].sort((a, b) => b - a);
  }

  value.tags = normalizeTags(input.tags ?? []);
  value.checklist = normalizeChecklist(input.checklist ?? []);
  value.instructions = normalizeTextList(input.instructions ?? []);
  value.markingCriteria = normalizeTextList(input.markingCriteria ?? []);

  const relatedDates = Array.isArray(input.relatedDates) ? input.relatedDates : [];
  const badDate = relatedDates.find(
    (item) =>
      !isValidISODate(item?.date) ||
      (item.time && !isValidTime(item.time)) ||
      (item.label && !Object.hasOwn(RELATED_DATE_LABELS, item.label)),
  );
  if (badDate)
    errors.relatedDates = 'Each related date needs a real date (and a valid time if given).';
  value.relatedDates = normalizeRelatedDates(relatedDates);

  if (input.completed !== undefined) value.completed = input.completed === true;

  return { valid: Object.keys(errors).length === 0, errors, value };
}
