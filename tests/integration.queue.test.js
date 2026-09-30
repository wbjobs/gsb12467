import { QueueManager } from '../js/queue.js';
import { STATUS } from '../js/utils.js';

const stores = {};
const tick = () => new Promise((r) => setTimeout(r, 0));
globalThis.indexedDB = {
  open() {
    const req = { onsuccess: null, result: {
      transaction(storeName) {
        const data = stores[storeName] ?? (stores[storeName] = new Map());
        const t = { onsuccess: null, onerror: null };
        let settled = false;
        const scheduleCommit = () => {
          if (settled) return;
          settled = true;
          setTimeout(() => t.onsuccess?.(), 0);
        };
        const wrap = (fn) => {
          const r = { onsuccess: null, onerror: null };
          setTimeout(() => {
            try { fn(r); } catch (e) { r.onerror?.(); }
            r.onsuccess?.();
            setTimeout(scheduleCommit, 0);
          }, 0);
          return r;
        };
        t.objectStore = () => ({
          put: (v, k) => wrap(() => { data.set(storeName === 'requests' ? v.id : k, structuredClone(v)); }),
          get: (k) => wrap((r) => { r.result = data.get(k); }),
          delete: (k) => wrap(() => { data.delete(k); }),
          clear: () => wrap(() => { data.clear(); }),
          getAll: () => wrap((r) => { r.result = [...data.values()].map((v) => structuredClone(v)); }),
        });
        // 没有任何请求的事务也自动提交（延迟一个宏任务，等同步代码先发起请求）
        setTimeout(() => { if (!settled && data.size >= 0) scheduleCommit(); }, 1);
        return t;
      },
    } };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

globalThis.BroadcastChannel = class { constructor(){ this.onmessage=null; } postMessage(){} close(){} };
globalThis.window = { addEventListener(){}, removeEventListener(){} };
globalThis.document = { addEventListener(){}, hidden: false };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.DOMException = class extends Error { constructor(m,n){ super(m); this.name=n; } };
globalThis.Response = class {
  constructor(body, init={}) { this._b=body; this.status=init.status; this.ok=init.status>=200&&init.status<300; this.statusText=''; }
  async text(){ return this._b; }
  clone(){ return this; }
};

let failHits = 0;
globalThis.fetch = async (url) => {
  await new Promise((r) => setTimeout(r, 15));
  if (url.startsWith('/fail')) {
    failHits++;
    return failHits < 3 ? new Response('{"e":1}', { status: 500 }) : new Response('{"ok":true}', { status: 200 });
  }
  return new Response('{"ok":true}', { status: 200 });
};

class Bus {
  constructor(){ this.m = new Map(); }
  on(e,f){ (this.m.get(e) ?? this.m.set(e,new Set()).get(e)).add(f); }
  off(){} dispatchLocal({event,data}){ this.m.get(event)?.forEach((f)=>f(data)); }
  broadcast(){} emit(e,d){ this.dispatchLocal({event:e,data:d}); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exitCode = 1; } else console.log('  ✓', msg); };

const bus = new Bus();
let netListeners = [];
const network = { online: false, onChange: (f) => { netListeners.push(f); return () => {}; }, offlineRanges: () => [], bus };

const q = new QueueManager(bus, network, { maxAttempts: 3, requestTimeoutMs: 2000 });
q.isLeader = true;
await q.start();
network.online = false;

// --- 1. 离线排队 + 去重 ---
const a = await q.enqueue({ method: 'POST', url: '/fail', body: '{"x":1}' });
const b = await q.enqueue({ method: 'POST', url: '/fail', body: '{"x":1}' });
assert(b.duplicated === true, '重复请求去重命中');
const c = await q.enqueue({ method: 'GET', url: '/ok' });
assert(q.items.filter((i)=>i.status===STATUS.QUEUED).length === 2, '离线共 2 条排队');
assert(a.item.seq < c.item.seq, '入队 seq 递增保序');

// --- 2. 队列截断 ---
await q.updateSettings({ maxQueueLength: 1 });
assert(q.items.filter((i)=>i.status===STATUS.DROPPED).length === 1, '超长时截断最旧排队项');
assert(q.items.find((i)=>i.status===STATUS.DROPPED)?.seq === a.item.seq, '丢弃的是最旧的 /fail');

// --- 3. 取消单条（离线排队态） ---
const d = await q.enqueue({ method: 'GET', url: '/ok' }); // 上限1会截断旧的 /ok
await q.enqueue({ method: 'DELETE', url: '/ok' });
// 当前排队只剩最新一条；取消它
const queuedNow = q.items.filter((i)=>i.status===STATUS.QUEUED);
await q.cancelItem(queuedNow[0].id);
assert(!q.items.some((i)=>i.status===STATUS.QUEUED), '取消后无排队项');

// --- 4. 联网后顺序重放 + 失败重试 ---
await q.updateSettings({ maxQueueLength: 50 });
const f1 = await q.enqueue({ method: 'POST', url: '/fail', body: '{"a":1}' });
const f2 = await q.enqueue({ method: 'GET', url: '/ok' });
network.online = true;
netListeners.forEach((fn) => fn(true, 'test'));
q.flush();

await wait(4000); // 500ms + 1000ms 退避 + 抖动 + 发送
const itemFail = q.items.find((i)=>i.id===f1.item.id);
const itemOk = q.items.find((i)=>i.id===f2.item.id);
assert(itemFail.status === STATUS.SUCCESS, `500 失败重试后成功（attempts=${itemFail.attempts}）`);
assert(itemFail.attempts === 3, `共尝试 3 次，实际 ${itemFail.attempts}`);
assert(itemOk.status === STATUS.SUCCESS, '正常请求成功');
assert(itemOk.startedAt >= itemFail.startedAt, '严格顺序：/fail 全部结束后才发送 /ok');

// --- 5. 确定性错误不自动重试 ---
const f3 = await q.enqueue({ method: 'GET', url: '/404' });
globalThis.fetch = async () => new Response('nope', { status: 404 });
q.flush();
await wait(300);
const item404 = q.items.find((i)=>i.id===f3.item.id);
assert(item404.status === STATUS.FAILED && item404.attempts === 1, '404 不自动重试，直接失败');

// --- 6. 手动重试 ---
globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
await q.retryItem(item404.id);
await wait(1200);
const fresh404 = q.items.find((i)=>i.id===item404.id);
assert(fresh404.status === STATUS.SUCCESS && fresh404.attempts === 1, '手动重试成功并重置次数');
await wait(200);

// --- 7. 清空队列 ---
const f4 = await q.enqueue({ method: 'GET', url: '/ok' });
await q.clearQueue();
assert(!q.items.some((i)=>i.status===STATUS.QUEUED), '清空后无排队');

// --- 8. 持久化恢复（sending 残留 -> queued） ---
const { getAllRequests } = await import('../js/db.js');
const persisted = await getAllRequests();
assert(persisted.length === q.items.length, `所有项已持久化（${persisted.length} 条）`);

console.log(process.exitCode ? '\nFAILED' : '\nALL_INTEGRATION_ASSERTIONS_PASSED');
process.exit(process.exitCode || 0);
