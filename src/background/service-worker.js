/**
 * Background service worker (Manifest V3).
 *
 * Event-driven: Chrome starts it for an install or update, a browser start-up, a
 * storage change, an alarm or a notification action, and stops it when idle. There is
 * no polling and no state in memory between events. Listeners are registered
 * synchronously at the top level, which MV3 requires for them to wake the worker.
 *
 * The worker handles no runtime messages: pages and the worker communicate only
 * through chrome.storage, so there is no message channel for websites or other
 * extensions to abuse.
 */

import { createReminderRunner } from './reminder-runner.js';
import { createStorage } from '../services/storage.js';

const storage = createStorage(chrome.storage.local, {
  addListener: (fn) =>
    chrome.storage.onChanged.addListener((changes, area) => area === 'local' && fn(changes)),
});

const runner = createReminderRunner({
  storage,
  alarms: chrome.alarms,
  notifications: chrome.notifications,
  action: chrome.action,
  iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
  openTab: (path) => chrome.tabs.create({ url: chrome.runtime.getURL(path) }),
});

const safely =
  (task) =>
  async (...args) => {
    try {
      await task(...args);
    } catch (error) {
      console.error('Deadline Reminder:', error);
    }
  };

// Install and update: alarms may not survive an update, so rebuild them all.
// Missed reminders are not reported on first install.
chrome.runtime.onInstalled.addListener(
  safely((details) => runner.reconcile({ reportMissed: details.reason !== 'install' })),
);

// Browser start-up: alarms are not guaranteed to persist; reconcile and summarise
// anything missed while the browser was closed.
chrome.runtime.onStartup.addListener(safely(() => runner.reconcile()));

// Deadline, settings or snooze changes from any page reschedule automatically.
// The worker's own bookkeeping (fired keys, history) is ignored to avoid loops.
let lastSnoozes = null;
storage.subscribe(
  safely(async (update) => {
    if (update.reminderState) {
      const snoozes = JSON.stringify(update.reminderState.snoozes);
      const changed = snoozes !== lastSnoozes;
      lastSnoozes = snoozes;
      if (!changed && !update.assessments && !update.settings) return;
    }
    await runner.reconcile();
  }),
);

chrome.alarms.onAlarm.addListener(safely((alarm) => runner.handleAlarm(alarm)));
chrome.notifications.onButtonClicked.addListener(
  safely((id, index) => runner.handleButton(id, index)),
);
chrome.notifications.onClicked.addListener(safely((id) => runner.handleClick(id)));
