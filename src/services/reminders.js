/**
 * Reminder scheduling with chrome.alarms.
 *
 * MV3 service workers stop when idle, so reminders cannot be timers in memory.
 * Instead every reminder is a named chrome.alarm. `computeReminders` works out the
 * full set of alarms that *should* exist; `syncAlarms` adds and removes alarms so the
 * browser matches that set. Running it again with unchanged data does nothing, which
 * keeps it cheap to call after every storage change.
 */

import { addDays, formatTime, MS_PER_MINUTE, zonedDateTimeToEpoch } from '../utils/dates.js';

export const ALARM_PREFIX = 'dr:';
// Chrome caps an extension at 500 alarms; keep headroom and schedule the soonest.
export const MAX_ALARMS = 400;

export const REMINDER_PRESETS = Object.freeze([
  { minutes: 20160, label: '2 weeks before' },
  { minutes: 10080, label: '1 week before' },
  { minutes: 4320, label: '3 days before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 0, label: 'On the day' },
]);

export function describeOffset(minutes) {
  const preset = REMINDER_PRESETS.find((item) => item.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return `${minutes / 60} hours before`;
  return `${minutes} minutes before`;
}

export function alarmName(assessmentId, offset) {
  return `${ALARM_PREFIX}${assessmentId}:${offset}`;
}

export function parseAlarmName(name) {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const rest = name.slice(ALARM_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split === -1) return null;
  const offset = Number(rest.slice(split + 1));
  return Number.isInteger(offset) ? { assessmentId: rest.slice(0, split), offset } : null;
}

/**
 * When a single reminder fires.
 * - Whole-day offsets on a date-only deadline fire at the user's reminder time
 *   (default 09:00) on that day, e.g. "1 day before" a Friday deadline is Thursday 09:00.
 * - Otherwise the offset is subtracted from the due instant. A date-only deadline is
 *   treated as due at 23:59 for this purpose.
 */
export function reminderTime(assessment, offset, settings) {
  const { timeZone } = assessment;
  if (!assessment.dueTime && offset % 1440 === 0) {
    const day = addDays(assessment.dueDate, -offset / 1440);
    return zonedDateTimeToEpoch(day, settings.reminderTime, timeZone);
  }
  const due = zonedDateTimeToEpoch(assessment.dueDate, assessment.dueTime ?? '23:59', timeZone);
  return due - offset * MS_PER_MINUTE;
}

/** The offsets that apply to one deadline: its own list, or the defaults. */
export function effectiveOffsets(assessment, settings) {
  return assessment.reminderOffsets ?? settings.defaultReminderOffsets;
}

/** All future reminders for open deadlines, soonest first. */
export function computeReminders(assessments, settings, nowMs = Date.now()) {
  if (!settings.notificationsEnabled) return [];
  const reminders = [];
  for (const assessment of assessments) {
    if (assessment.completed) continue;
    for (const offset of effectiveOffsets(assessment, settings)) {
      const when = reminderTime(assessment, offset, settings);
      if (when > nowMs) {
        reminders.push({
          name: alarmName(assessment.id, offset),
          when,
          assessmentId: assessment.id,
          offset,
        });
      }
    }
  }
  return reminders.sort((a, b) => a.when - b.when).slice(0, MAX_ALARMS);
}

/**
 * Make chrome.alarms match `desired`. Only touches alarms with our prefix.
 * @param {{ getAll: Function, create: Function, clear: Function }} alarmsApi
 */
export async function syncAlarms(alarmsApi, desired) {
  const existing = (await alarmsApi.getAll()).filter((alarm) =>
    alarm.name.startsWith(ALARM_PREFIX),
  );
  const wanted = new Map(desired.map((reminder) => [reminder.name, reminder]));
  let cleared = 0;
  let created = 0;

  for (const alarm of existing) {
    const target = wanted.get(alarm.name);
    // Alarms can drift by a few ms; anything within a second counts as unchanged.
    if (target && Math.abs(alarm.scheduledTime - target.when) < 1000) {
      wanted.delete(alarm.name);
    } else {
      await alarmsApi.clear(alarm.name);
      cleared += 1;
    }
  }
  for (const reminder of wanted.values()) {
    await alarmsApi.create(reminder.name, { when: reminder.when });
    created += 1;
  }
  return { created, cleared };
}

/** Notification text for a reminder. */
export function reminderMessage(assessment, offset, locale) {
  const time = assessment.dueTime ? ` at ${formatTime(assessment.dueTime, locale)}` : '';
  let when;
  if (offset === 0) when = assessment.dueTime ? `Due now${time}` : 'Due today';
  else if (offset === 1440) when = `Due tomorrow${time}`;
  else when = `Due in ${describeOffset(offset).replace(' before', '')}${time}`;
  const module = assessment.moduleCode ?? assessment.moduleName;
  return {
    title: assessment.title,
    message: module ? `${when} · ${module}` : when,
  };
}
