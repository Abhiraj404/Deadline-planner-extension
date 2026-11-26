/**
 * Deterministic date and time recognition for assessment briefs.
 *
 * Ported from the rules in the Python Deadline Planner (`assessment_extraction.py`)
 * and extended for the extension:
 *  - Numeric dates are read day-first (Irish/European). When the other reading is
 *    also possible (03/04/2027) the alternative is returned so a person can choose.
 *  - A missing year is never filled in. Possible years are offered as suggestions.
 *  - A weekday on its own ("due by Friday") is reported as a suggestion only.
 *  - Impossible dates (31/02/2027) are reported, never "corrected".
 *
 * Everything here is pure: text in, plain objects out.
 */

import { addDays, getZonedParts, toISODate, zonedDateTimeToEpoch } from '../utils/dates.js';

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const MONTH =
  '(?<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?' +
  '|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WEEKDAY =
  '(?:(?<weekday>mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?,?\\s+(?:the\\s+)?)?';
const ORDINAL = '(?:st|nd|rd|th)?';

/**
 * Each pattern yields day, month and an optional year. Overlaps are resolved later by
 * keeping the earliest, longest match (so "Friday 11 December 2026" wins over "11 December").
 */
const DATE_PATTERNS = [
  [
    'named_dmy',
    new RegExp(
      `\\b${WEEKDAY}(?<day>\\d{1,2})${ORDINAL}(?:\\s+of)?[\\s-]+${MONTH},?(?:[\\s-]+(?<year>\\d{4}))?\\b`,
      'gi',
    ),
  ],
  [
    'named_mdy',
    new RegExp(
      `\\b${WEEKDAY}${MONTH}\\s+(?<day>\\d{1,2})${ORDINAL},?(?:\\s+(?<year>\\d{4}))?\\b`,
      'gi',
    ),
  ],
  ['iso', /\b(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})\b/g],
  [
    'numeric',
    new RegExp(
      `\\b${WEEKDAY}(?<day>\\d{1,2})(?<sep>[/.-])(?<month>\\d{1,2})\\k<sep>(?<year>\\d{4}|\\d{2})(?![\\d.:/-]\\d)`,
      'gi',
    ),
  ],
];

/** 17:00, 17.00, 5pm, 6.pm, 5:30 p.m., 11:59 PM, noon, midday, midnight. */
const TIME_PATTERN =
  /\b(?:(?<hour>[01]?\d|2[0-3])[:.](?<minute>[0-5]\d)\s*(?<meridiem>[ap]\.?m\.?)?|(?<hour12>1[0-2]|0?[1-9])\s*\.?(?<meridiem12>[ap]\.?m\.?)|(?<word>midday|noon|midnight))(?!\w)/gi;

/** A year written after the time instead of the date: "16th December 5pm - 2027". */
const YEAR_AFTER_TIME =
  /^\s*(?:,|at|@)?\s*(?:(?:[01]?\d|2[0-3])[:.][0-5]\d\s*(?:[ap]\.?m\.?)?|(?:1[0-2]|0?[1-9])\s*\.?[ap]\.?m\.?)\s*[-–—,]?\s*(?<year>20\d{2})\b/i;

/** "by Friday", "this Friday", "next Monday": a weekday with no date after it. */
const WEEKDAY_ONLY =
  /\b(?:(?<relative>this|next)\s+)?(?<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?!,?\s+(?:the\s+)?\d)(?!\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/gi;

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function weekdayOf(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Years to suggest for a date written without one. The next occurrence after the
 * reference date comes first; years named elsewhere in the document are added too.
 * The caller must still ask the user: these are suggestions, never the value.
 */
export function suggestYears(month, day, referenceDate, documentYears = []) {
  const refYear = Number(referenceDate.slice(0, 4));
  const years = new Set([refYear, refYear + 1, ...documentYears]);
  // 29 February: add the next leap year so there is always a suggestion.
  for (let year = refYear; month === 2 && day === 29 && year <= refYear + 4; year += 1) {
    if (isRealDate(year, 2, 29)) {
      years.add(year);
      break;
    }
  }
  return [...years]
    .filter((year) => isRealDate(year, month, day))
    .map((year) => toISODate(year, month, day))
    .sort((a, b) => {
      const aFuture = a >= referenceDate;
      const bFuture = b >= referenceDate;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      return aFuture ? a.localeCompare(b) : b.localeCompare(a);
    })
    .slice(0, 3);
}

/**
 * Find explicit calendar dates in `text`.
 * @returns {{ dates: object[], invalid: object[] }}
 */
export function findDates(text, { referenceDate } = {}) {
  const found = [];
  const invalid = [];
  for (const [kind, pattern] of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const groups = match.groups;
      const month = /^\d+$/.test(groups.month)
        ? Number(groups.month)
        : MONTHS[groups.month.slice(0, 3).toLowerCase()];
      const day = Number(groups.day);
      let year = groups.year ? Number(groups.year) : null;
      const notes = [];
      let confidence = 'high';
      const alternatives = [];
      let yearAfterTime = false;
      if (year === null && kind.startsWith('named')) {
        const after = YEAR_AFTER_TIME.exec(text.slice(match.index + match[0].length));
        if (after) {
          year = Number(after.groups.year);
          yearAfterTime = true;
        }
      }

      if (groups.year && groups.year.length === 2) {
        year = 2000 + year;
        confidence = 'medium';
        notes.push('Two-digit year read as 20xx.');
      }
      if (kind === 'numeric' && day <= 12 && month <= 12 && day !== month) {
        // 03/04/2027 is 3 April in Ireland but 4 March in the United States.
        confidence = 'medium';
        notes.push('Numeric date read day/month/year (Irish format).');
        if (year !== null && isRealDate(year, day, month)) {
          alternatives.push({
            date: toISODate(year, day, month),
            reason: 'Month/day/year (US format)',
          });
        }
      }

      let value = null;
      let suggestions = [];
      if (year === null) {
        if (!isRealDate(2028, month, day)) {
          invalid.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
          continue;
        }
        confidence = 'low';
        notes.push('The year is not stated. Choose the correct year.');
        if (referenceDate) suggestions = suggestYears(month, day, referenceDate);
      } else if (!isRealDate(year, month, day)) {
        invalid.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
        continue;
      } else {
        value = toISODate(year, month, day);
        if (yearAfterTime) {
          confidence = 'medium';
          notes.push('The year was written after the time. Check it.');
        }
      }

      const weekday = groups.weekday?.toLowerCase();
      if (weekday) {
        const expectedDays = value ? [value] : suggestions;
        const matching = expectedDays.filter((date) =>
          WEEKDAY_NAMES[weekdayOf(date)].startsWith(weekday.slice(0, 3)),
        );
        if (value && matching.length === 0) {
          confidence = 'low';
          notes.push(`The weekday (${groups.weekday}) does not match this date.`);
        } else if (!value && matching.length > 0) {
          // The weekday narrows the missing year down; it is still only a suggestion.
          suggestions = [...matching, ...suggestions.filter((date) => !matching.includes(date))];
        }
      }

      found.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        value,
        yearMissing: year === null,
        confidence,
        notes,
        alternatives,
        suggestions,
      });
    }
  }
  // Keep the earliest, longest match where patterns overlap.
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const dates = [];
  for (const item of found) {
    if (dates.length && item.start < dates.at(-1).end) continue;
    dates.push(item);
  }
  return { dates, invalid };
}

/** Explicit years written anywhere in the text (used to suggest missing years). */
export function documentYears(dates) {
  return [
    ...new Set(dates.filter((item) => item.value).map((item) => Number(item.value.slice(0, 4)))),
  ];
}

function timeValue(groups) {
  if (groups.word) {
    const word = groups.word.toLowerCase();
    return word === 'midnight' ? { time: '23:59', midnight: true } : { time: '12:00' };
  }
  let hour = Number(groups.hour ?? groups.hour12);
  const minute = Number(groups.minute ?? 0);
  const meridiem = (groups.meridiem ?? groups.meridiem12 ?? '').toLowerCase().replaceAll('.', '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

/**
 * The closest time written within `window` characters of [start, end) on the same
 * line, ignoring text that is part of a date. Midnight becomes 23:59 with a note,
 * because "midnight on 4 December" usually means the end of that day.
 */
export function findNearbyTime(line, start, end, excluded = [], window = 40) {
  const from = Math.max(0, start - window);
  const slice = line.slice(from, Math.min(line.length, end + window));
  let best = null;
  TIME_PATTERN.lastIndex = 0;
  for (const match of slice.matchAll(TIME_PATTERN)) {
    const position = from + match.index;
    if (excluded.some((span) => position >= span.start && position < span.end)) continue;
    const parsed = timeValue(match.groups);
    if (!parsed) continue;
    const distance = position >= end ? position - end : start - (position + match[0].length);
    if (!best || distance < best.distance) best = { ...parsed, distance, text: match[0] };
  }
  return best;
}

/** Weekday-only mentions such as "Due by Friday at 5 PM". */
export function findWeekdayMentions(line) {
  WEEKDAY_ONLY.lastIndex = 0;
  return [...line.matchAll(WEEKDAY_ONLY)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    weekday: WEEKDAY_NAMES.indexOf(match.groups.weekday.toLowerCase()),
    relative: match.groups.relative?.toLowerCase() ?? null,
  }));
}

/** The next dates (after the reference date) that fall on `weekday`. */
export function nextWeekdays(weekday, referenceDate, count = 2) {
  const offset = (weekday - weekdayOf(referenceDate) + 7) % 7 || 7;
  return Array.from({ length: count }, (_, index) => addDays(referenceDate, offset + index * 7));
}

/**
 * Daylight-saving check. On the spring change 01:00–01:59 does not exist in Dublin;
 * on the autumn change 01:00–01:59 happens twice. Returns a note or null.
 */
export function daylightSavingNote(date, time, timeZone) {
  if (!date || !time || !timeZone) return null;
  const epoch = zonedDateTimeToEpoch(date, time, timeZone);
  const parts = getZonedParts(epoch, timeZone);
  const [hour, minute] = time.split(':').map(Number);
  if (parts.hour !== hour || parts.minute !== minute) {
    return `${time} does not exist on this day in ${timeZone} because the clocks go forward.`;
  }
  const hourLater = getZonedParts(epoch + 3_600_000, timeZone);
  const hourEarlier = getZonedParts(epoch - 3_600_000, timeZone);
  if (
    (hourLater.hour === hour && hourLater.minute === minute) ||
    (hourEarlier.hour === hour && hourEarlier.minute === minute)
  ) {
    return `${time} happens twice on this day in ${timeZone} because the clocks go back.`;
  }
  return null;
}
