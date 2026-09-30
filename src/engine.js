// 离线请求队列核心引擎（与 DOM / IndexedDB 解耦，全部依赖通过构造函数注入，便于测试）。
import {
  STATUS,
  TypedEventEmitter,
  backoffDelay,
  fingerprint,
  isRetriableStatus,
  normalizeRequest,
  nowTs,
} from './utils.js';

export class QueueFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueFullError';
  }
}

const DEFAULT_OPTIONS = {
  maxQueue: 8, // 队列中“未完成”请求上限，超出触发截断
  maxAttempts: 4, // 单条请求最大尝试次数
  attemptTimeoutMs: 8000, // 单次 fetch 超时
  baseDelayMs: 1000, // 退避基数
  maxDelayMs: 15000,
};

/**
 * @param {object} deps
 *   store: { getAllQueue(), getQueue(id), putQueue(item), deleteQueue(id),
 *            clearQueue(), addHistory(entry), clearHistory(), getAllHistory() }
 *   network: { isOnline(): boolean }
 *   fetchImpl: 标准 fetch
 *   AbortControllerCtor
 *   bus: 跨标签页消息（BroadcastChannel 或测试桩），可选
 *   locks: Web Locks API（可选，用于多标签页选主）
 *   scheduler: { setTimeout, clearTimeout }（测试可注入虚拟时钟）
 */
export class OfflineQueueEngine extends TypedEventEmitter {
  constructor(deps = {}) {
    super();
    this.opts = { ...DEFAULT_OPTIONS, ...(deps.opts || {}) };
    this.store = deps.store;
    this.network = deps.network || { isOnline: () => true };
    this.fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
    this.AbortCtl = deps.AbortControllerCtor || (typeof AbortController !== 'undefined' ? AbortController : null);
    this.bus = deps.bus || null;
    this.locks = deps.locks || null;
    this.scheduler = deps.scheduler || {
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (...a) => clearTimeout(...a),
    };

    this.started = false;
    this.isLeader = false;
    this.running = false; // pump 是否在运转（含睡眠）
    this.sleepTimer = null;
    this.inflight = null; // { id, controller }
    this.paused = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    // 崩溃 / 卸载恢复：上次处于 running/waiting 的条目归位为 queued/blocked。
    const stale = await this.store.getAllQueue();
    for (const item of stale) {
      if (item.status === STATUS.RUNNING) {
        item.status = STATUS.QUEUED;
        item.updatedAt = nowTs();
        await this.store.putQueue(item);
      }
    }

    this.network.onChange?.((payload) => this._onNetworkChange(payload));
    if (this.bus) {
      this.bus.addEventListener('message', (ev) => this._onBusMessage(ev.data));
    }

    await this._acquireLeadership();
    this._wake();
  }

  async stop() {
    this.started = false;
    this._clearSleep();
    this._abortInflight('stop');
  }

  // ---------- 多标签页选主：只有 leader 标签页执行重放 ----------
  async _acquireLeadership() {
    if (!this.locks?.request) {
      this.isLeader = true;
      return;
    }
    const release = await new Promise((resolve) => {
      this.locks.request('offline-queue-replayer', () => new Promise((rel) => resolve(rel)));
    });
    this.isLeader = true;
    this._lockRelease = release;
  }

  _onNetworkChange({ online } = {}) {
    this._postBus({ type: 'network', online });
    if (online) this._wake();
    else this._goOffline();
  }

  _onBusMessage(msg) {
    if (!msg || msg.type === 'ping') return;
    // 数据类变更：刷新视图；控制类变更：唤醒 pump。
    if (msg.type === 'mutated' || msg.type === 'network') {
      this.emit('changed');
      this._wake();
      if (msg.type === 'network' && msg.online) this._wake();
    } else if (msg.type === 'replay-now') {
      this._wake();
    }
  }

  _postBus(msg) {
    try {
      this.bus?.postMessage(msg);
    } catch {
      /* 频道关闭时忽略 */
    }
  }

  // ---------- 重放泵：严格按 id 顺序逐条处理 ----------
  _wake() {
    if (!this.started || !this.isLeader || this.running) return;
    if (!this.network.isOnline()) return; // 离线不起泵，由联网事件唤醒
    this.running = true;
    this.paused = false;
    this.emit('replay-state', { state: 'running' });
    Promise.resolve().then(() => this._pump());
  }


  _abortInflight(reason) {
    if (!this.inflight) return;
    this.inflight.reason = reason;
    this.inflight.controller.abort(new Error(reason));
  }

  _goOffline() {
    // 离线：终止在途请求并停泵，恢复在线后由网络事件重新唤醒。
    this._clearSleep();
    this._abortInflight('offline');
    this.paused = true;
    this.emit('replay-state', { state: 'offline' });
  }

  async _pump() {
    try {
      while (this.started && this.isLeader) {
        if (!this.network.isOnline()) {
          this.emit('replay-state', { state: 'offline' });
          return;
        }
        const queue = (await this.store.getAllQueue())
          .filter((it) => it.status !== STATUS.SUCCEEDED)
          .sort((a, b) => a.id - b.id);
        const head = queue[0];
        if (!head) {
          this.emit('replay-state', { state: 'idle' });
          return;
        }
        if (head.status === STATUS.BLOCKED) {
          // 头部条目彻底失败会阻塞后续请求，等待人工取消/重试。
          this.emit('replay-state', { state: 'blocked', itemId: head.id });
          return;
        }
        // 失败退避：按当前条目 attempt 数计算等待，可被“立即重放”打断。
        if (head.status === STATUS.WAITING && head.nextAttemptAt > nowTs()) {
          this.emit('replay-state', { state: 'backoff', itemId: head.id });
          const woken = await this._sleep(head.nextAttemptAt - nowTs());
          if (woken === 'wake') {
            // 手动重放：跳过退避，条目回到排队态立即再试。
            const fresh = await this.store.getQueue(head.id);
            if (fresh && fresh.status === STATUS.WAITING) {
              fresh.status = STATUS.QUEUED;
              await this.store.putQueue(fresh);
              this.emit('changed');
              this._postBus({ type: 'mutated' });
            }
          }
          continue;
        }

        const result = await this._attempt(head);
        if (result === 'offline') {
          this.emit('replay-state', { state: 'offline' });
          return;
        }
        if (result === 'interrupted') return;
      }
    } finally {
      // 关键：只有真正结束循环才释放 running，联网/手动唤醒才能重新起泵。
      this.running = false;
    }
  }

  async _sleep(ms) {
    return new Promise((resolve) => {
      this.sleepTimer = this.scheduler.setTimeout(() => {
        this.sleepTimer = null;
        this._sleepResolve = null;
        resolve('timeout');
      }, ms);
      this._sleepResolve = () => {
        if (this.sleepTimer) this.scheduler.clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
        this._sleepResolve = null;
        resolve('wake');
      };
    });
  }

  _clearSleep() {
    if (this.sleepTimer) {
      this.scheduler.clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (this._sleepResolve) {
      const resolve = this._sleepResolve;
      this._sleepResolve = null;
      resolve('wake');
    }
  }

  // 单次真实投递。返回 'succeeded' | 'retriable' | 'permanent' | 'offline' | 'interrupted'。
  async _attempt(item) {
    if (!this.AbortCtl) return 'interrupted';
    const controller = new this.AbortCtl();
    this.inflight = { id: item.id, controller };

    item.status = STATUS.RUNNING;
    item.attempts += 1;
    item.lastAttemptAt = nowTs();
    await this.store.putQueue(item);
    this.emit('changed');
    this._postBus({ type: 'mutated' });

    const attemptRecord = { at: item.lastAttemptAt, kind: 'attempt', offline: !this.network.isOnline() };
    let outcome;
    let timeoutHandle = null;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutHandle = this.scheduler.setTimeout(
          () => reject(Object.assign(new Error('请求超时'), { name: 'TimeoutError' })),
          this.opts.attemptTimeoutMs,
        );
      });
      const headers = { ...item.request.headers };
      if (item.request.body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      if (item.attempts > 1) headers['X-Queue-Replay'] = String(item.attempts - 1);
      const res = await Promise.race([
        this.fetchImpl(item.request.url, {
          method: item.request.method,
          headers,
          body: item.request.body,
          signal: controller.signal,
        }),
        timeout,
      ]);
      this.scheduler.clearTimeout(timeoutHandle);

      if (res.ok) {
        outcome = { ok: true, status: res.status };
      } else if (isRetriableStatus(res.status)) {
        outcome = { ok: false, retriable: true, status: res.status, error: `HTTP ${res.status}` };
      } else {
        outcome = { ok: false, retriable: false, status: res.status, error: `HTTP ${res.status}（永久失败）` };
      }
    } catch (err) {
      if (timeoutHandle) this.scheduler.clearTimeout(timeoutHandle);
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        const reason = this.inflight?.reason || (this.network.isOnline() ? 'manual' : 'offline');
        this.inflight = null;
        // 取消 / 清空 / 停止 / 卸载：条目已删除或即将落盘，绝不在此“复活”。
        if (reason === 'cancel' || reason === 'clear' || reason === 'stop' || reason === 'unload') {
          return 'interrupted';
        }
        // 离线导致的中断：不消耗重试次数，条目归队等待联网补偿。
        if (reason === 'offline' || !this.network.isOnline()) {
          const fresh = await this.store.getQueue(item.id);
          if (fresh && fresh.status === STATUS.RUNNING) {
            fresh.status = STATUS.QUEUED;
            fresh.attempts = Math.max(0, fresh.attempts - 1); // 离线中断不消耗重试
            fresh.updatedAt = nowTs();
            await this.store.putQueue(fresh);
            this.emit('changed');
            this._postBus({ type: 'mutated' });
          }
          return 'offline';
        }
        outcome = { ok: false, retriable: true, error: '请求被中止' };
      } else if (err?.name === 'TimeoutError') {
        outcome = { ok: false, retriable: true, error: '请求超时' };
      } else {
        // 典型网络错误（TypeError: Failed to fetch）说明断网。
        if (!this.network.isOnline()) {
          this.inflight = null;
          return 'offline';
        }
        outcome = { ok: false, retriable: true, error: err?.message || '网络错误' };
      }
    }
    this.inflight = null;

    if (outcome.ok) {
      await this._finishSuccess(item, outcome, attemptRecord);
      return 'succeeded';
    }

    // 记录本次失败尝试，再决定退避 / 阻塞 / 永久失败。
    item.attemptRecords.push({ ...attemptRecord, ok: false, error: outcome.error, status: outcome.status });
    const exhausted = item.attempts >= this.opts.maxAttempts;
    if (!outcome.retriable) {
      await this._finishFailure(item, outcome.error, 'permanent');
      return 'permanent';
    }
    if (exhausted) {
      await this._finishFailure(item, `${outcome.error}；已达 ${this.opts.maxAttempts} 次尝试上限`, 'blocked');
      return 'permanent';
    }
    const delay = backoffDelay(item.attempts, this.opts.baseDelayMs, this.opts.maxDelayMs);
    item.status = STATUS.WAITING;
    item.lastError = outcome.error;
    item.nextAttemptAt = nowTs() + delay;
    item.updatedAt = nowTs();
    await this.store.putQueue(item);
    this.emit('changed');
    this._postBus({ type: 'mutated' });
    return 'retriable';
  }

  async _finishSuccess(item, outcome, attemptRecord) {
    item.attemptRecords.push({ ...attemptRecord, ok: true, status: outcome.status });
    item.status = STATUS.SUCCEEDED;
    item.lastError = null;
    item.completedAt = nowTs();
    await this.store.putQueue(item);
    await this.store.deleteQueue(item.id);
    await this.store.addHistory(this._toHistory(item, {
      ok: true,
      status: outcome.status,
      error: null,
    }));
    this.emit('changed');
    this._postBus({ type: 'mutated' });
  }

  async _finishFailure(item, error, kind) {
    item.lastError = error;
    item.completedAt = nowTs();
    if (kind === 'blocked') {
      item.status = STATUS.BLOCKED;
      await this.store.putQueue(item);
    } else {
      item.status = STATUS.FAILED;
      await this.store.putQueue(item);
      await this.store.deleteQueue(item.id);
      await this.store.addHistory(this._toHistory(item, { ok: false, status: null, error }));
    }
    this.emit('changed');
    this._postBus({ type: 'mutated' });
  }

  // ---------- 公开操作 API ----------

  /**
   * 发起请求：在线时照常进入队列并立即重放；离线时排队等待。
   * 相同指纹的未完成请求会被去重（合并计数）。
   * 队列超长时截断最老的“排队中”请求。
   */
  async enqueue(input) {
    const request = normalizeRequest(input);
    if (!request.url) throw new TypeError('url 不能为空');

    const fp = fingerprint(request);
    const queue = await this.store.getAllQueue();

    const dup = queue.find((it) => it.fingerprint === fp && it.status !== STATUS.SUCCEEDED);
    if (dup) {
      dup.duplicateCount += 1;
      dup.updatedAt = nowTs();
      await this.store.putQueue(dup);
      this.emit('changed');
      this._postBus({ type: 'mutated' });
      return { deduped: true, item: dup };
    }

    const active = queue.filter((it) => it.status !== STATUS.SUCCEEDED);
    if (active.length >= this.opts.maxQueue) {
      // 截断：优先淘汰最老且尚未开始尝试的排队请求。
      const victim = active
        .filter((it) => it.status === STATUS.QUEUED && it.attempts === 0)
        .sort((a, b) => a.id - b.id)[0];
      if (!victim) {
        throw new QueueFullError(
          `队列已满（${this.opts.maxQueue} 条），且全部正在处理中，无法截断，请稍后重试或取消部分请求`,
        );
      }
      await this._drop(victim, '队列超长截断');
    }

    const ts = nowTs();
    const item = {
      id: await this.store.nextId(),
      request,
      fingerprint: fp,
      status: STATUS.QUEUED,
      attempts: 0,
      duplicateCount: 0,
      attemptRecords: [],
      lastError: null,
      nextAttemptAt: null,
      createdAt: ts,
      updatedAt: ts,
      completedAt: null,
    };
    await this.store.putQueue(item);
    this.emit('changed');
    this._postBus({ type: 'mutated' });
    this._wake();
    return { deduped: false, item };
  }

  async _drop(item, reason) {
    await this.store.deleteQueue(item.id);
    item.status = STATUS.DROPPED;
    item.lastError = reason;
    item.completedAt = nowTs();
    await this.store.addHistory(this._toHistory(item, { ok: false, status: null, error: reason }));
    this.emit('item-dropped', { item, reason });
  }

  // 取消单条（无论什么状态；在途请求会被 abort）。
  async cancel(id) {
    const item = await this.store.getQueue(id);
    if (!item) return false;
    if (this.inflight?.id === id) {
      this._abortInflight('cancel');
    }
    const wasHeadBlocked = item.status === STATUS.BLOCKED;
    this._clearSleep();
    item.status = STATUS.FAILED;
    item.lastError = '用户取消';
    item.completedAt = nowTs();
    await this.store.deleteQueue(id);
    await this.store.addHistory(this._toHistory(item, { ok: false, status: null, error: '用户取消' }));
    this.emit('changed');
    this._postBus({ type: 'mutated' });
    if (wasHeadBlocked) this._wake();
    return true;
  }

  // 手动重试单条：重置退避/阻塞状态（保留尝试明细，但重试计数清零）。
  async retryItem(id) {
    const item = await this.store.getQueue(id);
    if (!item) return false;
    if (this.inflight?.id === id) return true;
    item.status = STATUS.QUEUED;
    item.attempts = 0;
    item.lastError = null;
    item.nextAttemptAt = null;
    item.updatedAt = nowTs();
    await this.store.putQueue(item);
    this._clearSleep();
    this.emit('changed');
    this._postBus({ type: 'mutated' });
    this._wake();
    return true;
  }

  // 一键重试所有失败（blocked）条目。
  async retryFailed() {
    const queue = await this.store.getAllQueue();
    const failed = queue.filter((it) => it.status === STATUS.BLOCKED || it.status === STATUS.WAITING);
    for (const item of failed) {
      item.status = STATUS.QUEUED;
      item.attempts = 0;
      item.lastError = null;
      item.nextAttemptAt = null;
      item.updatedAt = nowTs();
      await this.store.putQueue(item);
    }
    if (failed.length) {
      this._clearSleep();
      this.emit('changed');
      this._postBus({ type: 'mutated' });
      this._wake();
    }
    return failed.length;
  }

  // 清空队列（成功的不动；未完成请求全部标记为已清除并写入历史）。
  async clearQueue() {
    const queue = await this.store.getAllQueue();
    for (const item of queue) {
      if (item.status === STATUS.SUCCEEDED) continue;
      if (this.inflight?.id === item.id) this._abortInflight('clear');
      item.status = STATUS.FAILED;
      item.lastError = '队列被清空';
      item.completedAt = nowTs();
      await this.store.addHistory(this._toHistory(item, { ok: false, status: null, error: '队列被清空' }));
    }
    await this.store.clearQueue();
    this.emit('changed');
    this._postBus({ type: 'mutated' });
    return queue.length;
  }

  // 手动触发：跳过退避立即重放。
  replayNow() {
    this._postBus({ type: 'replay-now' });
    if (!this.network.isOnline()) return false;
    if (!this.running) {
      this._wake();
    } else {
      // 正在退避睡眠中则提前唤醒；正在发送中则等当前条目完成后继续。
      this._clearSleep();
    }
    return true;
  }

  setMaxQueue(n) {
    this.opts.maxQueue = Math.max(1, Number(n) || DEFAULT_OPTIONS.maxQueue);
  }
  setMaxAttempts(n) {
    this.opts.maxAttempts = Math.max(1, Number(n) || DEFAULT_OPTIONS.maxAttempts);
  }

  // 页面卸载：中断在途请求并把状态落盘；释放重放锁给其它标签页。
  async flushAndUnload() {
    await this._persistInflight();
    this._lockRelease?.();
    this._lockRelease = null;
    this.isLeader = false;
    this.running = false;
  }

  // 页面隐藏（移动端切后台）：在途请求归位落盘，但保留锁与可恢复状态。
  async flushAndPause() {
    this._clearSleep();
    await this._persistInflight();
  }

  async _persistInflight() {
    if (!this.inflight) return;
    const item = await this.store.getQueue(this.inflight.id);
    this._abortInflight('unload');
    if (item && item.status === STATUS.RUNNING) {
      item.status = STATUS.QUEUED;
      item.attempts = Math.max(0, item.attempts - 1); // 隐藏/卸载中断不消耗重试
      item.updatedAt = nowTs();
      await this.store.putQueue(item);
    }
  }

  // 从后台 / bfcache 回到页面：重新拿锁并唤醒重放。
  async resume() {
    if (!this.started) return this.start();
    if (!this.isLeader) await this._acquireLeadership();
    this._wake();
  }

  _toHistory(item, result) {
    return {
      id: item.id,
      request: item.request,
      fingerprint: item.fingerprint,
      state: item.status,
      ok: result.ok,
      status: result.status,
      error: result.error,
      attempts: item.attempts,
      duplicateCount: item.duplicateCount,
      attemptRecords: item.attemptRecords,
      dropped: item.status === STATUS.DROPPED,
      createdAt: item.createdAt,
      completedAt: item.completedAt || nowTs(),
    };
  }
}
