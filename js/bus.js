/* BroadcastChannel 封装：跨标签页同步队列状态，同标签也走同一份订阅接口。 */

export class EventBus {
  constructor(channelName = 'offline-request-queue') {
    this.listeners = new Map();
    this.channel = null;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (event) => this.dispatchLocal(event.data);
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  dispatchLocal(payload) {
    const handlers = this.listeners.get(payload.event);
    if (handlers) {
      for (const handler of [...handlers]) {
        try {
          handler(payload.data);
        } catch (err) {
          console.error('[bus] handler error:', err);
        }
      }
    }
  }

  /** 广播给其它标签页；本标签页由发起方自行触发本地监听，避免重复处理。 */
  broadcast(event, data) {
    if (this.channel) {
      this.channel.postMessage({ event, data });
    }
  }

  /** 本标签页发事件：本地监听器立即收到，同时广播给其它标签页。 */
  emit(event, data) {
    this.dispatchLocal({ event, data });
    this.broadcast(event, data);
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }
}
