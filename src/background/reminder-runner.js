/**
 * Reminder orchestration for the service worker.
 *
 * Every Chrome API is passed in (`alarms`, `notifications`, `action`, `openTab`) so the
 * whole flow can be unit-tested with mocks. Nothing is kept in memory between events:
 * each handler reads storage, acts, and writes back, which is what MV3 requires
 * because the worker can be stopped at any time.
 *
 * Duplicate protection:
 *  - each reminder has a key (deadline id + offset + time); fired keys are stored, so
 *    an alarm that fires twice, or a reminder also found by the missed-reminder check,
 *    notifies only once;
 *  - one notification id per deadline (`dr-n:<id>`), so a newer reminder replaces an
 *    older one on screen instead of stacking.
 */

import { createAssessmentService } from '../services/assessments.js';
import { summarize } from '../services/query.js';
import {
  LATE_AFTER_MS,
  addHistory,
  badgeFor,
  computeReminders,
  markFired,
  missedSummaryMessage,
  nextRefreshTime,
  parseAlarmName,
  planMissedReminders,
  pruneSnoozes,
  reminderKey,
  reminderMessage,
  reminderTime,
  syncAlarms,
} from '../services/reminders.js';

export const NOTIFICATION_PREFIX = 'dr-n:';
export const MISSED_NOTIFICATION = 'dr-missed';
const BUTTONS = [{ title: 'Mark complete' }, { title: 'Snooze' }];

export function createReminderRunner({
  storage,
  alarms,
  notifications,
  action,
  openTab,
  iconUrl,
  now = () => Date.now(),
}) {
  const service = createAssessmentService({ storage, now: () => new Date(now()) });

  async function notify(id, options) {
    await notifications.create(id, { type: 'basic', iconUrl, ...options });
  }

  async function updateBadge(assessments, settings) {
    if (!action) return;
    const summary = summarize(assessments, {
      now: new Date(now()),
      dueSoonDays: settings.dueSoonDays,
    });
    const badge = badgeFor(summary, settings.badgeMode);
    await action.setBadgeText({ text: badge.text });
    if (badge.text) await action.setBadgeBackgroundColor({ color: badge.color });
    await action.setTitle({ title: badge.title });
  }

  /**
   * Bring everything up to date: summarise missed reminders, drop finished snoozes,
   * schedule future alarms and refresh the badge. Called on install, update, browser
   * start-up, storage changes, late alarms and the daily refresh.
   */
  async function reconcile({ reportMissed = true } = {}) {
    const time = now();
    const { assessments, settings } = await storage.getState();
    const state = await storage.getReminderState();
    const missed = reportMissed
      ? planMissedReminders({ assessments, settings, reminderState: state, now: time })
      : [];

    if (missed.length === 1) {
      const [reminder] = missed;
      const assessment = assessments.find((item) => item.id === reminder.assessmentId);
      const { title, message } = reminderMessage(assessment, reminder.offset);
      await notify(`${NOTIFICATION_PREFIX}${assessment.id}`, {
        title,
        message: `${message} (missed while the browser was closed)`,
        buttons: BUTTONS,
        priority: assessment.priority === 'high' ? 2 : 0,
      });
    } else if (missed.length > 1) {
      await notify(MISSED_NOTIFICATION, {
        ...missedSummaryMessage(missed, assessments),
        priority: 1,
      });
    }

    const snoozes = pruneSnoozes(state.snoozes, assessments, time);
    let next = markFired(
      state,
      missed.map((item) => item.key),
      time,
    );
    // Checked up to the grace window, so a slightly late alarm is never lost.
    next = {
      ...next,
      snoozes,
      lastCheckedAt: Math.max(state.lastCheckedAt ?? 0, time - LATE_AFTER_MS),
    };
    if (missed.length) {
      next = addHistory(next, [
        {
          at: time,
          kind: missed.length > 1 ? 'missed-summary' : 'missed',
          count: missed.length,
          titles: missed
            .map((item) => assessments.find((a) => a.id === item.assessmentId)?.title)
            .filter(Boolean)
            .slice(0, 5),
        },
      ]);
    }
    await storage.updateReminderState(() => next);

    await syncAlarms(
      alarms,
      computeReminders(assessments, settings, time, snoozes),
      nextRefreshTime(assessments, settings, time),
    );
    await updateBadge(assessments, settings);
    return { missed: missed.length };
  }

  async function handleAlarm(alarm) {
    const parsed = parseAlarmName(alarm.name);
    if (!parsed) return;
    const time = now();
    if (parsed.kind === 'refresh' || time - alarm.scheduledTime > LATE_AFTER_MS) {
      // Late alarms (sleep, closed browser) go through the missed-reminder summary.
      await reconcile();
      return;
    }
    const { assessments, settings } = await storage.getState();
    const state = await storage.getReminderState();
    const assessment = assessments.find((item) => item.id === parsed.assessmentId);
    if (!assessment || assessment.completed || !settings.notificationsEnabled) return;

    const offset = parsed.kind === 'snooze' ? null : parsed.offset;
    const when =
      parsed.kind === 'snooze'
        ? state.snoozes[assessment.id]
        : reminderTime(assessment, offset, settings);
    if (!when) return;
    const key = reminderKey(assessment.id, parsed.kind === 'snooze' ? 'snooze' : offset, when);
    if (state.fired[key]) return; // already shown

    const { title, message } = reminderMessage(assessment, offset);
    await notify(`${NOTIFICATION_PREFIX}${assessment.id}`, {
      title,
      message,
      buttons: BUTTONS,
      priority: assessment.priority === 'high' ? 2 : 0,
    });
    await storage.updateReminderState((current) => {
      const snoozes = { ...current.snoozes };
      if (parsed.kind === 'snooze') delete snoozes[assessment.id];
      return addHistory(markFired({ ...current, snoozes }, [key], time), [
        { at: time, kind: parsed.kind, assessmentId: assessment.id, title: assessment.title },
      ]);
    });
  }

  function deadlineIdFrom(notificationId) {
    return notificationId.startsWith(NOTIFICATION_PREFIX)
      ? notificationId.slice(NOTIFICATION_PREFIX.length)
      : null;
  }

  async function handleButton(notificationId, buttonIndex) {
    const id = deadlineIdFrom(notificationId);
    await notifications.clear(notificationId);
    if (!id) return;
    if (buttonIndex === 0) {
      await service.setCompleted(id, true);
    } else if (buttonIndex === 1) {
      await snooze(id);
    }
  }

  async function snooze(id, minutes) {
    const settings = await storage.getSettings();
    const until = now() + (minutes ?? settings.snoozeMinutes) * 60_000;
    await storage.updateReminderState((current) => ({
      ...current,
      snoozes: { ...current.snoozes, [id]: until },
    }));
  }

  async function handleClick(notificationId) {
    const id = deadlineIdFrom(notificationId);
    await notifications.clear(notificationId);
    await openTab(
      id
        ? `dashboard/dashboard.html#deadline=${encodeURIComponent(id)}`
        : 'dashboard/dashboard.html',
    );
  }

  return { reconcile, handleAlarm, handleButton, handleClick, updateBadge, snooze };
}
