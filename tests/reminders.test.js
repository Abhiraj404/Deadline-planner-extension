import { describe, expect, it } from 'vitest';
import { createAssessment } from '../src/models/assessment.js';
import { normalizeSettings } from '../src/models/settings.js';
import { createAssessmentService } from '../src/services/assessments.js';
import {
  alarmName,
  computeReminders,
  parseAlarmName,
  reminderMessage,
  reminderTime,
  syncAlarms,
} from '../src/services/reminders.js';
import { createStorage } from '../src/services/storage.js';
import { createAlarmsMock, createMemoryStorageArea, sequentialIds } from './helpers/chrome-mock.js';

const now = new Date('2026-11-25T10:00:00Z');
const settings = normalizeSettings({});
const make = (input) => createAssessment(input, { now, idFactory: sequentialIds(input.title) });

describe('reminder times', () => {
  it('fires whole-day reminders for date-only deadlines at the reminder time', () => {
    const item = make({ title: 'Essay', dueDate: '2026-12-11' });
    // Thursday 10 December 09:00 Dublin time (GMT in winter).
    expect(reminderTime(item, 1440, settings)).toBe(Date.parse('2026-12-10T09:00:00Z'));
    expect(reminderTime(item, 10080, settings)).toBe(Date.parse('2026-12-04T09:00:00Z'));
    expect(reminderTime(item, 0, settings)).toBe(Date.parse('2026-12-11T09:00:00Z'));
  });

  it('subtracts the offset from timed deadlines', () => {
    const item = make({ title: 'Report', dueDate: '2026-12-11', dueTime: '17:00' });
    expect(reminderTime(item, 1440, settings)).toBe(Date.parse('2026-12-10T17:00:00Z'));
    expect(reminderTime(item, 120, settings)).toBe(Date.parse('2026-12-11T15:00:00Z'));
  });

  it('respects summer time in the deadline time zone', () => {
    const item = make({ title: 'Summer', dueDate: '2027-06-11', dueTime: '17:00' });
    expect(reminderTime(item, 0, settings)).toBe(Date.parse('2027-06-11T16:00:00Z'));
  });
});

describe('computeReminders', () => {
  it('uses the default offsets for a manual deadline with no custom reminders', () => {
    const item = make({ title: 'Essay', dueDate: '2026-12-11' });
    const reminders = computeReminders([item], settings, Number(now));
    expect(reminders.map((reminder) => reminder.offset)).toEqual([10080, 1440]);
    expect(reminders[0].name).toBe(alarmName(item.id, 10080));
  });

  it('uses per-deadline offsets when set', () => {
    const item = make({ title: 'Essay', dueDate: '2026-12-11', reminderOffsets: [4320, 0] });
    expect(computeReminders([item], settings, Number(now)).map((r) => r.offset)).toEqual([4320, 0]);
  });

  it('skips past reminders, completed deadlines and disabled notifications', () => {
    const soon = make({ title: 'Soon', dueDate: '2026-11-27' }); // 1 week before is in the past
    expect(computeReminders([soon], settings, Number(now)).map((r) => r.offset)).toEqual([1440]);
    const done = { ...make({ title: 'Done', dueDate: '2026-12-11' }), completed: true };
    expect(computeReminders([done], settings, Number(now))).toEqual([]);
    const off = normalizeSettings({ notificationsEnabled: false });
    expect(computeReminders([soon], off, Number(now))).toEqual([]);
  });

  it('returns reminders soonest first', () => {
    const later = make({ title: 'Later', dueDate: '2027-01-20' });
    const sooner = make({ title: 'Sooner', dueDate: '2026-12-20' });
    const reminders = computeReminders([later, sooner], settings, Number(now));
    expect(reminders.map((r) => r.when)).toEqual(
      [...reminders.map((r) => r.when)].sort((a, b) => a - b),
    );
  });
});

describe('syncAlarms', () => {
  it('creates missing alarms, keeps unchanged ones and clears stale ones', async () => {
    const alarms = createAlarmsMock();
    await alarms.create('unrelated', { when: 1 });
    await alarms.create('dr:gone:1440', { when: 5 });
    const desired = [
      { name: 'dr:a:1440', when: 1000 },
      { name: 'dr:b:0', when: 2000 },
    ];
    expect(await syncAlarms(alarms, desired)).toEqual({ created: 2, cleared: 1 });
    expect([...alarms.alarms.keys()].sort()).toEqual(['dr:a:1440', 'dr:b:0', 'unrelated']);
    // Running again with the same data does nothing.
    expect(await syncAlarms(alarms, desired)).toEqual({ created: 0, cleared: 0 });
  });

  it('reschedules automatically when a manual deadline date changes', async () => {
    const area = createMemoryStorageArea();
    const storage = createStorage(area);
    const service = createAssessmentService({
      storage,
      now: () => now,
      idFactory: sequentialIds(),
    });
    const alarms = createAlarmsMock();
    const reschedule = async () => {
      const state = await storage.getState();
      await syncAlarms(alarms, computeReminders(state.assessments, state.settings, Number(now)));
    };

    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    await reschedule();
    expect(alarms.alarms.get(alarmName(assessment.id, 1440)).scheduledTime).toBe(
      Date.parse('2026-12-10T09:00:00Z'),
    );

    await service.update(assessment.id, { dueDate: '2026-12-18' });
    await reschedule();
    expect(alarms.alarms.get(alarmName(assessment.id, 1440)).scheduledTime).toBe(
      Date.parse('2026-12-17T09:00:00Z'),
    );

    await service.setCompleted(assessment.id, true);
    await reschedule();
    expect(alarms.alarms.size).toBe(0);
  });
});

describe('alarm names and messages', () => {
  it('round-trips alarm names, including ids that contain colons', () => {
    expect(parseAlarmName(alarmName('abc', 1440))).toEqual({ assessmentId: 'abc', offset: 1440 });
    expect(parseAlarmName(alarmName('a:b', 0))).toEqual({ assessmentId: 'a:b', offset: 0 });
    expect(parseAlarmName('other-extension-alarm')).toBeNull();
  });

  it('writes a short notification message', () => {
    const item = make({
      title: 'Report',
      dueDate: '2026-12-11',
      dueTime: '17:00',
      moduleCode: 'COMP3010',
    });
    const message = reminderMessage(item, 1440, 'en-GB');
    expect(message.title).toBe('Report');
    expect(message.message).toBe('Due tomorrow at 17:00 · COMP3010');
    expect(reminderMessage(make({ title: 'X', dueDate: '2026-12-11' }), 10080).message).toBe(
      'Due in 1 week',
    );
  });
});
