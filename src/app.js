// 应用入口：组装存储 / 网络 / 引擎 / 时序图，并完成全部 DOM 交互。
import { OfflineQueueEngine, QueueFullError } from './engine.js';
import { IndexedDbStore } from './store-idb.js';
import { NetworkMonitor } from './network.js';
import { Timeline } from './timeline.js';
import { STATUS, STATUS_LABEL, formatDateTime, formatTime } from './utils.js';

const $ = (id) => document.getElementById(id);

const els = {
  conn: $('connIndicator'), connDot: $('connDot'), connText: $('connText'), connExtra: $('connExtra'),
  method: $('reqMethod'), url: $('reqUrl'), body: $('reqBody'),
  btnEnqueue: $('btnEnqueue'), btnStress: $('btnStress'),
  btnReplay: $('btnReplay'), btnRetryFailed: $('btnRetryFailed'), btnClear: $('btnClear'),
  forceOffline: $('forceOffline'), maxQueue: $('maxQueue'), maxAttempts: $('maxAttempts'), failRate: $('failRate'),
  stats: {
    queued: $('statQueued'), running: $('statRunning'), failed: $('statFailed'), done: $('statDone'),
  },
  replayState: $('replayState'),
  queueList: $('queueList'), queueEmpty: $('queueEmpty'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'),
  historyFilter: $('historyFilter'), btnClearHistory: $('btnClearHistory'),
  toastWrap: $('toastWrap'),
};

const REPLAY_LABEL = {
  idle: '空闲（队列已处理完）',
  running: '正在按序重放…',
  backoff: '失败退避等待中…',
  blocked: '队首请求失败，等待人工处理',
  offline: '离线中，已暂停',
  paused: '已暂停',
};

const store = new IndexedDbStore();
const network = new NetworkMonitor({ probeUrl: '/probe' });
const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('offline-queue') : null;

const engine = new OfflineQueueEngine({
  store,
  network,
  bus,
  locks: typeof navigator !== 'undefined' ? navigator.locks : null,
  opts: {
    maxQueue: Number(els.maxQueue.value) || 8,
    maxAttempts: Number(els.maxAttempts.value) || 4,
  },
});

const timeline = new Timeline($('timelineCanvas'), $('timelineTooltip'), () => ({
  queue: snapshot.queue,
  history: snapshot.history,
  netLog: network.log,
}));

const snapshot = { queue: [], history: [] };

// ---------- 渲染 ----------
async function refresh() {
  snapshot.queue = await store.getAllQueue();
  snapshot.history = await store.getAllHistory();
  renderStats();
  renderQueue();
  renderHistory();
  timeline.draw();
}

function renderStats() {
  const q = snapshot.queue;
  els.stats.queued.textContent = q.filter((i) => i.status === STATUS.QUEUED).length;
  els.stats.running.textContent = q.filter((i) => i.status === STATUS.RUNNING || i.status === STATUS.WAITING).length;
  els.stats.failed.textContent = q.filter((i) => i.status === STATUS.BLOCKED).length;
  els.stats.done.textContent = snapshot.history.filter((i) => i.ok).length;
}

function renderQueue() {
  const items = [...snapshot.queue].sort((a, b) => a.id - b.id);
  els.queueList.replaceChildren();
  els.queueEmpty.hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'q-item';
    const canRetry = item.status === STATUS.BLOCKED || item.status === STATUS.WAITING || item.status === STATUS.FAILED;
    li.innerHTML = `
      <div class="q-head">
        <span class="q-id">#${item.id}</span>
        <span class="q-method">${item.request.method}</span>
        <span class="q-url">${escapeHtml(item.request.url)}</span>
        <span class="badge ${item.status}">${STATUS_LABEL[item.status]}</span>
        ${item.duplicateCount ? `<span class="badge dup">重复 ×${item.duplicateCount + 1}</span>` : ''}
      </div>
      <div class="q-meta">
        <span>顺序：#${item.id}</span>
        <span>尝试：${item.attempts} 次</span>
        <span>创建：${formatTime(item.createdAt)}</span>
        ${item.nextAttemptAt && item.status === STATUS.WAITING ? `<span>下次：${formatTime(item.nextAttemptAt)}</span>` : ''}
      </div>
      ${item.lastError ? `<div class="q-error">${escapeHtml(item.lastError)}</div>` : ''}
      <div class="q-actions">
        ${canRetry ? '<button data-act="retry">立即重试</button>' : ''}
        <button data-act="cancel" class="danger-ghost">取消</button>
      </div>`;
    li.querySelector('[data-act="cancel"]').addEventListener('click', () => onCancel(item.id));
    li.querySelector('[data-act="retry"]')?.addEventListener('click', () => onRetry(item.id));
    els.queueList.appendChild(li);
  }
}

function renderHistory() {
  const filter = els.historyFilter.value;
  const items = snapshot.history.filter((it) => {
    if (filter === 'succeeded') return it.ok;
    if (filter === 'failed') return !it.ok;
    return true;
  });
  els.historyList.replaceChildren();
  els.historyEmpty.hidden = items.length > 0;
  for (const h of items.slice(0, 60)) {
    const li = document.createElement('li');
    li.className = 'h-item';
    const cls = h.dropped ? 'drop' : h.ok ? 'ok' : 'err';
    const statusText = h.dropped ? '截断' : h.ok ? `成功 ${h.status ?? ''}`.trim() : '失败';
    li.innerHTML = `
      <span class="h-time">${formatDateTime(h.completedAt)}</span>
      <span class="q-id">#${h.id}</span>
      <span class="h-method">${h.request.method}</span>
      <span class="h-url">${escapeHtml(h.request.url)}</span>
      <span class="h-status ${cls}">${statusText}</span>
      ${h.duplicateCount ? `<span class="badge dup">重复 ×${h.duplicateCount + 1}</span>` : ''}
      <span class="h-attempts">${escapeHtml(h.error || '')} · 尝试 ${h.attempts} 次</span>`;
    els.historyList.appendChild(li);
  }
}

// ---------- 操作 ----------
function readForm() {
  return {
    method: els.method.value,
    url: els.url.value,
    body: els.body.value,
  };
}

async function onEnqueue() {
  try {
    const result = await engine.enqueue(readForm());
    if (result.deduped) {
      toast(`与队列中 #${result.item.id} 内容相同，已自动去重合并`, 'warn');
    } else {
      toast(network.isOnline() ? `请求 #${result.item.id} 已发送` : `当前离线，请求 #${result.item.id} 已入队`, 'success');
    }
  } catch (err) {
    if (err instanceof QueueFullError) toast(err.message, 'error');
    else toast(`入队失败：${err.message}`, 'error');
  }
}

async function onCancel(id) {
  await engine.cancel(id);
  toast(`已取消 #${id}`, 'warn');
}
async function onRetry(id) {
  await engine.retryItem(id);
  toast(`已重置 #${id}，立即重试`, 'success');
}

function toast(message, kind = '') {
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = message;
  els.toastWrap.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transition = 'opacity .3s';
    setTimeout(() => div.remove(), 320);
  }, 3600);
}

// ---------- 事件绑定 ----------
els.btnEnqueue.addEventListener('click', onEnqueue);
els.btnStress.addEventListener('click', async () => {
  for (let i = 0; i < 12; i++) {
    // 前 5 条完全相同 -> 去重；之后 7 条各不相同 -> 超过上限 8 时触发截断。
    const n = i < 5 ? 0 : i;
    // eslint-disable-next-line no-await-in-loop
    const r = await engine.enqueue({
      method: 'POST',
      url: '/api/echo',
      body: JSON.stringify({ order: n }),
    }).catch((err) => { toast(err.message, 'error'); return null; });
    if (r?.deduped) toast('压测：检测到重复请求，已去重', 'warn');
  }
});
els.btnReplay.addEventListener('click', () => {
  if (!engine.replayNow()) toast('当前离线，无法立即重放，已保持排队', 'warn');
});
els.btnRetryFailed.addEventListener('click', async () => {
  const n = await engine.retryFailed();
  toast(n ? `已重置 ${n} 条失败请求` : '没有失败请求', n ? 'success' : '');
});
els.btnClear.addEventListener('click', async () => {
  const n = await engine.clearQueue();
  toast(`已清空 ${n} 条队列请求`, 'warn');
});
els.btnClearHistory.addEventListener('click', async () => {
  await store.clearHistory();
  await refresh();
});
els.historyFilter.addEventListener('change', renderHistory);
els.maxQueue.addEventListener('change', () => engine.setMaxQueue(els.maxQueue.value));
els.maxAttempts.addEventListener('change', () => engine.setMaxAttempts(els.maxAttempts.value));
els.failRate.addEventListener('change', () => sendSwConfig());

// 模拟离线：通过 Service Worker 拦截探针与 API，真实地造成 fetch 失败。
els.forceOffline.addEventListener('change', async () => {
  network.setForceOffline(els.forceOffline.checked);
  await sendSwConfig();
  if (!els.forceOffline.checked) {
    // SW 回执配置生效后再探测，避免探针先被旧的离线状态拦截。
    network.consecutiveFailures = 0;
    network.probe('force-restore');
  }
  renderConn();
});

function sendSwConfig() {
  return (async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg?.active) return false;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve(true);
      };
      reg.active.postMessage({
        type: 'config',
        forceOffline: els.forceOffline.checked,
        failRate: Number(els.failRate.value) || 0,
      }, [channel.port2]);
      setTimeout(() => resolve(false), 800);
    });
  })();
}

// ---------- 连接状态 ----------
function renderConn(reason) {
  const online = network.isOnline();
  els.conn.classList.toggle('online', online);
  els.conn.classList.toggle('offline', !online);
  els.connDot.style.background = '';
  els.connText.textContent = online ? '在线' : '离线';
  els.connExtra.textContent = online
    ? '联网后自动按序重放队列'
    : (reason ? `已暂停重放（${reason}）` : '请求将进入本地队列');
}
network.on('change', ({ online, reason }) => {
  renderConn(reason);
  if (online) toast('网络已恢复，开始自动重放', 'success');
  else toast(`检测到离线：${reason}`, 'warn');
});

// ---------- 引擎事件 ----------
engine.on('changed', refresh);
engine.on('item-dropped', ({ item, reason }) => {
  toast(`队列过长，最老请求 #${item.id} 被截断（${reason}）`, 'warn');
});
engine.on('replay-state', ({ state, itemId }) => {
  els.replayState.textContent = REPLAY_LABEL[state] || state;
  if (state === 'blocked') {
    els.replayState.textContent += `（#${itemId}，可取消或手动重试）`;
  }
});

// ---------- 页面卸载 / 隐藏：保存队列 ----------
// 队列在每次状态变化时都已实时写入 IndexedDB；这里负责中断在途请求并归位。
window.addEventListener('pagehide', () => {
  navigator.locks?.request ? engine.flushAndUnload() : engine.flushAndPause();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    engine.flushAndPause();
  } else if (navigator.locks) {
    engine.resume(); // 回到前台：重新拿锁并唤醒重放
  }
});
// bfcache 恢复（部分浏览器后退前进不重新执行脚本）。
window.addEventListener('pageshow', (event) => {
  if (event.persisted) engine.resume();
});

// ---------- Service Worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW 注册失败（需通过 http 访问，而非 file://）:', err);
  });
  navigator.serviceWorker.addEventListener('controllerchange', sendSwConfig);
}

// ---------- 启动 ----------
(async function bootstrap() {
  await engine.start();
  network.start();
  await sendSwConfig();
  await refresh();
  renderConn();
  // 每 1.5 秒重绘一次时序图（退避段 / 时钟前进）。
  setInterval(() => timeline.draw(), 1500);
})();

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
