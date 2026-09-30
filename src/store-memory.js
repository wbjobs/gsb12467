// 内存存储：与 IndexedDbStore 接口一致，供单元测试使用。
const HISTORY_LIMIT = 100;

export class MemoryStore {
  constructor() {
    this.queue = new Map();
    this.history = [];
    this.seq = 0;
  }

  async getAllQueue() {
    return [...this.queue.values()];
  }
  async getQueue(id) {
    return this.queue.get(id) ?? null;
  }
  async putQueue(item) {
    this.queue.set(item.id, item);
    return item;
  }
  async deleteQueue(id) {
    this.queue.delete(id);
  }
  async clearQueue() {
    this.queue.clear();
  }
  async nextId() {
    this.seq += 1;
    return this.seq;
  }
  async addHistory(entry) {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
  }
  async getAllHistory() {
    return [...this.history].sort((a, b) => b.completedAt - a.completedAt);
  }
  async clearHistory() {
    this.history = [];
  }
}
