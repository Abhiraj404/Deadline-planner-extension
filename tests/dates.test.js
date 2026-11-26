import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  formatDate,
  isValidISODate,
  isValidTime,
  monthGrid,
  parseISODate,
  todayInTimeZone,
  zonedDateTimeToEpoch,
} from '../src/utils/dates.js';

describe('date parsing', () => {
  it('accepts real calendar dates only', () => {
    expect(parseISODate('2026-12-11')).toEqual({ year: 2026, month: 12, day: 11 });
    expect(isValidISODate('2028-02-29')).toBe(true);
    expect(isValidISODate('2026-02-29')).toBe(false);
    expect(isValidISODate('2026-02-30')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('11/12/2026')).toBe(false);
    expect(isValidISODate('')).toBe(false);
    expect(isValidISODate(null)).toBe(false);
  });

  it('validates 24-hour times', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('9:00')).toBe(false);
    expect(isValidTime('17:60')).toBe(false);
  });
});

describe('calendar arithmetic', () => {
  it('adds days across month, year and DST boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    // Europe/Dublin clocks change on 29 March 2026; calendar maths must not care.
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-12-11', '2026-12-04')).toBe(-7);
  });

  it('builds a six-week month grid starting on the chosen weekday', () => {
    const grid = monthGrid(2026, 12, 1); // December 2026 starts on a Tuesday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-11-30'); // Monday
    expect(grid[1]).toBe('2026-12-01');
    const sundayGrid = monthGrid(2026, 12, 0);
    expect(sundayGrid[0]).toBe('2026-11-29');
  });
});

describe('time zones', () => {
  it("computes today's date in the given zone, not in UTC", () => {
    const lateEveningUtc = new Date('2026-11-25T23:30:00Z');
    expect(todayInTimeZone('Europe/Dublin', lateEveningUtc)).toBe('2026-11-25');
    expect(todayInTimeZone('Pacific/Auckland', lateEveningUtc)).toBe('2026-11-26');
    expect(todayInTimeZone('America/Los_Angeles', new Date('2026-11-26T02:00:00Z'))).toBe(
      '2026-11-25',
    );
  });

  it('converts Dublin wall-clock times in winter (GMT) and summer (IST)', () => {
    expect(zonedDateTimeToEpoch('2026-12-11', '17:00', 'Europe/Dublin')).toBe(
      Date.parse('2026-12-11T17:00:00Z'),
    );
    expect(zonedDateTimeToEpoch('2026-06-11', '17:00', 'Europe/Dublin')).toBe(
      Date.parse('2026-06-11T16:00:00Z'),
    );
    expect(zonedDateTimeToEpoch('2026-06-11', '09:00', 'America/New_York')).toBe(
      Date.parse('2026-06-11T13:00:00Z'),
    );
  });

  it('formats a date-only value without shifting it to the previous day', () => {
    // new Date('2026-12-11') would be 10 December in Los Angeles.
    expect(formatDate('2026-12-11', { day: 'numeric', month: 'long' }, 'en-IE')).toBe(
      '11 December',
    );
  });
});
