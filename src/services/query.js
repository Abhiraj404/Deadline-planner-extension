/**
 * Pure helpers for deciding what the UI shows: deadline state (overdue, due soon),
 * filtering, sorting, summaries and grouping. No DOM and no storage here.
 */

import { PRIORITY_RANK, moduleKey, moduleLabel } from '../models/assessment.js';
import { DEFAULT_TIME_ZONE } from '../models/settings.js';
import { daysBetween, todayInTimeZone, zonedDateTimeToEpoch } from '../utils/dates.js';

/**
 * Work out how a deadline relates to `now`.
 * - Date-only deadlines are due at the end of that day in their own time zone, so a
 *   deadline "today" is not overdue until tomorrow.
 * - Timed deadlines become overdue the minute the time passes.
 */
export function getDeadlineState(assessment, { now = new Date(), dueSoonDays = 3 } = {}) {
  const timeZone = assessment.timeZone || DEFAULT_TIME_ZONE;
  const today = todayInTimeZone(timeZone, now);
  const daysRemaining = daysBetween(today, assessment.dueDate);

  let overdue = false;
  if (!assessment.completed) {
    overdue = assessment.dueTime
      ? Number(now) > zonedDateTimeToEpoch(assessment.dueDate, assessment.dueTime, timeZone)
      : daysRemaining < 0;
  }
  const dueSoon = !assessment.completed && !overdue && daysRemaining <= dueSoonDays;

  let tone = 'normal';
  if (assessment.completed) tone = 'done';
  else if (overdue) tone = 'overdue';
  else if (daysRemaining <= 1) tone = 'urgent';
  else if (dueSoon) tone = 'soon';

  return {
    today,
    daysRemaining,
    overdue,
    dueSoon,
    tone,
    label: stateLabel(assessment, daysRemaining, overdue),
  };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function stateLabel(assessment, days, overdue) {
  if (assessment.completed) return 'Done';
  if (overdue) return days >= 0 ? 'Overdue' : `${plural(-days, 'day')} overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `${plural(days, 'day')} left`;
  const weeks = Math.floor(days / 7);
  return `${plural(weeks, 'week')} left`;
}

/** Sortable key: date then time; date-only deadlines sort as end of day. */
export function deadlineKey(assessment) {
  return `${assessment.dueDate}T${assessment.dueTime ?? '23:59'}`;
}

// Lower-cased search text is cached per record object; records are immutable,
// so an edited deadline is a new object and gets a fresh entry.
const searchCache = new WeakMap();

function searchText(assessment) {
  let value = searchCache.get(assessment);
  if (value === undefined) {
    value = [
      assessment.title,
      assessment.moduleName,
      assessment.moduleCode,
      assessment.category,
      assessment.description,
      assessment.notes,
      assessment.sourceDocument?.name,
      ...assessment.tags,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    searchCache.set(assessment, value);
  }
  return value;
}

/** Every word in the query must appear somewhere in the record. */
export function matchesSearch(assessment, query) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = searchText(assessment);
  return terms.every((term) => haystack.includes(term));
}

/**
 * @param {object[]} assessments
 * @param {object} filters
 * @param {'open'|'upcoming'|'overdue'|'completed'|'all'} [filters.status]
 *   open = not completed (overdue included); upcoming = open and not overdue
 * @param {string} [filters.search]
 * @param {string|null} [filters.module] a moduleKey, or '__none__' for no module
 * @param {'manual'|'pdf'|'docx'|null} [filters.source]
 * @param {string|null} [filters.category]
 */
export function filterAssessments(assessments, filters = {}, context = {}) {
  const { status = 'all', search = '', module = null, source = null, category = null } = filters;
  return assessments.filter((assessment) => {
    if (source && assessment.sourceType !== source) return false;
    if (category && assessment.category !== category) return false;
    if (module) {
      const key = moduleKey(assessment);
      if (module === '__none__' ? key !== null : key !== module) return false;
    }
    if (status !== 'all') {
      if (status === 'completed' && !assessment.completed) return false;
      if (status !== 'completed') {
        if (assessment.completed) return false;
        if (status !== 'open') {
          const { overdue } = getDeadlineState(assessment, context);
          if (status === 'overdue' && !overdue) return false;
          if (status === 'upcoming' && overdue) return false;
        }
      }
    }
    return matchesSearch(assessment, search);
  });
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const COMPARATORS = {
  deadline: (a, b) =>
    deadlineKey(a).localeCompare(deadlineKey(b)) || collator.compare(a.title, b.title),
  title: (a, b) =>
    collator.compare(a.title, b.title) || deadlineKey(a).localeCompare(deadlineKey(b)),
  priority: (a, b) =>
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
    deadlineKey(a).localeCompare(deadlineKey(b)),
};

/** Returns a new sorted array. Completed lists read best newest-first, so pass `descending`. */
export function sortAssessments(assessments, sortKey = 'deadline', { descending = false } = {}) {
  const compare = COMPARATORS[sortKey] ?? COMPARATORS.deadline;
  const sorted = assessments.slice().sort(compare);
  return descending ? sorted.reverse() : sorted;
}

/** Counts for the popup header plus the next open deadline. */
export function summarize(assessments, context = {}) {
  let upcoming = 0;
  let dueSoon = 0;
  let overdue = 0;
  let completed = 0;
  let next = null;
  for (const assessment of assessments) {
    if (assessment.completed) {
      completed += 1;
      continue;
    }
    const state = getDeadlineState(assessment, context);
    if (state.overdue) {
      overdue += 1;
      continue;
    }
    upcoming += 1;
    if (state.dueSoon) dueSoon += 1;
    if (!next || deadlineKey(assessment) < deadlineKey(next)) next = assessment;
  }
  return { upcoming, dueSoon, overdue, completed, total: assessments.length, next };
}

/** Distinct modules for a filter menu, with counts of open deadlines. */
export function listModules(assessments) {
  const modules = new Map();
  for (const assessment of assessments) {
    const key = moduleKey(assessment);
    if (!key) continue;
    const entry = modules.get(key) ?? { key, label: moduleLabel(assessment), open: 0, total: 0 };
    entry.total += 1;
    if (!assessment.completed) entry.open += 1;
    modules.set(key, entry);
  }
  return [...modules.values()].sort((a, b) => collator.compare(a.label, b.label));
}

/**
 * Group an already-sorted list into agenda sections: overdue first, then one
 * section per due date.
 */
export function groupForAgenda(assessments, context = {}) {
  const groups = [];
  const overdue = [];
  const byDate = new Map();
  for (const assessment of assessments) {
    const state = getDeadlineState(assessment, context);
    if (state.overdue) {
      overdue.push(assessment);
      continue;
    }
    if (!byDate.has(assessment.dueDate)) byDate.set(assessment.dueDate, []);
    byDate.get(assessment.dueDate).push(assessment);
  }
  if (overdue.length > 0) groups.push({ key: 'overdue', date: null, items: overdue });
  for (const [date, items] of byDate) groups.push({ key: date, date, items });
  return groups;
}
