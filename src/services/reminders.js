/**
 * Reminder planning. Pure functions only: no chrome.* calls here.
 *
 * MV3 service workers stop when idle, so reminders cannot be timers in memory. Every
 * reminder is a named chrome.alarm. `computeReminders` works out the set of alarms
 * that *should* exist; `syncAlarms` makes the browser match it. Running it again with
 * unchanged data does nothing, so it is cheap to call after every change.
 *
 * Stable identifiers:
 *   alarm         dr:<deadline id>:<minutes before>      one per reminder
 *   snooze alarm  dr-snooze:<deadline id>                one per snoozed deadline
 *   refresh alarm dr-refresh                             next midnight or due time
 *   dedupe key    <deadline id>:<minutes>:<epoch ms>     changes when the date changes
 *
 * Browser alarms are not exact: Chrome may deliver them late, and nothing fires while
 * the browser (or computer) is closed. Late and missed reminders are summarised by
 * `planMissedReminders` instead of being sent one by one.
 */

import {
  addDays,
  formatTime,
  MS_PER_MINUTE,
  todayInTimeZone,
  zonedDateTimeToEpoch,
} from '../utils/dates.js';

export const ALARM_PREFIX = 'dr:';
export const SNOOZE_PREFIX = 'dr-snooze:';
export const REFRESH_ALARM = 'dr-refresh';
// Chrome allows 500 alarms per extension; keep headroom and schedule the soonest.
export const MAX_ALARMS = 400;
// An alarm that arrives more than this late is treated as missed (browser was closed
// or the computer was asleep) and goes into the missed-reminder summary.
export const LATE_AFTER_MS = 10 * MS_PER_MINUTE;
// Reminders missed longer ago than this are dropped silently.
export const MISSED_WINDOW_MS = 3 * 24 * 60 * MS_PER_MINUTE;
const FIRED_RETENTION_MS = 60 * 24 * 60 * MS_PER_MINUTE;
const HISTORY_LIMIT = 30;

export const REMINDER_PRESETS = Object.freeze([
  { minutes: 20160, label: '14 days before' },
  { minutes: 10080, label: '7 days before' },
  { minutes: 4320, label: '3 days before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 0, label: 'On the deadline day' },
  { minutes: 60, label: '1 hour before', needsTime: true },
]);

export const SNOOZE_OPTIONS = Object.freeze([
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 1440, label: '1 day' },
]);

export function describeOffset(minutes) {
  const preset = REMINDER_PRESETS.find((item) => item.minutes === minutes);
  if (preset) return preset.label;
  const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'} before`;
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

export function alarmName(assessmentId, offset) {
  return `${ALARM_PREFIX}${assessmentId}:${offset}`;
}

export function snoozeAlarmName(assessmentId) {
  return `${SNOOZE_PREFIX}${assessmentId}`;
}

/** Parse any of our alarm names. Returns null for alarms that are not ours. */
export function parseAlarmName(name) {
  if (name === REFRESH_ALARM) return { kind: 'refresh' };
  if (name.startsWith(SNOOZE_PREFIX)) {
    return { kind: 'snooze', assessmentId: name.slice(SNOOZE_PREFIX.length) };
  }
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const rest = name.slice(ALARM_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split === -1) return null;
  const offset = Number(rest.slice(split + 1));
  return Number.isInteger(offset)
    ? { kind: 'reminder', assessmentId: rest.slice(0, split), offset }
    : null;
}

export const reminderKey = (assessmentId, offset, when) => `${assessmentId}:${offset}:${when}`;

function dueInstant(assessment) {
  return zonedDateTimeToEpoch(
    assessment.dueDate,
    assessment.dueTime ?? '23:59',
    assessment.timeZone,
  );
}

/**
 * When a single reminder fires, or null if it does not apply.
 * - "On the deadline day" (0) fires at the reminder time on the due date. If the
 *   deadline itself is at or before that time, it fires 30 minutes before instead.
 * - Offsets under a day ("1 hour before") need a known submission time. Date-only
 *   deadlines have no official time, so these are skipped rather than invented.
 * - Whole-day offsets fire at the reminder time on that day for date-only deadlines,
 *   and the same time of day as the deadline when a time is known.
 */
export function reminderTime(assessment, offset, settings) {
  const { timeZone } = assessment;
  if (offset === 0) {
    const morning = zonedDateTimeToEpoch(assessment.dueDate, settings.reminderTime, timeZone);
    if (!assessment.dueTime) return morning;
    const due = dueInstant(assessment);
    return morning < due ? morning : due - 30 * MS_PER_MINUTE;
  }
  if (offset < 1440 && !assessment.dueTime) return null;
  if (!assessment.dueTime && offset % 1440 === 0) {
    return zonedDateTimeToEpoch(
      addDays(assessment.dueDate, -offset / 1440),
      settings.reminderTime,
      timeZone,
    );
  }
  return dueInstant(assessment) - offset * MS_PER_MINUTE;
}

/** The offsets that apply to one deadline: its own list, or the defaults. */
export function effectiveOffsets(assessment, settings) {
  return assessment.reminderOffsets ?? settings.defaultReminderOffsets;
}

/** Every reminder of every open deadline, with its time (past ones included). */
function allReminders(assessments, settings, snoozes = {}) {
  const reminders = [];
  for (const assessment of assessments) {
    if (assessment.completed) continue;
    const snoozedUntil = snoozes[assessment.id] ?? 0;
    for (const offset of effectiveOffsets(assessment, settings)) {
      const when = reminderTime(assessment, offset, settings);
      // Reminders that fall inside a snooze are replaced by the snooze reminder.
      if (when === null || when <= snoozedUntil) continue;
      reminders.push({
        name: alarmName(assessment.id, offset),
        when,
        assessmentId: assessment.id,
        offset,
        kind: 'reminder',
        key: reminderKey(assessment.id, offset, when),
      });
    }
    if (snoozedUntil) {
      reminders.push({
        name: snoozeAlarmName(assessment.id),
        when: snoozedUntil,
        assessmentId: assessment.id,
        offset: null,
        kind: 'snooze',
        key: reminderKey(assessment.id, 'snooze', snoozedUntil),
      });
    }
  }
  return reminders;
}

/** All future reminders for open deadlines, soonest first, bounded to MAX_ALARMS. */
export function computeReminders(assessments, settings, nowMs = Date.now(), snoozes = {}) {
  if (!settings.notificationsEnabled) return [];
  return allReminders(assessments, settings, snoozes)
    .filter((reminder) => reminder.when > nowMs)
    .sort((a, b) => a.when - b.when)
    .slice(0, MAX_ALARMS);
}

/**
 * Reminders that should have fired between `lastCheckedAt` and `now` but did not
 * (the browser was closed, or the alarm came late). Grouped to one entry per deadline
 * (the latest reminder wins) so a long absence cannot produce a flood of notices.
 */
export function planMissedReminders({ assessments, settings, reminderState, now }) {
  const { lastCheckedAt, fired = {}, snoozes = {} } = reminderState;
  if (!settings.notificationsEnabled || !lastCheckedAt) return [];
  const from = Math.max(lastCheckedAt, now - MISSED_WINDOW_MS);
  const byDeadline = new Map();
  for (const reminder of allReminders(assessments, settings, snoozes)) {
    // Reminders within the last few minutes are left to their own alarm, which Chrome
    // may simply deliver a little late.
    if (reminder.when <= from || reminder.when > now - LATE_AFTER_MS || fired[reminder.key])
      continue;
    const previous = byDeadline.get(reminder.assessmentId);
    if (!previous || reminder.when > previous.when) byDeadline.set(reminder.assessmentId, reminder);
  }
  return [...byDeadline.values()].sort((a, b) => a.when - b.when);
}

/** Return a copy of the reminder state with these keys marked as fired and old keys pruned. */
export function markFired(reminderState, keys, now) {
  const fired = {};
  for (const [key, at] of Object.entries(reminderState.fired ?? {})) {
    if (now - at < FIRED_RETENTION_MS) fired[key] = at;
  }
  for (const key of keys) fired[key] = now;
  return { ...reminderState, fired };
}

export function addHistory(reminderState, entries) {
  return {
    ...reminderState,
    history: [...entries, ...(reminderState.history ?? [])].slice(0, HISTORY_LIMIT),
  };
}

/** Remove snoozes that have ended or belong to deadlines that no longer need them. */
export function pruneSnoozes(snoozes, assessments, now) {
  const open = new Set(assessments.filter((item) => !item.completed).map((item) => item.id));
  const kept = {};
  for (const [id, until] of Object.entries(snoozes ?? {})) {
    if (open.has(id) && until > now) kept[id] = until;
  }
  return kept;
}

/**
 * When to wake up next even if no reminder is due: just after local midnight (so
 * "today", "overdue" and the badge roll over) or at the next timed deadline (so it
 * becomes overdue on time), whichever is sooner.
 */
export function nextRefreshTime(assessments, settings, nowMs = Date.now()) {
  const tomorrow = addDays(todayInTimeZone(settings.timeZone, new Date(nowMs)), 1);
  let next = zonedDateTimeToEpoch(tomorrow, '00:01', settings.timeZone);
  for (const assessment of assessments) {
    if (assessment.completed || !assessment.dueTime) continue;
    const due = dueInstant(assessment) + MS_PER_MINUTE;
    if (due > nowMs && due < next) next = due;
  }
  return next;
}

/**
 * Make chrome.alarms match `desired` plus the refresh alarm. Only touches our alarms.
 * @param {{ getAll: Function, create: Function, clear: Function }} alarmsApi
 */
export async function syncAlarms(alarmsApi, desired, refreshAt = null) {
  const ours = (name) =>
    name.startsWith(ALARM_PREFIX) || name.startsWith(SNOOZE_PREFIX) || name === REFRESH_ALARM;
  const existing = (await alarmsApi.getAll()).filter((alarm) => ours(alarm.name));
  const wanted = new Map(desired.map((reminder) => [reminder.name, reminder.when]));
  if (refreshAt) wanted.set(REFRESH_ALARM, refreshAt);
  let cleared = 0;
  let created = 0;

  for (const alarm of existing) {
    const when = wanted.get(alarm.name);
    // Alarms can drift by a few ms; anything within a second counts as unchanged.
    if (when !== undefined && Math.abs(alarm.scheduledTime - when) < 1000) {
      wanted.delete(alarm.name);
    } else {
      await alarmsApi.clear(alarm.name);
      cleared += 1;
    }
  }
  for (const [name, when] of wanted) {
    await alarmsApi.create(name, { when });
    created += 1;
  }
  return { created, cleared };
}

/** Notification text for a reminder. */
export function reminderMessage(assessment, offset, locale) {
  const time = assessment.dueTime ? ` at ${formatTime(assessment.dueTime, locale)}` : '';
  let when;
  if (offset === null) when = `Snoozed reminder · due ${assessment.dueDate}${time}`;
  else if (offset === 0) when = `Due today${time}`;
  else if (offset === 1440) when = `Due tomorrow${time}`;
  else when = `Due in ${describeOffset(offset).replace(' before', '')}${time}`;
  const module = assessment.moduleCode ?? assessment.moduleName;
  return { title: assessment.title, message: module ? `${when} · ${module}` : when };
}

/** One summary notification for several missed reminders. */
export function missedSummaryMessage(missed, assessments) {
  const titles = missed
    .map((reminder) => assessments.find((item) => item.id === reminder.assessmentId)?.title)
    .filter(Boolean);
  const shown = titles.slice(0, 4).join(', ');
  const more = titles.length > 4 ? ` and ${titles.length - 4} more` : '';
  return {
    title: `${titles.length} reminders while you were away`,
    message: `${shown}${more}. Open Deadline Reminder to check them.`,
  };
}

// ------------------------------------------------------------------ badge

export const BADGE_MODES = Object.freeze({
  off: 'No badge',
  upcoming: 'Upcoming deadlines',
  dueSoon: 'Due soon',
  overdue: 'Overdue',
});

/**
 * Toolbar badge for a summary from services/query.js `summarize`. The colour shows
 * urgency, and the tooltip always spells everything out in words, so colour is never
 * the only signal.
 */
export function badgeFor(summary, mode) {
  const parts = [];
  if (summary.overdue) parts.push(`${summary.overdue} overdue`);
  if (summary.dueSoon) parts.push(`${summary.dueSoon} due soon`);
  parts.push(`${summary.upcoming} upcoming`);
  const title = `Deadline Reminder: ${parts.join(', ')}`;
  const count =
    { upcoming: summary.upcoming, dueSoon: summary.dueSoon, overdue: summary.overdue }[mode] ?? 0;
  const text = mode === 'off' || count === 0 ? '' : count > 99 ? '99+' : String(count);
  const color =
    summary.overdue && mode !== 'upcoming'
      ? '#c42b39'
      : mode === 'upcoming'
        ? '#5a4de6'
        : '#9a5700';
  return { text, color, title };
}
