/* 入口：组装总线、网络监测、队列、时序图、UI，注册 Service Worker。 */

import { EventBus } from './bus.js';
import { NetworkMonitor } from './network.js';
import { QueueManager } from './queue.js';
import { Timeline } from './timeline.js';
import { AppUI } from './ui.js';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Worker 不可用，弱网模拟与离线外壳将失效');
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    // 等 SW 激活并接管当前页面，确保 mock 控制立即生效
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.error('Service Worker 注册失败（需通过 http(s) 访问而非 file://）：', err);
    return null;
  }
}

async function bootstrap() {
  await registerServiceWorker();

  const bus = new EventBus();
  const network = new NetworkMonitor(bus);
  const queue = new QueueManager(bus, network);
  await queue.start();
  network.start();

  const timeline = new Timeline(document.getElementById('timeline'), queue, network);
  const ui = new AppUI({ queue, network, timeline });
  ui.init();

  // 周期性刷新：重试倒计时、时序图发送中动画
  setInterval(() => {
    ui.renderStats();
    ui.renderQueue();
    timeline.draw();
  }, 500);

  // 调试入口，方便在控制台观察
  window.__queue = { bus, network, queue, timeline };
}

bootstrap().catch((err) => {
  console.error('应用启动失败:', err);
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = `应用启动失败：${err.message}（请确认通过本地服务器访问）`;
    toast.hidden = false;
    toast.style.borderColor = 'var(--danger)';
  }
});
