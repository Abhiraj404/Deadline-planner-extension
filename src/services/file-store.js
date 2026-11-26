/**
 * Optional storage of original document files in IndexedDB.
 *
 * Used only when the user turns on "Keep original files" in settings. Files are
 * stored as Blobs keyed by document id; chrome.storage.local is never used for file
 * contents. IndexedDB is per extension and per browser profile, like the rest of the
 * data, and is cleared when the extension is removed.
 */

const DB_NAME = 'deadline-reminder-files';
const STORE = 'files';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The file store is in use in another tab.'));
  });
}

async function run(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const fileStore = {
  /** @param {string} id document id @param {Blob} blob */
  put: (id, blob) => run('readwrite', (store) => store.put(blob, id)),
  /** @returns {Promise<Blob|undefined>} */
  get: (id) => run('readonly', (store) => store.get(id)),
  delete: (id) => run('readwrite', (store) => store.delete(id)),
  clear: () => run('readwrite', (store) => store.clear()),
};
