/*
 * 离线检测：浏览器 online/offline 事件 + Service Worker mock 状态 + 定时心跳三重信号。
 * - navigator.onLine=false       => 直接判离线；
 * - navigator.onLine=true        => 心跳探测 /api/ping 确认真正可达，防「假在线」；
 * - 强制离线开关(mock forceOffline) => 判离线；
 * - 网络抖动：心跳失败后立即复检一次，连续失败才标记离线；恢复同理需探测成功。
 */

const HEARTBEAT_MS = 5000;
const PROBE_TIMEOUT_MS = 4000;

export class NetworkMonitor {
  constructor(bus, { heartbeatMs = HEARTBEAT_MS } = {}) {
    this.bus = bus;
    this.heartbeatMs = heartbeatMs;
    this.online = null; // null = 尚未探测
    this.forceOffline = false;
    this.history = []; // { start, end? }
    this.probeInFlight = false;
    this.timer = null;
    this.listeners = new Set();
  }

  start() {
    window.addEventListener('online', this.handleBrowserEvent);
    window.addEventListener('offline', this.handleBrowserEvent);
    document.addEventListener('visibilitychange', this.handleVisibility);

    // 恢复上次离线区间（同一会话内）
    this.timer = setInterval(() => this.probe(), this.heartbeatMs);
    this.probe();
  }

  stop() {
    window.removeEventListener('online', this.handleBrowserEvent);
    window.removeEventListener('offline', this.handleBrowserEvent);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    clearInterval(this.timer);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setForceOffline(value) {
    this.forceOffline = Boolean(value);
    this.probe();
  }

  handleBrowserEvent = () => {
    // 事件只作为触发，真实状态以心跳结果为准
    this.probe();
  };

  handleVisibility = () => {
    if (!document.hidden) this.probe();
  };

  async probe() {
    if (this.probeInFlight) return this.online;
    this.probeInFlight = true;
    try {
      const browserSaysOffline = navigator.onLine === false;
      if (browserSaysOffline || this.forceOffline) {
        this.commit(false, this.forceOffline ? 'mock 强制离线' : '浏览器报告离线');
        return false;
      }

      const reachable = await this.ping();
      if (reachable) {
        this.commit(true, '心跳可达');
        return true;
      }

      // 抖动复检：短暂等待后再探一次
      await new Promise((r) => setTimeout(r, 800));
      const secondTry = await this.ping();
      this.commit(secondTry, secondTry ? '心跳恢复' : '心跳连续失败');
      return secondTry;
    } finally {
      this.probeInFlight = false;
    }
  }

  async ping() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/ping?_=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  commit(next, reason) {
    const prev = this.online;
    this.online = next;

    if (prev === false && next === true) {
      const last = this.history[this.history.length - 1];
      if (last && last.end == null) last.end = Date.now();
    } else if (next === false && (prev === true || prev === null)) {
      this.history.push({ start: Date.now(), end: null });
      if (this.history.length > 20) this.history.shift();
    }

    if (prev !== next) {
      for (const fn of this.listeners) {
        try { fn(next, reason); } catch (err) { console.error('[network] listener error:', err); }
      }
      this.bus.emit('network:changed', { online: next, reason, at: Date.now() });
    }
    this.bus.dispatchLocal({ event: 'network:tick', data: { online: next, reason } });
  }

  /** 提供给时序图绘制离线背景带。 */
  offlineRanges(now = Date.now()) {
    return this.history.map((range) => ({
      start: range.start,
      end: range.end ?? now,
    }));
  }
}
