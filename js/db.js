/* IndexedDB 封装：队列项与设置全部持久化，页面卸载/崩溃后可恢复。 */

const DB_NAME = 'offline-request-queue';
const DB_VERSION = 1;
const STORE_REQUESTS = 'requests';
const STORE_META = 'meta';

export const META_KEYS = {
  SEQ: 'seq',
  SETTINGS: 'settings',
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
        db.createObjectStore(STORE_REQUESTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  const transaction = db.transaction(store, mode);
  return { transaction, store: transaction.objectStore(store) };
}

function asPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putRequest(item) {
  const db = await openDb();
  const { transaction, store } = tx(db, STORE_REQUESTS, 'readwrite');
  store.put(item);
  await asPromise(transaction);
  return item;
}

export async function putRequests(items) {
  if (!items.length) return;
  const db = await openDb();
  const { transaction, store } = tx(db, STORE_REQUESTS, 'readwrite');
  for (const item of items) store.put(item);
  await asPromise(transaction);
}

export async function deleteRequest(id) {
  const db = await openDb();
  const { transaction, store } = tx(db, STORE_REQUESTS, 'readwrite');
  store.delete(id);
  await asPromise(transaction);
}

export async function clearRequests() {
  const db = await openDb();
  const { transaction, store } = tx(db, STORE_REQUESTS, 'readwrite');
  store.clear();
  await asPromise(transaction);
}

export async function getAllRequests() {
  const db = await openDb();
  const { store } = tx(db, STORE_REQUESTS, 'readonly');
  return asPromise(store.getAll());
}

export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const { store } = tx(db, STORE_META, 'readonly');
  const value = await asPromise(store.get(key));
  return value === undefined ? fallback : value;
}

export async function setMeta(key, value) {
  const db = await openDb();
  const { transaction, store } = tx(db, STORE_META, 'readwrite');
  store.put(value, key);
  await asPromise(transaction);
}

/** 读取并自增序列（用于保持严格入队顺序），可在一个事务内先取值。 */
export async function nextSequence() {
  const db = await openDb();
  const { transaction, store } = tx(db, STORE_META, 'readwrite');
  const current = (await asPromise(store.get(META_KEYS.SEQ))) || 0;
  const next = current + 1;
  store.put(next, META_KEYS.SEQ);
  await asPromise(transaction);
  return next;
}
