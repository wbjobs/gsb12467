// 离线检测：navigator.onLine + online/offline 事件 + 心跳探针三结合。
// - online 事件后必须探针成功才认为真正联网（防“假在线”）。
// - offline 事件立即判离线；探针连续失败 2 次也判离线（事件不可靠时兜底）。
// 网络抖动场景下通过“失败需确认”避免状态来回横跳。
import { TypedEventEmitter, nowTs } from './utils.js';

export class NetworkMonitor extends TypedEventEmitter {
  constructor({ probeUrl = '/probe', probeTimeoutMs = 4000, intervalMs = 15000, fetchImpl } = {}) {
    super();
    this.probeUrl = probeUrl;
    this.probeTimeoutMs = probeTimeoutMs;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a, { cache: 'no-store' }));
    this.AbortCtl = typeof AbortController !== 'undefined' ? AbortController : null;

    this.online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    this.forceOffline = false;
    this.consecutiveFailures = 0;
    this.probing = false;
    this.timer = null;
    this.lastChangeAt = nowTs();
    this.log = [{ at: this.lastChangeAt, online: this.online, reason: 'init' }];
  }

  isOnline() {
    return this.online && !this.forceOffline;
  }

  start() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this._handleBrowserEvent(true));
      window.addEventListener('offline', () => this._handleBrowserEvent(false));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.probe('visible');
      });
    }
    this._schedule();
    this.probe('init');
  }

  setForceOffline(value) {
    this.forceOffline = Boolean(value);
    this._setState(!this.forceOffline && this.online, this.forceOffline ? '模拟离线' : '取消模拟');
  }

  _handleBrowserEvent(online) {
    this.online = online;
    if (online) {
      // 事件只作为线索，需探针确认，避免连上无网络的热点时误判。
      this.probe('online-event');
    } else {
      this.consecutiveFailures = 0;
      this._setState(false, '浏览器 offline 事件');
    }
  }

  _schedule() {
    this.timer = setInterval(() => this.probe('poll'), this.intervalMs);
  }

  async probe(reason = 'manual') {
    if (this.probing || this.forceOffline) return this.isOnline();
    this.probing = true;
    let ok = false;
    try {
      const ctl = this.AbortCtl ? new this.AbortCtl() : null;
      const timer = setTimeout(() => ctl?.abort(new Error('probe-timeout')), this.probeTimeoutMs);
      const res = await this.fetchImpl(`${this.probeUrl}?t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: ctl?.signal,
      });
      clearTimeout(timer);
      // SW 探针对真实不可达返回 503；普通 404 等响应反而说明链路可达。
      ok = res.status < 500;
    } catch {
      ok = false;
    }
    this.probing = false;

    if (ok) {
      this.consecutiveFailures = 0;
      this._setState(true, `探针成功（${reason}）`);
    } else {
      this.consecutiveFailures += 1;
      // offline 事件缺失（某些桌面环境）时，连续两次探针失败兜底判离线。
      if (!this.online || this.consecutiveFailures >= 2) {
        this.online = false;
        this._setState(false, `探针失败 ×${this.consecutiveFailures}（${reason}）`);
      }
    }
    return this.isOnline();
  }

  _setState(next, reason) {
    const effective = next && !this.forceOffline;
    if (effective === this.isOnline() && this.log.some((e) => e.online === effective)) return;
    this.online = next;
    this.lastChangeAt = nowTs();
    this.log.push({ at: this.lastChangeAt, online: effective, reason });
    if (this.log.length > 200) this.log.shift();
    this.emit('change', { online: effective, reason });
  }
}
