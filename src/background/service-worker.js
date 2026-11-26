/**
 * Background service worker (Manifest V3).
 *
 * It is event-driven: Chrome starts it for an install, a browser start-up, a
 * storage change, an alarm or a notification click, and stops it when idle. There
 * is no polling and nothing kept in memory between events. All listeners are
 * registered synchronously at the top level, which MV3 requires for them to wake
 * the worker.
 */

import { createStorage } from '../services/storage.js';
import {
  computeReminders,
  parseAlarmName,
  reminderMessage,
  syncAlarms,
} from '../services/reminders.js';

const storage = createStorage(chrome.storage.local, {
  addListener: (fn) =>
    chrome.storage.onChanged.addListener((changes, area) => area === 'local' && fn(changes)),
});

async function rescheduleAll() {
  try {
    const { assessments, settings } = await storage.getState();
    const result = await syncAlarms(chrome.alarms, computeReminders(assessments, settings));
    if (result.created || result.cleared) {
      console.info(
        `Deadline Reminder: ${result.created} reminders set, ${result.cleared} cleared.`,
      );
    }
  } catch (error) {
    console.error('Deadline Reminder: could not schedule reminders', error);
  }
}

function dashboardUrl(assessmentId) {
  const base = chrome.runtime.getURL('dashboard/dashboard.html');
  return assessmentId ? `${base}#deadline=${encodeURIComponent(assessmentId)}` : base;
}

chrome.runtime.onInstalled.addListener(() => {
  rescheduleAll();
});

// Alarms are not guaranteed to survive browser restarts or extension updates.
chrome.runtime.onStartup.addListener(() => {
  rescheduleAll();
});

// Any change to deadlines or settings (from the popup, dashboard or a restore)
// reschedules reminders, so edited due dates are picked up automatically.
storage.subscribe(() => {
  rescheduleAll();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const parsed = parseAlarmName(alarm.name);
  if (!parsed) return;
  const { assessments, settings } = await storage.getState();
  const assessment = assessments.find((item) => item.id === parsed.assessmentId);
  if (!assessment || assessment.completed || !settings.notificationsEnabled) return;

  const { title, message } = reminderMessage(assessment, parsed.offset);
  chrome.notifications.create(`${alarm.name}:${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
    priority: assessment.priority === 'high' ? 2 : 0,
  });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const parsed = parseAlarmName(notificationId.replace(/:\d+$/, ''));
  chrome.tabs.create({ url: dashboardUrl(parsed?.assessmentId) });
  chrome.notifications.clear(notificationId);
});
