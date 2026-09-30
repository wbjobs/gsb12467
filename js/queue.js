/*
 * 请求队列核心：
 * - 离线入队，联网后严格 FIFO 顺序重放（seq 保序，同一时刻只发一条）；
 * - 失败按指数退避重试，超过次数转为 failed，可手动重试；
 * - 入队按「方法+路径+内容」指纹 + 时间窗口去重；
 * - 队列过长时丢弃最旧排队项（dropped）；
 * - 所有状态写入 IndexedDB，页面卸载/崩溃后恢复；
 * - 多标签页用 Web Locks 选出唯一 leader 负责重放，避免重复请求。
 */

import {
  getAllRequests,
  putRequest,
  putRequests,
  deleteRequest,
  clearRequests,
  getMeta,
  setMeta,
  nextSequence,
  META_KEYS,
} from './db.js';
import {
  STATUS,
  buildDedupKey,
  findDuplicate,
  backoffDelay,
  isRetryableStatus,
  truncateQueued,
  readBody,
} from './utils.js';

const DEFAULT_SETTINGS = Object.freeze({
  maxQueueLength: 10,
  dedupWindowMs: 60_000,
  maxAttempts: 3,
  requestTimeoutMs: 15_000,
});

export class QueueManager {
  constructor(bus, network, settings = {}) {
    this.bus = bus;
    this.network = network;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.items = [];
    this.activeId = null;
    this.activeController = null;
    this.flushing = false;
    this.isLeader = false;
    this.leaderRelease = null;
    this.leaderRetryTimer = null;
    this.unlocked = false;

    this.handleNetworkChange = this.handleNetworkChange.bind(this);
  }

  async start() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await getMeta(META_KEYS.SETTINGS, {})) };
    await this.recover();

    this.network.onChange(this.handleNetworkChange);

    // 其它标签页的变更 -> 重新从 IDB 拉取并刷新 UI
    const crossTabEvents = [
      'queue:changed', 'queue:item-updated', 'queue:enqueued',
      'queue:truncated', 'queue:flushed',
    ];
    for (const event of crossTabEvents) {
      this.bus.on(event, async () => {
        this.items = await getAllRequests();
        this.emitChanged();
      });
    }

    // 非 leader 标签请求手动重放 -> leader 执行
    this.bus.on('queue:flush-request', () => {
      if (this.isLeader) this.flush();
    });

    window.addEventListener('pagehide', this.handlePageHide);
    this.electLeader();
  }

  async recover() {
    this.items = await getAllRequests();
    const now = Date.now();
    const stale = this.items
      .filter((item) => item.status === STATUS.SENDING)
      .map((item) => ({
        ...item,
        status: STATUS.QUEUED,
        attempts: item.attempts || 0,
        nextAttemptAt: now,
        error: '页面中断，请求结果未知，恢复为排队（保证 at-least-once）',
      }));
    if (stale.length) await putRequests(stale);

    // 之前因「等待重试」而 failed 的可重试项，启动后恢复排队
    const revive = this.items
      .filter((item) => item.status === STATUS.FAILED && item.retryable !== false)
      .map((item) => ({ ...item, status: STATUS.QUEUED, nextAttemptAt: now }));
    if (revive.length) await putRequests(revive);

    if (stale.length || revive.length) this.items = await getAllRequests();
  }

  /* ---------------- leader 选举（Web Locks） ---------------- */

  electLeader() {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      // 极端环境下退化为每个标签都是 leader
      this.becomeLeader(() => {});
      return;
    }
    navigator.locks.request('offline-queue-leader', (lock) => new Promise((release) => {
      if (!lock) {
        this.scheduleLeaderRetry();
        return;
      }
      this.becomeLeader(release);
    }));
  }

  becomeLeader(release) {
    this.isLeader = true;
    this.leaderRelease = release;
    this.bus.dispatchLocal({ event: 'queue:leader', data: { leader: true } });
    if (this.network.online !== false) this.flush();
  }

  scheduleLeaderRetry() {
    clearTimeout(this.leaderRetryTimer);
    this.leaderRetryTimer = setTimeout(() => this.electLeader(), 2000);
  }

  /* ---------------- 入队 / 去重 / 截断 ---------------- */

  async enqueue({ method = 'GET', url, body = null, headers = {} }) {
    const normalizedMethod = method.toUpperCase();
    const normalizedBody = await readBody(body);
    const finalHeaders = { ...headers };
    if (normalizedBody && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    const dedupKey = await buildDedupKey({
      method: normalizedMethod, url, body: normalizedBody, headers: finalHeaders,
    });
    const duplicate = findDuplicate(this.items, dedupKey, this.settings.dedupWindowMs);
    if (duplicate) {
      duplicate.dupCount = (duplicate.dupCount || 0) + 1;
      await putRequest(duplicate);
      this.bus.emit('queue:item-updated', { id: duplicate.id });
      this.emitChanged();
      return { item: duplicate, duplicated: true };
    }

    const now = Date.now();
    const seq = await nextSequence();
    const item = {
      id: `req_${now.toString(36)}_${seq}_${Math.random().toString(36).slice(2, 8)}`,
      seq,
      method: normalizedMethod,
      url,
      body: normalizedBody,
      headers: finalHeaders,
      status: STATUS.QUEUED,
      attempts: 0,
      dedupKey,
      dupCount: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      nextAttemptAt: null,
      retryable: null,
      error: null,
      responseStatus: null,
      responsePreview: null,
    };
    this.items.push(item);
    await putRequest(item);

    const { kept, evicted } = truncateQueued(this.items, this.settings.maxQueueLength);
    if (evicted.length) {
      this.items = kept;
      await putRequests(evicted);
      this.bus.emit('queue:truncated', { evictedIds: evicted.map((i) => i.id) });
    }

    this.bus.emit('queue:enqueued', { id: item.id });
    this.emitChanged();

    if (this.isLeader && this.network.online === true) this.flush();
    return { item, duplicated: false };
  }

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await setMeta(META_KEYS.SETTINGS, this.settings);

    if (patch.maxQueueLength) {
      const { kept, evicted } = truncateQueued(this.items, this.settings.maxQueueLength);
      if (evicted.length) {
        this.items = kept;
        await putRequests(evicted);
        this.bus.emit('queue:truncated', { evictedIds: evicted.map((i) => i.id) });
      }
    }
    this.emitChanged();
  }

  /* ---------------- 顺序重放 ---------------- */

  /** 手动触发：非 leader 标签转发给 leader 执行。 */
  flush() {
    if (!this.isLeader) {
      this.bus.broadcast('queue:flush-request', {});
      return;
    }
    if (this.flushing) return;
    this.flushing = true;
    this.runLoop();
  }

  async runLoop() {
    while (this.flushing) {
      if (this.network.online === false) {
        this.flushing = false;
        this.emitChanged();
        return;
      }

      // 严格按 seq 保序：排队项 + 退避等待中的失败项都参与排序；
      // 永久失败（无 nextAttemptAt）会被跳过，交由用户手动重试，不阻塞后续。
      const candidates = this.items
        .filter((item) =>
          item.status === STATUS.QUEUED ||
          (item.status === STATUS.FAILED && item.nextAttemptAt != null))
        .sort((a, b) => a.seq - b.seq);
      const next = candidates[0];

      if (!next) {
        this.flushing = false;
        this.bus.broadcast('queue:flushed', {});
        this.emitChanged();
        return;
      }

      // 退避等待：可被取消 / 离线 / 手动重试打断
      const now = Date.now();
      if (next.nextAttemptAt && next.nextAttemptAt > now) {
        const awakened = await this.sleepUntilWake(next.id, next.nextAttemptAt);
        if (awakened === 'cancelled') continue;
        if (awakened === 'offline') {
          this.flushing = false;
          this.emitChanged();
          return;
        }
      }

      await this.send(next);
    }
  }

  sleepUntilWake(id, untilTs) {
    return new Promise((resolve) => {
      const isWaiting = (it) =>
        it && (it.status === STATUS.QUEUED ||
          (it.status === STATUS.FAILED && it.nextAttemptAt != null));
      const item = this.items.find((i) => i.id === id);
      if (!isWaiting(item)) {
        resolve('cancelled');
        return;
      }

      const offChange = this.network.onChange((online) => {
        if (online === false) finish('offline');
      });

      let timer = null;
      const tick = () => {
        const current = this.items.find((i) => i.id === id);
        if (!isWaiting(current)) {
          finish('cancelled');
          return;
        }
        if (Date.now() >= (current.nextAttemptAt || 0)) {
          if (current.status === STATUS.FAILED) {
            current.status = STATUS.QUEUED;
            putRequest(current);
          }
          finish('timeout');
          return;
        }
        // 到目标时刻最多再等 200ms，保证及时收敛且不长期占用定时器
        timer = setTimeout(tick, Math.min(200, Math.max(0, current.nextAttemptAt - Date.now()) + 20));
      };
      timer = setTimeout(tick, Math.min(200, Math.max(0, untilTs - Date.now()) + 20));

      const finish = (reason) => {
        clearTimeout(timer);
        offChange();
        resolve(reason);
      };
    });
  }

  async send(item) {
    const controller = new AbortController();
    this.activeId = item.id;
    this.activeController = controller;

    Object.assign(item, {
      status: STATUS.SENDING,
      startedAt: item.startedAt || Date.now(),
      nextAttemptAt: null,
      error: null,
    });
    item.attempts = (item.attempts || 0) + 1;
    await putRequest(item);
    this.bus.broadcast('queue:item-updated', { id: item.id });
    this.emitChanged();

    const timeoutTimer = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);
    const onOffline = () => controller.abort(new DOMException('gone offline', 'OfflineAbort'));
    const offNetChange = this.network.onChange((online) => {
      if (online === false) onOffline();
    });

    let response;
    let fetchError = null;
    try {
      const init = {
        method: item.method,
        headers: item.headers,
        signal: controller.signal,
        cache: 'no-store',
      };
      if (item.method !== 'GET' && item.method !== 'HEAD' && item.body != null) {
        init.body = item.body;
      }
      response = await fetch(item.url, init);
    } catch (err) {
      fetchError = err;
    } finally {
      clearTimeout(timeoutTimer);
      offNetChange();
    }

    if (fetchError?.name === 'AbortError') {
      const goneOffline = this.network.online === false;
      if (goneOffline) {
        // 发送途中断网：不计重试，回到队首等待
        Object.assign(item, {
          status: STATUS.QUEUED,
          nextAttemptAt: Date.now(),
          error: '发送途中离线，已回到队列',
        });
        await putRequest(item);
        this.bus.broadcast('queue:item-updated', { id: item.id });
        this.emitChanged();
        this.flushing = false;
        this.activeId = null;
        this.activeController = null;
        return;
      }
      // 超时或手动取消
      const cancelled = this.items.find((i) => i.id === item.id)?._cancelRequested;
      if (cancelled) {
        await this.finishItem(item, STATUS.CANCELLED, { error: '用户取消' });
      } else {
        await this.classifyFailure(item, new Error('请求超时或被中止'), null);
      }
      this.activeId = null;
      this.activeController = null;
      return;
    }

    if (response && response.ok) {
      const preview = await response.clone().text().catch(() => '');
      Object.assign(item, {
        status: STATUS.SUCCESS,
        finishedAt: Date.now(),
        responseStatus: response.status,
        responsePreview: preview.slice(0, 500),
        error: null,
        nextAttemptAt: null,
        retryable: false,
      });
      await putRequest(item);
      this.bus.broadcast('queue:item-updated', { id: item.id });
      this.emitChanged();
      this.activeId = null;
      this.activeController = null;
      return;
    }

    const status = response ? response.status : 0;
    const errorText = response
      ? `HTTP ${status} ${response.statusText || ''}`.trim()
      : String(fetchError?.message || fetchError || 'network error');
    await this.classifyFailure(item, new Error(errorText), status);
    this.activeId = null;
    this.activeController = null;
  }

  async classifyFailure(item, error, status) {
    const retryableByStatus = status === 0 ? true : isRetryableStatus(status);
    const attemptsLeft = item.attempts < this.settings.maxAttempts;

    if (retryableByStatus && attemptsLeft) {
      const waitMs = backoffDelay(item.attempts);
      Object.assign(item, {
        status: STATUS.FAILED,
        finishedAt: null,
        error: `${error.message}（${waitMs / 1000}s 后自动重试）`,
        responseStatus: status || null,
        retryable: true,
        nextAttemptAt: Date.now() + waitMs,
      });
      await putRequest(item);
      this.bus.broadcast('queue:item-updated', { id: item.id });
      this.emitChanged();
      // 保持 FAILED + nextAttemptAt：由 runLoop 按 seq 顺序在退避结束后拾取
      return;
    }

    Object.assign(item, {
      status: STATUS.FAILED,
      finishedAt: Date.now(),
      error: retryableByStatus
        ? `${error.message}（已达最大重试次数 ${this.settings.maxAttempts}，需手动重试）`
        : `${error.message}（确定性错误，不会自动重试）`,
      responseStatus: status || null,
      retryable: retryableByStatus,
      nextAttemptAt: null,
    });
    await putRequest(item);
    this.bus.broadcast('queue:item-updated', { id: item.id });
    this.emitChanged();
  }

  /* ---------------- 手动操作 ---------------- */

  async cancelItem(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;

    if (item.status === STATUS.SENDING && this.activeId === id) {
      item._cancelRequested = true;
      this.activeController?.abort();
      return;
    }

    if (item.status === STATUS.QUEUED ||
        (item.status === STATUS.FAILED && item.nextAttemptAt != null)) {
      await this.finishItem(item, STATUS.CANCELLED, { error: '用户取消' });
    }
  }

  async retryItem(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== STATUS.FAILED) return;
    Object.assign(item, {
      status: STATUS.QUEUED,
      attempts: 0,
      error: null,
      nextAttemptAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      responseStatus: null,
      responsePreview: null,
    });
    await putRequest(item);
    this.bus.broadcast('queue:item-updated', { id });
    this.emitChanged();
    if (this.isLeader && this.network.online === true) this.flush();
  }

  /** 清空未完成的排队/失败项（标记 cancelled，仍保留在历史中）。 */
  async clearQueue() {
    const pending = this.items.filter(
      (i) => i.status === STATUS.QUEUED || i.status === STATUS.FAILED
    );
    const now = Date.now();
    for (const item of pending) {
      Object.assign(item, {
        status: STATUS.CANCELLED,
        finishedAt: now,
        nextAttemptAt: null,
        error: item.error ? `${item.error}；队列被清空` : '队列被清空',
      });
    }
    if (this.activeId && this.activeController) {
      const active = this.items.find((i) => i.id === this.activeId);
      if (active) active._cancelRequested = true;
      this.activeController.abort();
    }
    if (pending.length) await putRequests(pending);
    this.bus.broadcast('queue:changed', {});
    this.emitChanged();
  }

  /** 历史只清理终态记录（成功 / 取消 / 截断）。 */
  async clearHistory() {
    const terminal = new Set([STATUS.SUCCESS, STATUS.CANCELLED, STATUS.DROPPED]);
    const removable = this.items.filter((i) => terminal.has(i.status));
    for (const item of removable) {
      await deleteRequest(item.id);
    }
    this.items = this.items.filter((i) => !terminal.has(i.status));
    this.bus.broadcast('queue:changed', {});
    this.emitChanged();
  }

  async removeItem(id) {
    await deleteRequest(id);
    this.items = this.items.filter((i) => i.id !== id);
    this.bus.broadcast('queue:changed', {});
    this.emitChanged();
  }

  async finishItem(item, status, extra = {}) {
    Object.assign(item, {
      status,
      finishedAt: Date.now(),
      nextAttemptAt: null,
      ...extra,
    });
    delete item._cancelRequested;
    await putRequest(item);
    this.bus.broadcast('queue:item-updated', { id: item.id });
    this.emitChanged();
  }

  /* ---------------- 网络变化 / 卸载 / 事件 ---------------- */

  async handleNetworkChange(online) {
    this.emitChanged();
    if (!this.isLeader) return;

    if (online) {
      // 重连：把退避等待中的项立刻放行，然后从队首顺序重放
      const waiting = this.items.filter(
        (i) => i.status === STATUS.FAILED && i.nextAttemptAt != null
      );
      if (waiting.length) {
        const now = Date.now();
        for (const item of waiting) item.nextAttemptAt = now;
        await putRequests(waiting);
      }
      this.flush();
    }
    // 离线时：send() 内的监听会中止当前请求并回队列，runLoop 自行退出
  }

  handlePageHide = () => {
    // 队列在每次状态流转时都已写入 IndexedDB，这里再做一次兜底全量保存
    try {
      putRequests(this.items);
    } catch {
      /* 卸载期间事务可能被截断，常规流转已保证持久化 */
    }
  };

  emitChanged() {
    this.bus.dispatchLocal({ event: 'queue:changed', data: { at: Date.now() } });
    this.bus.broadcast('queue:changed', { at: Date.now() });
  }

  /** 供 UI 统计：当前仍在队列中的（排队/发送中/失败等待）。 */
  getActiveQueue() {
    return this.items
      .filter((i) =>
        i.status === STATUS.QUEUED || i.status === STATUS.SENDING ||
        (i.status === STATUS.FAILED && i.nextAttemptAt != null))
      .sort((a, b) => a.seq - b.seq);
  }
}
