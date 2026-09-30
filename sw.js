/*
 * Service Worker：
 *  1. 充当本地 mock 服务器，拦截 /api/** 请求，无需真实后端；
 *  2. 支持「强制离线 / 失败率 / 延迟」弱网模拟；
 *  3. 应用外壳走 network-first，离线时回退缓存，保证页面在离线时也能打开。
 */

const SHELL_CACHE = 'offline-queue-shell-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/db.js',
  './js/utils.js',
  './js/bus.js',
  './js/network.js',
  './js/queue.js',
  './js/timeline.js',
  './js/ui.js',
];

// mock 控制状态（仅保存在 SW 内存中，由页面通过 postMessage 下发）
const mock = {
  forceOffline: false,
  failRate: 0,
  latency: 150,
};

// 内存型任务存储，演示 /api/tasks
const tasks = new Map();
let taskSeq = 1;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'mock-config') {
    if (typeof data.forceOffline === 'boolean') mock.forceOffline = data.forceOffline;
    if (typeof data.failRate === 'number') mock.failRate = data.failRate;
    if (typeof data.latency === 'number') mock.latency = data.latency;
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApi(event.request, url));
    return;
  }

  // 应用外壳：network-first，离线回退缓存
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (event.request.method === 'GET' && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((res) => res || caches.match('./index.html')))
  );
});

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleApi(request, url) {
  // /api/ping 只受「强制离线」影响，不吃随机失败率，保证心跳语义稳定
  if (mock.forceOffline) {
    return json(503, { error: 'offline (forced by mock switch)' });
  }

  await delay(mock.latency);

  // 心跳
  if (url.pathname === '/api/ping') {
    return json(200, { ok: true, ts: Date.now() });
  }

  const rollFail = () => mock.failRate > 0 && Math.random() * 100 < mock.failRate;

  try {
    if (url.pathname === '/api/echo') {
      if (rollFail()) return json(500, { error: 'random 500 from mock' });
      let payload = null;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        payload = await request.clone().json().catch(() => null);
      }
      return json(200, { ok: true, method: request.method, path: url.pathname, payload, ts: Date.now() });
    }

    if (url.pathname === '/api/tasks') {
      if (rollFail()) return json(500, { error: 'random 500 from mock' });
      if (request.method === 'GET') {
        return json(200, { ok: true, tasks: [...tasks.values()] });
      }
      if (request.method === 'POST') {
        const body = await request.clone().json().catch(() => ({}));
        const task = { id: taskSeq++, title: body.title || `task ${taskSeq}`, done: false, createdAt: Date.now() };
        tasks.set(task.id, task);
        return json(201, { ok: true, task });
      }
      if (request.method === 'DELETE') {
        const id = Number(url.searchParams.get('id'));
        tasks.delete(id);
        return json(200, { ok: true });
      }
      return json(405, { error: 'method not allowed by mock' });
    }

    if (url.pathname === '/api/error') {
      return json(500, { error: 'deterministic server error' });
    }

    if (url.pathname === '/api/notfound') {
      return json(404, { error: 'deterministic not found' });
    }

    if (url.pathname === '/api/flaky') {
      return rollFail()
        ? json(503, { error: 'flaky failure' })
        : json(200, { ok: true, ts: Date.now() });
    }

    return json(404, { error: `unknown mock route: ${url.pathname}` });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
}
