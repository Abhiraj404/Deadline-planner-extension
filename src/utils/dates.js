/**
 * Date helpers.
 *
 * Deadlines are stored as a calendar date ("YYYY-MM-DD") plus an optional wall-clock
 * time ("HH:MM") and an IANA time zone. We never pass a date-only string to
 * `new Date("2026-12-11")`, because JavaScript reads that as UTC midnight and it can
 * show up as the previous day in time zones west of UTC. Calendar arithmetic is done
 * on UTC day numbers instead, and time zones are applied only when a real instant is
 * needed (for example, when a reminder should fire).
 */

export const MS_PER_DAY = 86_400_000;
export const MS_PER_MINUTE = 60_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_24H = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse "YYYY-MM-DD" into numbers, rejecting impossible dates such as 2026-02-30. */
export function parseISODate(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // A round trip catches overflow: Date.UTC(2026, 1, 30) silently becomes 2 March.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function isValidISODate(value) {
  return parseISODate(value) !== null;
}

export function isValidTime(value) {
  return typeof value === 'string' && TIME_24H.test(value);
}

export function toISODate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function utcDayNumber(isoDate) {
  const parts = parseISODate(isoDate);
  if (!parts) throw new RangeError(`Invalid ISO date: ${isoDate}`);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function isoFromUtcMs(ms) {
  const date = new Date(ms);
  return toISODate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(isoDate, days) {
  return isoFromUtcMs(utcDayNumber(isoDate) + days * MS_PER_DAY);
}

/** Whole calendar days from `fromDate` to `toDate` (negative when `toDate` is earlier). */
export function daysBetween(fromDate, toDate) {
  return Math.round((utcDayNumber(toDate) - utcDayNumber(fromDate)) / MS_PER_DAY);
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function listTimeZones() {
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone');
  }
  return ['Europe/Dublin', 'Europe/London', 'UTC'];
}

// Intl.DateTimeFormat construction is comparatively slow, so formatters are reused.
const partsFormatters = new Map();

function partsFormatter(timeZone) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock date and time in `timeZone` at the instant `epochMs`. */
export function getZonedParts(epochMs, timeZone) {
  const values = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Today's calendar date in `timeZone`, as "YYYY-MM-DD". */
export function todayInTimeZone(timeZone, now = new Date()) {
  const parts = getZonedParts(Number(now), timeZone);
  return toISODate(parts.year, parts.month, parts.day);
}

function offsetMs(epochMs, timeZone) {
  const p = getZonedParts(epochMs, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Convert a wall-clock date and time in `timeZone` into an epoch timestamp.
 * The offset is computed twice because the first guess can land on the other side
 * of a daylight-saving change.
 */
export function zonedDateTimeToEpoch(isoDate, time, timeZone) {
  const { year, month, day } = parseISODate(isoDate) ?? {};
  if (year === undefined) throw new RangeError(`Invalid ISO date: ${isoDate}`);
  const [hours, minutes] = (time ?? '00:00').split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hours, minutes);
  const firstGuess = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(firstGuess, timeZone);
}

const displayFormatters = new Map();

function displayFormatter(locale, options) {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = displayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    displayFormatters.set(key, formatter);
  }
  return formatter;
}

/** Format a calendar date without any time-zone shift. */
export function formatDate(
  isoDate,
  options = { weekday: 'short', day: 'numeric', month: 'short' },
  locale,
) {
  return displayFormatter(locale, { ...options, timeZone: 'UTC' }).format(utcDayNumber(isoDate));
}

/** Format "HH:MM" for display in the user's locale (for example "5:00 pm" or "17:00"). */
export function formatTime(time, locale) {
  const [hours, minutes] = time.split(':').map(Number);
  return displayFormatter(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
    Date.UTC(2000, 0, 1, hours, minutes),
  );
}

export function formatInstant(epochMs, timeZone, locale) {
  return displayFormatter(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(epochMs);
}

/** 42 ISO dates (six weeks) covering the given month, starting on `weekStartsOn` (0 = Sunday). */
export function monthGrid(year, month, weekStartsOn = 1) {
  const first = toISODate(year, month, 1);
  const weekday = new Date(utcDayNumber(first)).getUTCDay();
  const start = addDays(first, -((weekday - weekStartsOn + 7) % 7));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
