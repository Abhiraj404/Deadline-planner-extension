/**
 * Page bootstrap shared by the popup and the dashboard.
 *
 * Holds the latest snapshot of storage in memory and notifies the page whenever
 * storage changes (from this page, another page, or the service worker). Pages
 * never update their own state directly after a write: they wait for the change
 * event, so every open view stays in sync from a single source of truth.
 */

import { createAssessmentService } from './assessments.js';
import { createStorage, isExtensionContext } from './storage.js';
import { applyTheme } from './theme.js';

export async function createApp() {
  const storage = createStorage();
  const service = createAssessmentService({ storage });
  await storage.init();
  let state = await storage.getState();
  const listeners = new Set();

  applyTheme(state.settings.theme);
  storage.subscribe((update) => {
    const themeChanged = update.settings && update.settings.theme !== state.settings.theme;
    state = { ...state, ...update };
    if (themeChanged) applyTheme(state.settings.theme);
    for (const listener of listeners) listener(state);
  });

  const extension = isExtensionContext();
  const openPage = (path) => {
    if (extension) chrome.tabs.create({ url: chrome.runtime.getURL(path) });
    else window.open(`/${path}`, '_blank', 'noopener');
  };

  return {
    storage,
    service,
    isExtension: extension,
    getState: () => state,
    getSettings: () => state.settings,
    getAssessment: (id) => state.assessments.find((item) => item.id === id) ?? null,
    now: () => new Date(),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Open the full dashboard in a normal tab, optionally at a hash such as "#settings". */
    openDashboard(hash = '') {
      openPage(`dashboard/dashboard.html${hash}`);
    },
    /**
     * Open the document import page in its own tab. Imports run there, not in the
     * popup, so closing the popup never interrupts processing.
     */
    openImportPage(hash = '') {
      openPage(`import/import.html${hash}`);
    },
  };
}
