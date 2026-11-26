/**
 * User preferences. Stored as one object under the `settings` key.
 * `normalizeSettings` always returns a complete, valid object, so callers never
 * need to handle missing keys from older versions.
 */

import { isValidTime, isValidTimeZone } from '../utils/dates.js';

export const DEFAULT_TIME_ZONE = 'Europe/Dublin';
export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const SORT_KEYS = Object.freeze(['deadline', 'title', 'priority']);
export const MAX_REMINDER_OFFSET_MINUTES = 60 * 24 * 60; // 60 days

export const BUILT_IN_CATEGORIES = Object.freeze([
  { id: 'assignment', label: 'Assignment' },
  { id: 'exam', label: 'Examination' },
  { id: 'presentation', label: 'Presentation' },
  { id: 'group-project', label: 'Group project' },
  { id: 'lab', label: 'Laboratory work' },
  { id: 'personal', label: 'Personal task' },
  { id: 'appointment', label: 'Appointment' },
  { id: 'other', label: 'Other' },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  timeZone: DEFAULT_TIME_ZONE,
  notificationsEnabled: true,
  /** Minutes before the deadline. Whole days fire at `reminderTime` for date-only deadlines. */
  defaultReminderOffsets: Object.freeze([10080, 1440]),
  reminderTime: '09:00',
  dueSoonDays: 3,
  defaultCategory: 'assignment',
  defaultPriority: 'medium',
  defaultSort: 'deadline',
  weekStartsOn: 1,
  customCategories: Object.freeze([]),
  /** Keep a copy of imported files in IndexedDB. Off by default: only metadata is kept. */
  retainDocumentFiles: false,
  /** Toolbar badge: 'dueSoon' | 'overdue' | 'upcoming' | 'off'. */
  badgeMode: 'dueSoon',
  /** Default snooze length from a notification, in minutes. */
  snoozeMinutes: 60,
  importLimits: Object.freeze({
    maxFileSizeMB: 20,
    maxPdfPages: 100,
    maxTextChars: 200_000,
    maxDocxExpandedMB: 50,
    maxBatchSize: 10,
  }),
});

/** Allowed range for each import limit: [minimum, maximum]. */
export const IMPORT_LIMIT_RANGES = Object.freeze({
  maxFileSizeMB: [1, 50],
  maxPdfPages: [1, 500],
  maxTextChars: [10_000, 1_000_000],
  maxDocxExpandedMB: [5, 200],
  maxBatchSize: [1, 50],
});

export function normalizeImportLimits(raw) {
  const limits = {};
  for (const [key, [min, max]] of Object.entries(IMPORT_LIMIT_RANGES)) {
    const value = Number(raw?.[key]);
    limits[key] =
      Number.isInteger(value) && value >= min && value <= max
        ? value
        : DEFAULT_SETTINGS.importLimits[key];
  }
  return limits;
}

export function slugifyCategory(label) {
  return String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function normalizeOffsets(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const offsets = new Set();
  for (const item of value) {
    const minutes = Number(item);
    if (Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_REMINDER_OFFSET_MINUTES) {
      offsets.add(minutes);
    }
  }
  return [...offsets].sort((a, b) => b - a).slice(0, 10);
}

function normalizeCustomCategories(value) {
  if (!Array.isArray(value)) return [];
  const builtInIds = new Set(BUILT_IN_CATEGORIES.map((category) => category.id));
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 40) : '';
    const id = typeof item?.id === 'string' ? slugifyCategory(item.id) : slugifyCategory(label);
    if (!label || !id || builtInIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label });
  }
  return result.slice(0, 50);
}

export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const customCategories = normalizeCustomCategories(input.customCategories);
  const categoryIds = new Set([
    ...BUILT_IN_CATEGORIES.map((category) => category.id),
    ...customCategories.map((category) => category.id),
  ]);
  const dueSoonDays = Number(input.dueSoonDays);
  return {
    theme: THEMES.includes(input.theme) ? input.theme : d.theme,
    timeZone: isValidTimeZone(input.timeZone) ? input.timeZone : d.timeZone,
    notificationsEnabled:
      typeof input.notificationsEnabled === 'boolean'
        ? input.notificationsEnabled
        : d.notificationsEnabled,
    defaultReminderOffsets: normalizeOffsets(
      input.defaultReminderOffsets,
      d.defaultReminderOffsets,
    ),
    reminderTime: isValidTime(input.reminderTime) ? input.reminderTime : d.reminderTime,
    dueSoonDays:
      Number.isInteger(dueSoonDays) && dueSoonDays >= 0 && dueSoonDays <= 60
        ? dueSoonDays
        : d.dueSoonDays,
    defaultCategory: categoryIds.has(input.defaultCategory)
      ? input.defaultCategory
      : d.defaultCategory,
    defaultPriority: ['low', 'medium', 'high'].includes(input.defaultPriority)
      ? input.defaultPriority
      : d.defaultPriority,
    defaultSort: SORT_KEYS.includes(input.defaultSort) ? input.defaultSort : d.defaultSort,
    weekStartsOn: input.weekStartsOn === 0 ? 0 : 1,
    retainDocumentFiles: input.retainDocumentFiles === true,
    badgeMode: ['dueSoon', 'overdue', 'upcoming', 'off'].includes(input.badgeMode)
      ? input.badgeMode
      : d.badgeMode,
    snoozeMinutes: [60, 180, 1440].includes(input.snoozeMinutes)
      ? input.snoozeMinutes
      : d.snoozeMinutes,
    importLimits: normalizeImportLimits(input.importLimits),
    customCategories,
  };
}

/** Built-in categories followed by the user's own. */
export function getCategories(settings) {
  return [...BUILT_IN_CATEGORIES, ...(settings?.customCategories ?? [])];
}

export function categoryLabel(categoryId, settings) {
  return getCategories(settings).find((category) => category.id === categoryId)?.label ?? 'Other';
}
