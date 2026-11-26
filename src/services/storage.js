/**
 * Storage service: the only module that talks to chrome.storage.local.
 *
 * Layout (all in chrome.storage.local):
 *   schemaVersion  number               current shape version (see migrations.js)
 *   assessments    Assessment[]         every deadline, manual and imported
 *   settings       Settings             user preferences
 *   documents      DocumentRecord[]     imported-document library (metadata + evidence)
 *   reminderState  ReminderState        snoozes, fired-reminder keys, notification history
 *
 * Document binaries are never stored here. chrome.storage.local has a 10 MB quota and
 * is meant for small JSON values; original files are kept (only when the user opts
 * in) in IndexedDB by services/file-store.js.
 */

import { CURRENT_SCHEMA_VERSION, migrateSnapshot } from './migrations.js';
import { normalizeDocumentRecord } from '../models/document.js';
import { normalizeSettings } from '../models/settings.js';

export const KEYS = Object.freeze({
  schemaVersion: 'schemaVersion',
  assessments: 'assessments',
  settings: 'settings',
  documents: 'documents',
  reminderState: 'reminderState',
});

/** Always returns a complete, well-typed reminder state. */
export function normalizeReminderState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const numberMap = (value) =>
    Object.fromEntries(
      Object.entries(value && typeof value === 'object' ? value : {}).filter(
        ([key, at]) => typeof key === 'string' && Number.isFinite(at),
      ),
    );
  return {
    lastCheckedAt: Number.isFinite(input.lastCheckedAt) ? input.lastCheckedAt : null,
    fired: numberMap(input.fired),
    snoozes: numberMap(input.snoozes),
    history: Array.isArray(input.history)
      ? input.history.filter((entry) => entry && typeof entry === 'object').slice(0, 30)
      : [],
  };
}

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

/**
 * A localStorage-backed stand-in with the same promise API as chrome.storage.local.
 * It is used only when the pages are opened outside the extension (for example with
 * `npm run preview`) so the UI can be developed in a normal tab.
 */
export function createLocalStorageArea(backing = globalThis.localStorage, prefix = 'dr-preview:') {
  const listeners = new Set();
  const read = (key) => {
    const raw = backing.getItem(prefix + key);
    return raw === null ? undefined : JSON.parse(raw);
  };
  const area = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) {
        const value = read(key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    },
    async set(items) {
      const changes = {};
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = { oldValue: read(key), newValue };
        backing.setItem(prefix + key, JSON.stringify(newValue));
      }
      for (const listener of listeners) listener(changes);
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  };
  // Other preview tabs write to the same localStorage; mirror chrome.storage.onChanged.
  globalThis.addEventListener?.('storage', (event) => {
    if (!event.key?.startsWith(prefix)) return;
    const key = event.key.slice(prefix.length);
    const parse = (value) => (value === null ? undefined : JSON.parse(value));
    const changes = { [key]: { oldValue: parse(event.oldValue), newValue: parse(event.newValue) } };
    for (const listener of listeners) listener(changes);
  });
  return area;
}

export function isExtensionContext() {
  return Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id);
}

export function resolveStorageArea() {
  if (isExtensionContext()) return globalThis.chrome.storage.local;
  return createLocalStorageArea();
}

/**
 * @param {object} [area] an object with chrome.storage.local's promise API
 * @param {object} [events] where change events come from (chrome.storage.onChanged in the extension)
 */
export function createStorage(area = resolveStorageArea(), events = undefined) {
  const changeSource =
    events ??
    (area === globalThis.chrome?.storage?.local
      ? {
          addListener: (fn) =>
            globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
              if (areaName === 'local') fn(changes);
            }),
        }
      : area.onChanged);

  let initPromise = null;
  let readOnly = false;

  async function safeGet(keys) {
    try {
      return await area.get(keys);
    } catch (error) {
      throw new StorageError('Could not read saved deadlines.', error);
    }
  }

  async function safeSet(items) {
    if (readOnly) {
      throw new StorageError(
        'Your data was saved by a newer version of Deadline Reminder. Update the extension to make changes.',
      );
    }
    try {
      await area.set(items);
    } catch (error) {
      const quota = /quota/i.test(String(error?.message));
      throw new StorageError(
        quota ? 'Browser storage is full. Delete old deadlines and try again.' : 'Could not save.',
        error,
      );
    }
  }

  /**
   * Make sure storage holds a current, valid snapshot. Safe to call many times and
   * from several pages at once: the first call does the work, later calls reuse it.
   */
  function init() {
    initPromise ??= (async () => {
      const stored = await safeGet(Object.values(KEYS));
      const result = migrateSnapshot(stored);
      readOnly = result.readOnly;
      if (result.readOnly) {
        console.warn(
          `Deadline Reminder: stored schema v${result.fromVersion} is newer than v${CURRENT_SCHEMA_VERSION}.`,
        );
      } else if (result.changed || result.dropped > 0 || stored.settings === undefined) {
        await safeSet(result.snapshot);
      }
      return result;
    })().catch((error) => {
      initPromise = null; // allow a retry after a transient failure
      throw error;
    });
    return initPromise;
  }

  async function getAssessments() {
    await init();
    const { assessments } = await safeGet([KEYS.assessments]);
    return Array.isArray(assessments) ? assessments : [];
  }

  async function getSettings() {
    await init();
    const { settings } = await safeGet([KEYS.settings]);
    return normalizeSettings(settings);
  }

  async function getState() {
    await init();
    const stored = await safeGet([
      KEYS.assessments,
      KEYS.settings,
      KEYS.documents,
      KEYS.reminderState,
    ]);
    return {
      assessments: Array.isArray(stored.assessments) ? stored.assessments : [],
      settings: normalizeSettings(stored.settings),
      documents: Array.isArray(stored.documents) ? stored.documents : [],
      reminderState: normalizeReminderState(stored.reminderState),
    };
  }

  /**
   * Reminder bookkeeping, kept apart from deadlines so reminder activity never rewrites
   * deadline records: { lastCheckedAt, fired: {key: ms}, history: [], snoozes: {id: ms} }.
   */
  async function getReminderState() {
    await init();
    const { reminderState } = await safeGet([KEYS.reminderState]);
    return normalizeReminderState(reminderState);
  }

  async function updateReminderState(mutator) {
    const current = await getReminderState();
    const next = await mutator(current);
    if (next === current || next === undefined) return current;
    await safeSet({ [KEYS.reminderState]: normalizeReminderState(next) });
    return next;
  }

  async function getDocuments() {
    await init();
    const { documents } = await safeGet([KEYS.documents]);
    return Array.isArray(documents) ? documents : [];
  }

  async function updateDocuments(mutator) {
    const current = await getDocuments();
    const next = await mutator(current);
    if (next === current || next === undefined) return current;
    await safeSet({ [KEYS.documents]: next.map(normalizeDocumentRecord).filter(Boolean) });
    return next;
  }

  /**
   * Change deadlines and the document library together in one write, so an import
   * never leaves a deadline pointing at a document record that was not saved.
   * `mutator({ assessments, documents })` returns the new pair (or the same objects).
   */
  async function updateLibrary(mutator) {
    await init();
    const stored = await safeGet([KEYS.assessments, KEYS.documents]);
    const current = {
      assessments: Array.isArray(stored.assessments) ? stored.assessments : [],
      documents: Array.isArray(stored.documents) ? stored.documents : [],
    };
    const next = await mutator(current);
    const items = {};
    if (next.assessments !== current.assessments) items[KEYS.assessments] = next.assessments;
    if (next.documents !== current.documents) {
      items[KEYS.documents] = next.documents.map(normalizeDocumentRecord).filter(Boolean);
    }
    if (Object.keys(items).length > 0) await safeSet(items);
    return next;
  }

  async function saveAssessments(assessments) {
    await init();
    await safeSet({ [KEYS.assessments]: assessments });
  }

  async function saveSettings(settings) {
    await init();
    await safeSet({ [KEYS.settings]: normalizeSettings(settings) });
  }

  /**
   * Read the latest list, let `mutator` return a new list, and write it only if it
   * changed. Reading fresh each time keeps the popup and dashboard from overwriting
   * each other's edits with a stale copy.
   */
  async function updateAssessments(mutator) {
    const current = await getAssessments();
    const next = await mutator(current);
    if (next === current || next === undefined) return current;
    await saveAssessments(next);
    return next;
  }

  async function replaceAll({ assessments, settings, documents, reminderState }) {
    await init();
    await safeSet({
      [KEYS.schemaVersion]: CURRENT_SCHEMA_VERSION,
      [KEYS.assessments]: assessments,
      [KEYS.settings]: normalizeSettings(settings),
      ...(documents ? { [KEYS.documents]: documents } : {}),
      ...(reminderState ? { [KEYS.reminderState]: normalizeReminderState(reminderState) } : {}),
    });
  }

  /** Call `listener({ assessments?, settings?, documents? })` whenever another page changes storage. */
  function subscribe(listener) {
    changeSource?.addListener((changes) => {
      const update = {};
      if (KEYS.assessments in changes) update.assessments = changes.assessments.newValue ?? [];
      if (KEYS.settings in changes) update.settings = normalizeSettings(changes.settings.newValue);
      if (KEYS.documents in changes) update.documents = changes.documents.newValue ?? [];
      if (KEYS.reminderState in changes) {
        update.reminderState = normalizeReminderState(changes.reminderState.newValue);
      }
      if (Object.keys(update).length > 0) listener(update);
    });
  }

  return {
    init,
    getAssessments,
    getSettings,
    getState,
    saveAssessments,
    saveSettings,
    updateAssessments,
    getDocuments,
    updateDocuments,
    updateLibrary,
    getReminderState,
    updateReminderState,
    replaceAll,
    subscribe,
    get readOnly() {
      return readOnly;
    },
  };
}
