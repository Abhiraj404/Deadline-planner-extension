import { describe, expect, it } from 'vitest';
import { createAssessment } from '../src/models/assessment.js';
import { normalizeSettings } from '../src/models/settings.js';
import {
  REFRESH_ALARM,
  alarmName,
  badgeFor,
  computeReminders,
  describeOffset,
  markFired,
  missedSummaryMessage,
  nextRefreshTime,
  parseAlarmName,
  planMissedReminders,
  pruneSnoozes,
  reminderMessage,
  reminderTime,
  snoozeAlarmName,
  syncAlarms,
} from '../src/services/reminders.js';
import { createAlarmsMock, sequentialIds } from './helpers/chrome-mock.js';

const now = new Date('2026-11-25T10:00:00Z');
const settings = normalizeSettings({});
const make = (input) => createAssessment(input, { now, idFactory: sequentialIds(input.title) });
const at = (iso) => Date.parse(iso);

describe('reminder times', () => {
  it('fires whole-day reminders for date-only deadlines at the configured time', () => {
    const item = make({ title: 'Essay', dueDate: '2026-12-11' });
    expect(reminderTime(item, 1440, settings)).toBe(at('2026-12-10T09:00:00Z'));
    expect(reminderTime(item, 10080, settings)).toBe(at('2026-12-04T09:00:00Z'));
    expect(reminderTime(item, 20160, settings)).toBe(at('2026-11-27T09:00:00Z'));
    const custom = normalizeSettings({ reminderTime: '18:30' });
    expect(reminderTime(item, 1440, custom)).toBe(at('2026-12-10T18:30:00Z'));
  });

  it('fires "on the deadline day" in the morning, or 30 minutes before an early deadline', () => {
    expect(reminderTime(make({ title: 'A', dueDate: '2026-12-11' }), 0, settings)).toBe(
      at('2026-12-11T09:00:00Z'),
    );
    expect(
      reminderTime(make({ title: 'B', dueDate: '2026-12-11', dueTime: '17:00' }), 0, settings),
    ).toBe(at('2026-12-11T09:00:00Z'));
    expect(
      reminderTime(make({ title: 'C', dueDate: '2026-12-11', dueTime: '08:00' }), 0, settings),
    ).toBe(at('2026-12-11T07:30:00Z'));
  });

  it('only uses "1 hour before" when a submission time is known', () => {
    expect(
      reminderTime(make({ title: 'Timed', dueDate: '2026-12-11', dueTime: '17:00' }), 60, settings),
    ).toBe(at('2026-12-11T16:00:00Z'));
    expect(
      reminderTime(make({ title: 'Date only', dueDate: '2026-12-11' }), 60, settings),
    ).toBeNull();
  });

  it('subtracts day offsets from timed deadlines', () => {
    const item = make({ title: 'Report', dueDate: '2026-12-11', dueTime: '17:00' });
    expect(reminderTime(item, 1440, settings)).toBe(at('2026-12-10T17:00:00Z'));
  });

  it('handles daylight saving: a week before a summer deadline crosses the clock change', () => {
    // 3 April 2027 17:00 IST (UTC+1); one week earlier is 27 March 17:00 GMT (UTC+0).
    const item = make({ title: 'Spring', dueDate: '2027-04-03', dueTime: '17:00' });
    expect(reminderTime(item, 0, settings)).toBe(at('2027-04-03T08:00:00Z'));
    expect(reminderTime(make({ title: 'Spring2', dueDate: '2027-04-03' }), 10080, settings)).toBe(
      at('2027-03-27T09:00:00Z'),
    );
  });

  it('does not depend on the computer time zone', () => {
    const previous = process.env.TZ;
    const item = make({ title: 'Essay', dueDate: '2026-12-11', dueTime: '17:00' });
    const results = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map((zone) => {
      process.env.TZ = zone;
      return computeReminders([item], settings, Number(now)).map((reminder) => reminder.when);
    });
    process.env.TZ = previous;
    expect(new Set(results.map(String)).size).toBe(1);
  });

  it('describes custom offsets', () => {
    expect(describeOffset(2880)).toBe('2 days before');
    expect(describeOffset(180)).toBe('3 hours before');
    expect(describeOffset(45)).toBe('45 minutes before');
    expect(describeOffset(20160)).toBe('14 days before');
  });
});

describe('computeReminders', () => {
  it('uses defaults, per-deadline overrides, and none when disabled', () => {
    const item = make({ title: 'Essay', dueDate: '2026-12-11' });
    expect(computeReminders([item], settings, Number(now)).map((r) => r.offset)).toEqual([
      10080, 1440,
    ]);
    const custom = make({ title: 'Own', dueDate: '2026-12-11', reminderOffsets: [4320, 0] });
    expect(computeReminders([custom], settings, Number(now)).map((r) => r.offset)).toEqual([
      4320, 0,
    ]);
    const off = make({ title: 'Off', dueDate: '2026-12-11', reminderOffsets: [] });
    expect(computeReminders([off], settings, Number(now))).toEqual([]);
    expect(
      computeReminders([item], normalizeSettings({ notificationsEnabled: false }), Number(now)),
    ).toEqual([]);
  });

  it('skips past reminders and completed deadlines', () => {
    const soon = make({ title: 'Soon', dueDate: '2026-11-27' });
    expect(computeReminders([soon], settings, Number(now)).map((r) => r.offset)).toEqual([1440]);
    expect(computeReminders([{ ...soon, completed: true }], settings, Number(now))).toEqual([]);
  });

  it('replaces reminders inside a snooze with one snooze reminder', () => {
    const item = make({ title: 'Essay', dueDate: '2026-11-27', reminderOffsets: [1440, 0] });
    const until = at('2026-11-26T12:00:00Z'); // after the 1-day reminder at 09:00
    const reminders = computeReminders([item], settings, Number(now), { [item.id]: until });
    expect(reminders.map((r) => [r.kind, r.name])).toEqual([
      ['snooze', snoozeAlarmName(item.id)],
      ['reminder', alarmName(item.id, 0)],
    ]);
  });

  it('is bounded to 400 alarms, soonest first', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      make({ title: `T${i}`, dueDate: '2027-01-15', reminderOffsets: [1440, 4320] }),
    );
    const reminders = computeReminders(many, settings, Number(now));
    expect(reminders).toHaveLength(400);
    expect(reminders[0].when).toBeLessThanOrEqual(reminders.at(-1).when);
  });
});

describe('missed reminders', () => {
  const items = [
    make({ title: 'Lab', dueDate: '2026-11-27' }), // 1-day reminder 26 Nov 09:00
    make({ title: 'Essay', dueDate: '2026-12-01' }), // 7-day reminder 24 Nov 09:00
    make({ title: 'Exam', dueDate: '2026-12-20' }),
  ];

  it('finds reminders that passed while the browser was closed, one per deadline', () => {
    const missed = planMissedReminders({
      assessments: items,
      settings,
      reminderState: { lastCheckedAt: at('2026-11-23T00:00:00Z'), fired: {}, snoozes: {} },
      now: at('2026-11-26T12:00:00Z'),
    });
    expect(missed.map((reminder) => reminder.assessmentId)).toEqual([items[1].id, items[0].id]);
  });

  it('ignores reminders already shown, very old ones, and a fresh install', () => {
    const base = { assessments: items, settings, now: at('2026-11-26T12:00:00Z') };
    const all = planMissedReminders({
      ...base,
      reminderState: { lastCheckedAt: at('2026-11-23T00:00:00Z'), fired: {} },
    });
    const fired = Object.fromEntries(all.map((reminder) => [reminder.key, 1]));
    expect(
      planMissedReminders({
        ...base,
        reminderState: { lastCheckedAt: at('2026-11-23T00:00:00Z'), fired },
      }),
    ).toEqual([]);
    expect(
      planMissedReminders({ ...base, reminderState: { lastCheckedAt: null, fired: {} } }),
    ).toEqual([]);
    // After a long absence only the last 3 days are considered.
    const old = planMissedReminders({
      ...base,
      reminderState: { lastCheckedAt: at('2026-01-01T00:00:00Z'), fired: {} },
    });
    expect(old.every((reminder) => reminder.when > at('2026-11-23T12:00:00Z'))).toBe(true);
  });

  it('leaves reminders from the last few minutes to their own alarm', () => {
    const missed = planMissedReminders({
      assessments: [items[0]],
      settings,
      reminderState: { lastCheckedAt: at('2026-11-26T08:00:00Z'), fired: {} },
      now: at('2026-11-26T09:05:00Z'),
    });
    expect(missed).toEqual([]);
  });

  it('summarises several missed reminders in one message', () => {
    const missed = items.map((item) => ({ assessmentId: item.id }));
    expect(missedSummaryMessage(missed, items).title).toBe('3 reminders while you were away');
    expect(missedSummaryMessage(missed, items).message).toMatch(/^Lab, Essay, Exam\./);
  });
});

describe('reminder state helpers', () => {
  it('records fired keys and prunes old ones', () => {
    const state = markFired({ fired: { old: 1 } }, ['new'], at('2026-11-26T00:00:00Z'));
    expect(Object.keys(state.fired)).toEqual(['new']);
  });

  it('drops finished snoozes and snoozes of completed or deleted deadlines', () => {
    const open = make({ title: 'Open', dueDate: '2026-12-01' });
    const done = { ...make({ title: 'Done', dueDate: '2026-12-01' }), completed: true };
    const snoozes = {
      [open.id]: Number(now) + 1000,
      [done.id]: Number(now) + 1000,
      gone: Number(now) + 1000,
      [`${open.id}x`]: 1,
    };
    expect(pruneSnoozes(snoozes, [open, done], Number(now))).toEqual({
      [open.id]: Number(now) + 1000,
    });
  });

  it('wakes at the next local midnight or the next timed deadline', () => {
    expect(nextRefreshTime([], settings, Number(now))).toBe(at('2026-11-26T00:01:00Z'));
    const today = make({ title: 'Today', dueDate: '2026-11-25', dueTime: '17:00' });
    expect(nextRefreshTime([today], settings, Number(now))).toBe(at('2026-11-25T17:01:00Z'));
  });
});

describe('alarms', () => {
  it('creates, keeps and clears only our alarms, including the refresh alarm', async () => {
    const alarms = createAlarmsMock();
    await alarms.create('unrelated', { when: 1 });
    await alarms.create('dr:gone:1440', { when: 5 });
    const desired = [
      { name: 'dr:a:1440', when: 1000 },
      { name: 'dr-snooze:b', when: 2000 },
    ];
    expect(await syncAlarms(alarms, desired, 3000)).toEqual({ created: 3, cleared: 1 });
    expect([...alarms.alarms.keys()].sort()).toEqual(
      [REFRESH_ALARM, 'dr-snooze:b', 'dr:a:1440', 'unrelated'].sort(),
    );
    expect(await syncAlarms(alarms, desired, 3000)).toEqual({ created: 0, cleared: 0 });
  });

  it('parses alarm names, including ids with colons', () => {
    expect(parseAlarmName(alarmName('a:b', 0))).toEqual({
      kind: 'reminder',
      assessmentId: 'a:b',
      offset: 0,
    });
    expect(parseAlarmName(snoozeAlarmName('x'))).toEqual({ kind: 'snooze', assessmentId: 'x' });
    expect(parseAlarmName(REFRESH_ALARM)).toEqual({ kind: 'refresh' });
    expect(parseAlarmName('someone-else')).toBeNull();
  });
});

describe('messages and badge', () => {
  it('writes short notification text', () => {
    const item = make({
      title: 'Report',
      dueDate: '2026-12-11',
      dueTime: '17:00',
      moduleCode: 'COMP3010',
    });
    expect(reminderMessage(item, 1440, 'en-GB').message).toBe('Due tomorrow at 17:00 · COMP3010');
    expect(reminderMessage(item, 60, 'en-GB').message).toBe('Due in 1 hour at 17:00 · COMP3010');
    expect(reminderMessage(make({ title: 'X', dueDate: '2026-12-11' }), 0).message).toBe(
      'Due today',
    );
  });

  it('shows the chosen count, urgency colour and a full text tooltip', () => {
    const summary = { upcoming: 5, dueSoon: 2, overdue: 1 };
    expect(badgeFor(summary, 'dueSoon')).toEqual({
      text: '2',
      color: '#c42b39',
      title: 'Deadline Reminder: 1 overdue, 2 due soon, 5 upcoming',
    });
    expect(badgeFor(summary, 'upcoming').text).toBe('5');
    expect(badgeFor(summary, 'off').text).toBe('');
    expect(badgeFor({ upcoming: 0, dueSoon: 0, overdue: 0 }, 'overdue').text).toBe('');
    expect(badgeFor({ upcoming: 120, dueSoon: 0, overdue: 0 }, 'upcoming').text).toBe('99+');
  });
});
