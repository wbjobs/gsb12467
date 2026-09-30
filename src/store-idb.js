// IndexedDB 持久化：队列与历史分两个 store，队列每次状态变化都立即落盘，
// 从而保证页面卸载 / 崩溃 / 断电后队列不丢。
const DB_NAME = 'offline-request-queue';
const DB_VERSION = 1;
const STORE_QUEUE = 'queue';
const STORE_HISTORY = 'history';
const HISTORY_LIMIT = 100;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const store = db.createObjectStore(STORE_HISTORY, { keyPath: 'key', autoIncrement: true });
        store.createIndex('completedAt', 'completedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbStore {
  constructor() {
    this.dbPromise = openDb();
  }

  async _withStore(mode, fn) {
    const db = await this.dbPromise;
    return fn(tx(db, STORE_QUEUE, mode));
  }

  async getAllQueue() {
    const all = await this._withStore('readonly', (store) => wrap(store.getAll()));
    return all.filter((it) => it.id !== '__idseq__');
  }

  async getQueue(id) {
    return this._withStore('readonly', (store) => wrap(store.get(id)));
  }

  async putQueue(item) {
    await this._withStore('readwrite', (store) => wrap(store.put(item)));
    return item;
  }

  async deleteQueue(id) {
    await this._withStore('readwrite', (store) => wrap(store.delete(id)));
  }

  async clearQueue() {
    await this._withStore('readwrite', (store) => wrap(store.clear()));
  }

  // 与 store 共享同一自增序列，保证队列顺序 id 单调递增、不回退。
  async nextId() {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE_QUEUE, 'readwrite');
      const metaStore = t.objectStore(STORE_QUEUE);
      // 用一个哨兵键保存计数。
      const getReq = metaStore.get('__idseq__');
      getReq.onsuccess = () => {
        const next = (getReq.result?.value || 0) + 1;
        metaStore.put({ id: '__idseq__', value: next });
        t.oncomplete = () => resolve(next);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async addHistory(entry) {
    const db = await this.dbPromise;
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_HISTORY, 'readwrite');
      const store = t.objectStore(STORE_HISTORY);
      store.add(entry);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    await this._pruneHistory(db);
  }

  async _pruneHistory(db) {
    await new Promise((resolve) => {
      const t = db.transaction(STORE_HISTORY, 'readwrite');
      const store = t.objectStore(STORE_HISTORY);
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result <= HISTORY_LIMIT) return resolve();
        const cursorReq = store.index('completedAt').openCursor();
        let toDelete = countReq.result - HISTORY_LIMIT;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && toDelete > 0) {
            cursor.delete();
            toDelete -= 1;
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    });
  }

  async getAllHistory() {
    const db = await this.dbPromise;
    const all = await wrap(tx(db, STORE_HISTORY).getAll());
    return all.sort((a, b) => b.completedAt - a.completedAt);
  }

  async clearHistory() {
    const db = await this.dbPromise;
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_HISTORY, 'readwrite');
      t.objectStore(STORE_HISTORY).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}
