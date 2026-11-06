// Small IndexedDB key-value store for large data kept on this device only
// (the opened book and its Umigame numbers). Nothing here is ever uploaded.
// Every call resolves to undefined/false instead of throwing when storage is unavailable
// (private browsing, storage blocked or full).

const DB_NAME = 'reversi-trainer';
const STORE = 'files';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}

export async function dbGet(key) {
  try { return await run('readonly', (s) => s.get(key)); } catch { return undefined; }
}

export async function dbPut(key, value) {
  try { await run('readwrite', (s) => s.put(value, key)); return true; } catch { return false; }
}

export async function dbDelete(key) {
  try { await run('readwrite', (s) => s.delete(key)); return true; } catch { return false; }
}

// Ask the browser not to clear this data when space runs low (granted more readily to
// apps added to the home screen). Harmless if refused.
export async function askPersist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
