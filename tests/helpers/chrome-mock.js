/**
 * Minimal in-memory stand-ins for the chrome.storage.local and chrome.alarms APIs.
 * Values are deep-cloned on the way in and out, like the real structured storage.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function createMemoryStorageArea(initial = {}) {
  const data = new Map(Object.entries(clone(initial)));
  const listeners = new Set();
  const area = {
    writes: 0,
    async get(keys) {
      const list = keys === null || keys === undefined ? [...data.keys()] : [keys].flat();
      const result = {};
      for (const key of list) if (data.has(key)) result[key] = clone(data.get(key));
      return result;
    },
    async set(items) {
      area.writes += 1;
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(data.get(key)), newValue: clone(value) };
        data.set(key, clone(value));
      }
      for (const listener of listeners) listener(changes);
    },
    dump: () => Object.fromEntries([...data.entries()].map(([key, value]) => [key, clone(value)])),
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  };
  return area;
}

export function createFailingStorageArea(message = 'QUOTA_BYTES quota exceeded') {
  const area = createMemoryStorageArea();
  area.set = async () => {
    throw new Error(message);
  };
  return area;
}

export function createAlarmsMock() {
  const alarms = new Map();
  return {
    alarms,
    async getAll() {
      return [...alarms.values()].map((alarm) => ({ ...alarm }));
    },
    async create(name, { when }) {
      alarms.set(name, { name, scheduledTime: when });
    },
    async clear(name) {
      return alarms.delete(name);
    },
  };
}

/** A deterministic id factory: id-1, id-2, ... */
export function sequentialIds(prefix = 'id') {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}
