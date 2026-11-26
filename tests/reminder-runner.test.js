/**
 * The service worker's reminder flow with mocked chrome.alarms, chrome.notifications
 * and chrome.action. These tests prove the scheduling logic; they do not prove that
 * the browser actually shows notifications (see DEVELOPMENT_STATUS.md).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MISSED_NOTIFICATION,
  NOTIFICATION_PREFIX,
  createReminderRunner,
} from '../src/background/reminder-runner.js';
import { createAssessmentService } from '../src/services/assessments.js';
import { createStorage } from '../src/services/storage.js';
import { REFRESH_ALARM, alarmName, snoozeAlarmName } from '../src/services/reminders.js';
import { createAlarmsMock, createMemoryStorageArea, sequentialIds } from './helpers/chrome-mock.js';

function createNotificationsMock() {
  const shown = new Map();
  const log = [];
  return {
    shown,
    log,
    async create(id, options) {
      shown.set(id, options);
      log.push({ id, ...options });
    },
    async clear(id) {
      shown.delete(id);
    },
  };
}

function createActionMock() {
  const state = {};
  return {
    state,
    setBadgeText: async ({ text }) => (state.text = text),
    setBadgeBackgroundColor: async ({ color }) => (state.color = color),
    setTitle: async ({ title }) => (state.title = title),
  };
}

const at = (iso) => Date.parse(iso);
let clock;
let storage;
let service;
let alarms;
let notifications;
let action;
let runner;
let opened;

beforeEach(async () => {
  clock = at('2026-11-25T10:00:00Z');
  storage = createStorage(createMemoryStorageArea());
  service = createAssessmentService({
    storage,
    now: () => new Date(clock),
    idFactory: sequentialIds(),
  });
  alarms = createAlarmsMock();
  notifications = createNotificationsMock();
  action = createActionMock();
  opened = [];
  runner = createReminderRunner({
    storage,
    alarms,
    notifications,
    action,
    iconUrl: 'icon.png',
    openTab: async (path) => opened.push(path),
    now: () => clock,
  });
  await storage.init();
});

const fire = (name) =>
  runner.handleAlarm({ name, scheduledTime: alarms.alarms.get(name).scheduledTime });

describe('scheduling', () => {
  it('schedules reminders and the refresh alarm, and updates the badge', async () => {
    const { assessment } = await service.create({ title: 'Lab report', dueDate: '2026-11-27' });
    await runner.reconcile();
    expect(alarms.alarms.has(alarmName(assessment.id, 1440))).toBe(true);
    expect(alarms.alarms.get(REFRESH_ALARM).scheduledTime).toBe(at('2026-11-26T00:01:00Z'));
    expect(action.state).toMatchObject({
      text: '1',
      title: 'Deadline Reminder: 1 due soon, 1 upcoming',
    });
  });

  it('reschedules when the deadline changes and cancels on completion and deletion', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    await runner.reconcile();
    const name = alarmName(assessment.id, 1440);
    expect(alarms.alarms.get(name).scheduledTime).toBe(at('2026-12-10T09:00:00Z'));

    await service.update(assessment.id, { dueDate: '2026-12-18' });
    await runner.reconcile();
    expect(alarms.alarms.get(name).scheduledTime).toBe(at('2026-12-17T09:00:00Z'));

    await service.setCompleted(assessment.id, true);
    await runner.reconcile();
    expect(alarms.alarms.has(name)).toBe(false);

    await service.setCompleted(assessment.id, false); // reopened: reminders come back
    await runner.reconcile();
    expect(alarms.alarms.has(name)).toBe(true);

    await service.remove(assessment.id);
    await runner.reconcile();
    expect([...alarms.alarms.keys()]).toEqual([REFRESH_ALARM]);
  });

  it('rebuilds alarms after a browser restart that lost them', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    await runner.reconcile();
    alarms.alarms.clear(); // alarms are not guaranteed to survive restarts or updates
    await runner.reconcile();
    expect(alarms.alarms.has(alarmName(assessment.id, 10080))).toBe(true);
  });
});

describe('firing', () => {
  it('shows a notification once, with actions, and records history', async () => {
    const { assessment } = await service.create({
      title: 'Lab report',
      dueDate: '2026-11-27',
      moduleCode: 'CHEM1',
    });
    await runner.reconcile();
    const name = alarmName(assessment.id, 1440);
    clock = alarms.alarms.get(name).scheduledTime + 2000;
    await fire(name);
    await fire(name); // a duplicate delivery must not notify again
    expect(notifications.log).toHaveLength(1);
    expect(notifications.log[0]).toMatchObject({
      id: `${NOTIFICATION_PREFIX}${assessment.id}`,
      title: 'Lab report',
      message: 'Due tomorrow · CHEM1',
      buttons: [{ title: 'Mark complete' }, { title: 'Snooze' }],
    });
    expect((await storage.getReminderState()).history[0]).toMatchObject({
      kind: 'reminder',
      title: 'Lab report',
    });
  });

  it('does not notify for completed or deleted deadlines', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-11-27' });
    await runner.reconcile();
    const name = alarmName(assessment.id, 1440);
    const scheduledTime = alarms.alarms.get(name).scheduledTime;
    await service.setCompleted(assessment.id, true);
    clock = scheduledTime + 1000;
    await runner.handleAlarm({ name, scheduledTime });
    await service.remove(assessment.id);
    await runner.handleAlarm({ name, scheduledTime });
    expect(notifications.log).toEqual([]);
  });

  it('marks a deadline complete from the notification', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-11-27' });
    await runner.handleButton(`${NOTIFICATION_PREFIX}${assessment.id}`, 0);
    expect((await service.get(assessment.id)).completed).toBe(true);
  });

  it('snoozes from the notification and reminds again later', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-11-27' });
    await runner.reconcile();
    await runner.handleButton(`${NOTIFICATION_PREFIX}${assessment.id}`, 1);
    expect((await storage.getReminderState()).snoozes[assessment.id]).toBe(clock + 60 * 60_000);
    await runner.reconcile();
    const name = snoozeAlarmName(assessment.id);
    expect(alarms.alarms.get(name).scheduledTime).toBe(clock + 60 * 60_000);
    clock += 60 * 60_000 + 1000;
    await fire(name);
    expect(notifications.log.at(-1).message).toMatch(/^Snoozed reminder/);
    expect((await storage.getReminderState()).snoozes[assessment.id]).toBeUndefined();
  });

  it('opens the deadline when the notification is clicked', async () => {
    await runner.handleClick(`${NOTIFICATION_PREFIX}abc`);
    expect(opened).toEqual(['dashboard/dashboard.html#deadline=abc']);
  });
});

describe('missed reminders after the browser was closed', () => {
  it('summarises several missed reminders in one notification, once', async () => {
    await service.create({ title: 'Lab', dueDate: '2026-11-27' });
    await service.create({ title: 'Essay', dueDate: '2026-11-28' });
    await runner.reconcile(); // lastCheckedAt = 25 Nov
    clock = at('2026-11-28T12:00:00Z'); // browser reopened three days later
    const result = await runner.reconcile();
    expect(result.missed).toBe(2);
    expect(notifications.log).toHaveLength(1);
    expect(notifications.log[0].id).toBe(MISSED_NOTIFICATION);
    await runner.reconcile();
    expect(notifications.log).toHaveLength(1); // no repeats
  });

  it('treats a very late alarm as missed rather than notifying as if on time', async () => {
    const { assessment } = await service.create({ title: 'Lab', dueDate: '2026-11-27' });
    await runner.reconcile();
    const name = alarmName(assessment.id, 1440);
    const scheduledTime = alarms.alarms.get(name).scheduledTime;
    clock = scheduledTime + 2 * 60 * 60_000; // computer was asleep
    await runner.handleAlarm({ name, scheduledTime });
    expect(notifications.log).toHaveLength(1);
    expect(notifications.log[0].message).toMatch(/missed while the browser was closed/);
  });

  it('reports nothing missed on a fresh install', async () => {
    await service.create({ title: 'Lab', dueDate: '2026-11-26' });
    clock = at('2026-11-26T12:00:00Z');
    expect((await runner.reconcile({ reportMissed: false })).missed).toBe(0);
    expect(notifications.log).toEqual([]);
  });
});

describe('badge modes', () => {
  it('follows the setting', async () => {
    await service.create({ title: 'Old', dueDate: '2026-11-20' });
    await service.create({ title: 'Later', dueDate: '2027-01-20' });
    await storage.saveSettings({ ...(await storage.getSettings()), badgeMode: 'overdue' });
    await runner.reconcile();
    expect(action.state.text).toBe('1');
    await storage.saveSettings({ ...(await storage.getSettings()), badgeMode: 'off' });
    await runner.reconcile();
    expect(action.state.text).toBe('');
  });
});
