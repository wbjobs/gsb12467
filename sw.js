// Service Worker：
// 1) 应用外壳预缓存 + 缓存优先，保证页面本身离线可用；
// 2) /probe 心跳：真实网络优先，用于精确离线检测；
// 3) /api/echo mock 接口：可配置失败率，便于演示重放与重试；
// 4) “模拟离线”时直接让探针和 API 请求失败（不影响外壳加载）。
const VERSION = 'v1';
const SHELL_CACHE = `offline-queue-shell-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './src/app.js',
  './src/engine.js',
  './src/network.js',
  './src/timeline.js',
  './src/store-idb.js',
  './src/store-memory.js',
  './src/utils.js',
];

const state = { forceOffline: false, failRate: 0 };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'config') {
    state.forceOffline = Boolean(event.data.forceOffline);
    state.failRate = Number(event.data.failRate) || 0;
    // 通过 MessageChannel 回执，页面可在配置生效后再探测。
    event.ports?.[0]?.postMessage({ type: 'config-applied' });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 跨域请求一律放行

  if (url.pathname === '/probe') {
    event.respondWith(handleProbe(event.request));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApi(event.request));
    return;
  }
  // GET 静态资源：缓存优先，回退网络，再回退 index.html / Response。
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
            return res;
          })
          .catch(() => caches.match('./index.html'));
      }),
    );
  }
});

async function handleProbe() {
  if (state.forceOffline) {
    // 与真实断网一致：respondWith 抛错，页面 fetch 得到 TypeError。
    throw new TypeError('network offline (simulated)');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    await fetch('/__network_probe__?t=' + Date.now(), {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return new Response('ok', { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch {
    clearTimeout(timer);
    return new Response('offline', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

async function handleApi(request) {
  if (state.forceOffline) {
    // 模拟真实断网：respondWith 抛错，fetch reject TypeError。
    throw new TypeError('Failed to fetch (simulated offline)');
  }
  // 读取请求体（GET 无体）。
  let bodyText = '';
  try {
    bodyText = await request.clone().text();
  } catch { /* ignore */ }

  // 按配置随机注入失败，演示自动重试；重放请求带标记头时可在响应中观察。
  if (state.failRate > 0 && Math.random() * 100 < state.failRate) {
    return json({ ok: false, error: `模拟服务端故障（失败率 ${state.failRate}%）` }, 503);
  }

  await delay(200 + Math.random() * 500);
  return json({
    ok: true,
    echoedAt: new Date().toISOString(),
    method: request.method,
    replay: request.headers.get('X-Queue-Replay') || 'direct',
    receivedBody: safeParse(bodyText),
  }, 200);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function safeParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
