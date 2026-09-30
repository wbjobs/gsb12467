/* DOM 绑定：表单、队列列表、历史、统计、弱网模拟控件。 */

import { STATUS, formatTime, relativeCountdown, escapeHtml } from './utils.js';

const STATUS_LABEL = {
  queued: '排队中',
  sending: '发送中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  dropped: '已截断',
};

export class AppUI {
  constructor({ queue, network, timeline }) {
    this.queue = queue;
    this.network = network;
    this.timeline = timeline;
    this.$ = (id) => document.getElementById(id);
    this.toastTimer = null;
  }

  init() {
    this.bindForm();
    this.bindControls();
    this.bindListDelegation();
    this.bindNetwork();

    this.$('maxQueue').value = this.queue.settings.maxQueueLength;
    this.$('dedupWindow').value = this.queue.settings.dedupWindowMs / 1000;
    this.$('dedupOut').textContent = this.queue.settings.dedupWindowMs / 1000;

    this.renderAll();
  }

  /* ---------------- 事件绑定 ---------------- */

  bindForm() {
    this.$('requestForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const method = this.$('reqMethod').value;
      const url = this.$('reqPath').value.split(' ')[0].trim();
      const body = this.$('reqBody').value.trim();

      if (!url.startsWith('/')) {
        this.toast('路径需以 / 开头（演示使用同源相对路径）', true);
        return;
      }

      try {
        const result = await this.queue.enqueue({ method, url, body: body || null });
        if (result.duplicated) {
          this.toast(`命中去重：#${result.item.seq} ${result.item.method} ${result.item.url}（窗口内重复请求已合并）`);
        } else if (this.network.online === false) {
          this.toast(`当前离线，#${result.item.seq} 已入队，联网后按序自动重放`);
        } else {
          this.toast(`#${result.item.seq} 已入队`);
        }
      } catch (err) {
        this.toast(`入队失败：${err.message}`, true);
      }
      this.renderAll();
    });

    this.$('btnFlush').addEventListener('click', () => {
      if (this.network.online === false) {
        this.toast('当前离线，无法重放；恢复联网后会自动执行', true);
        return;
      }
      this.queue.flush();
      this.toast('已触发顺序重放');
    });

    this.$('btnClearQueue').addEventListener('click', async () => {
      await this.queue.clearQueue();
      this.toast('队列已清空（未完成项标记为已取消，历史保留）');
      this.renderAll();
    });

    this.$('btnClearHistory').addEventListener('click', async () => {
      await this.queue.clearHistory();
      this.toast('历史记录已清空');
      this.renderAll();
    });
  }

  bindControls() {
    this.$('maxQueue').addEventListener('change', async (event) => {
      const value = Math.max(1, Math.min(999, Number(event.target.value) || 10));
      event.target.value = value;
      await this.queue.updateSettings({ maxQueueLength: value });
      this.toast(`队列上限设为 ${value}，超出部分将截断最旧排队项`);
      this.renderAll();
    });

    const dedup = this.$('dedupWindow');
    dedup.addEventListener('input', (event) => {
      this.$('dedupOut').textContent = event.target.value;
    });
    dedup.addEventListener('change', async (event) => {
      await this.queue.updateSettings({ dedupWindowMs: Number(event.target.value) * 1000 });
      this.toast(event.target.value === '0' ? '去重已关闭' : `去重窗口设为 ${event.target.value} 秒`);
    });

    // 弱网模拟 -> 下发给 Service Worker + 网络监测
    this.$('forceOffline').addEventListener('change', (event) => {
      this.sendMockConfig({ forceOffline: event.target.checked });
      this.network.setForceOffline(event.target.checked);
      this.toast(event.target.checked ? '已强制离线：新请求将进入队列' : '已取消强制离线');
    });

    const failRate = this.$('failRate');
    failRate.addEventListener('input', () => {
      this.$('failRateOut').textContent = `${failRate.value}%`;
    });
    failRate.addEventListener('change', () => {
      this.sendMockConfig({ failRate: Number(failRate.value) });
    });

    const latency = this.$('latency');
    latency.addEventListener('input', () => {
      this.$('latencyOut').textContent = `${latency.value}ms`;
    });
    latency.addEventListener('change', () => {
      this.sendMockConfig({ latency: Number(latency.value) });
    });
  }

  sendMockConfig(patch) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      this.toast('Service Worker 尚未接管，刷新页面后模拟控制生效', true);
      return;
    }
    navigator.serviceWorker.controller.postMessage({ type: 'mock-config', ...patch });
  }

  bindListDelegation() {
    const handler = async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const { action, id } = button.dataset;
      if (action === 'cancel') {
        await this.queue.cancelItem(id);
        this.toast('已取消该请求');
      } else if (action === 'retry') {
        await this.queue.retryItem(id);
        this.toast('已重置并重试该请求');
      } else if (action === 'remove') {
        await this.queue.removeItem(id);
        this.toast('已移除该历史记录');
      }
      this.renderAll();
    };
    this.$('queueList').addEventListener('click', handler);
    this.$('historyList').addEventListener('click', handler);
  }

  bindNetwork() {
    this.network.onChange((online, reason) => {
      this.renderNetBadge(online, reason);
      this.renderAll();
      if (online) this.toast(`网络已恢复（${reason}），开始按序重放队列`);
      else this.toast(`网络已断开（${reason}），请求将进入队列`);
    });
    this.network.bus.on('network:tick', ({ online, reason }) => {
      this.renderNetBadge(online, reason);
    });

    // 所有队列相关事件统一重渲染
    for (const event of ['queue:changed', 'queue:item-updated', 'queue:enqueued',
      'queue:truncated', 'queue:flushed', 'queue:leader']) {
      this.network.bus.on(event, () => this.renderAll());
    }
  }

  /* ---------------- 渲染 ---------------- */

  renderAll() {
    this.renderStats();
    this.renderQueue();
    this.renderHistory();
    this.timeline.draw();
  }

  renderNetBadge(online, reason) {
    const wrap = this.$('netStatus');
    const dot = this.$('netDot');
    const label = this.$('netLabel');
    wrap.classList.remove('online', 'offline', 'checking');
    if (online === true) {
      wrap.classList.add('online');
      label.textContent = '在线';
      dot.style.background = '';
    } else if (online === false) {
      wrap.classList.add('offline');
      label.textContent = `离线 · ${reason || ''}`;
    } else {
      wrap.classList.add('checking');
      label.textContent = '连通性探测中…';
    }
  }

  renderStats() {
    const count = (status) => this.queue.items.filter((i) => i.status === status).length;
    this.$('statQueued').textContent = this.queue.items.filter(
      (i) => i.status === STATUS.QUEUED || (i.status === STATUS.FAILED && i.nextAttemptAt != null)
    ).length;
    this.$('statSending').textContent = count(STATUS.SENDING);
    this.$('statFailed').textContent = this.queue.items.filter(
      (i) => i.status === STATUS.FAILED && i.nextAttemptAt == null
    ).length;
    this.$('statDone').textContent = count(STATUS.SUCCESS);
    this.$('statDropped').textContent = count(STATUS.CANCELLED) + count(STATUS.DROPPED);
  }

  itemTemplate(item, { compact = false } = {}) {
    const status = item.status;
    const now = Date.now();
    let extraMeta = '';
    if (status === STATUS.FAILED && item.nextAttemptAt != null) {
      extraMeta = `<span>⏱ ${relativeCountdown(item.nextAttemptAt, now)}s 后自动重试</span>`;
    }
    if (item.dupCount > 0) {
      extraMeta += `<span>🔁 去重合并 ×${item.dupCount + 1}</span>`;
    }

    const bodyPreview = item.body
      ? `<span title="${escapeHtml(item.body)}">body: ${escapeHtml(item.body).slice(0, 40)}${item.body.length > 40 ? '…' : ''}</span>`
      : '';

    const actions = compact
      ? (status === STATUS.SUCCESS || status === STATUS.CANCELLED || status === STATUS.DROPPED
        ? `<button data-action="remove" data-id="${item.id}" class="ghost">删除</button>` : '')
      : this.actionButtons(item);

    const errorLine = item.error ? `<div class="item-error">${escapeHtml(item.error)}</div>` : '';

    return `
      <li class="item status-${status}">
        <div class="item-top">
          <span class="method">${escapeHtml(item.method)}</span>
          <span class="path">#${item.seq} ${escapeHtml(item.url)}</span>
          <span class="badge status-${status}">${STATUS_LABEL[status] || status}</span>
        </div>
        <div class="item-meta">
          <span>重试 ${item.attempts}/${this.queue.settings.maxAttempts}</span>
          <span>入队 ${formatTime(item.createdAt)}</span>
          ${item.finishedAt ? `<span>完成 ${formatTime(item.finishedAt)}</span>` : ''}
          ${item.responseStatus ? `<span>HTTP ${item.responseStatus}</span>` : ''}
          ${bodyPreview}
          ${extraMeta}
        </div>
        ${errorLine}
        ${actions ? `<div class="item-actions">${actions}</div>` : ''}
      </li>`;
  }

  actionButtons(item) {
    const cancelable = item.status === STATUS.QUEUED || item.status === STATUS.SENDING ||
      (item.status === STATUS.FAILED && item.nextAttemptAt != null);
    const retryable = item.status === STATUS.FAILED;
    return `
      ${cancelable ? `<button data-action="cancel" data-id="${item.id}" class="danger-ghost">取消</button>` : ''}
      ${retryable ? `<button data-action="retry" data-id="${item.id}">手动重试</button>` : ''}
    `;
  }

  renderQueue() {
    const active = new Set([STATUS.QUEUED, STATUS.SENDING]);
    const items = this.queue.items
      .filter((i) => active.has(i.status) || i.status === STATUS.FAILED)
      .sort((a, b) => a.seq - b.seq);

    this.$('queueList').innerHTML = items.map((i) => this.itemTemplate(i)).join('');
    this.$('queueEmpty').hidden = items.length > 0;
  }

  renderHistory() {
    const terminal = new Set([STATUS.SUCCESS, STATUS.CANCELLED, STATUS.DROPPED]);
    const items = this.queue.items
      .filter((i) => terminal.has(i.status))
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, 50);

    this.$('historyList').innerHTML = items.map((i) => this.itemTemplate(i, { compact: true })).join('');
    this.$('historyEmpty').hidden = items.length > 0;
  }

  toast(message, isError = false) {
    const el = this.$('toast');
    el.textContent = message;
    el.hidden = false;
    el.style.borderColor = isError ? 'var(--danger)' : 'var(--border)';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
}
