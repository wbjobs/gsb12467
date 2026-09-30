// 零依赖单元测试：node test/engine.test.js
import assert from 'node:assert/strict';
import { OfflineQueueEngine, QueueFullError } from '../src/engine.js';
import { MemoryStore } from '../src/store-memory.js';
import { STATUS } from '../src/utils.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 4).join('\n    ')}`);
    process.exitCode = 1;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
// 连续驱动微任务，确保 async/await 链全部落定。
async function flush(n = 40) {
  for (let i = 0; i < n; i++) await tick();
}

const clock = { now: 1_000_000 };
const realNow = Date.now;
const installClock = () => { Date.now = () => clock.now; };
const restoreClock = () => { Date.now = realNow; };

function makeScheduler() {
  const timers = new Map();
  let seq = 1;
  return {
    setTimeout(fn, ms) {
      const id = seq++;
      timers.set(id, { fn, due: clock.now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      clock.now += ms;
      for (let guard = 0; guard < 2000; guard++) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.due <= clock.now)
          .sort((a, b) => a[1].due - b[1].due);
        if (!due.length) break;
        for (const [id, t] of due) {
          if (!timers.has(id)) continue;
          timers.delete(id);
          t.fn();
          await tick();
        }
      }
      await flush(10);
    },
    hasTimer() { return timers.size > 0; },
  };
}

class FakeNetwork {
  constructor(online = true) { this._online = online; this.listeners = []; }
  isOnline() { return this._online; }
  set(v) { this._online = v; this.listeners.forEach((fn) => fn({ online: v })); }
  onChange(fn) { this.listeners.push(fn); }
}

// 可切换行为、且尊重 AbortSignal 的假 fetch。
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ url, init, at: clock.now });
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      Promise.resolve()
        .then(() => handler({ url, init, calls }))
        .then(resolve, reject);
    });
  fetchImpl.calls = calls;
  return fetchImpl;
}
const okResponse = (status = 200) => ({ ok: status >= 200 && status < 300, status });
const errResponse = (status) => ({ ok: false, status });

async function makeEngine(overrides = {}) {
  const store = new MemoryStore();
  const network = new FakeNetwork(overrides.online ?? true);
  const scheduler = makeScheduler();
  const fetchImpl = overrides.fetchImpl || makeFetch(async () => okResponse());
  const engine = new OfflineQueueEngine({
    store, network, scheduler, fetchImpl,
    opts: {
      maxQueue: 3, maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000,
      attemptTimeoutMs: 8000, ...(overrides.opts || {}),
    },
  });
  await engine.start();
  await flush(5);
  return { engine, store, network, scheduler, fetchImpl };
}

// ---------- 用例 ----------

await test('在线时入队立即按 id 顺序重放成功，并写入历史', async () => {
  installClock();
  const { engine, store, fetchImpl } = await makeEngine();
  await engine.enqueue({ method: 'POST', url: '/a', body: '{"x":1}' });
  await engine.enqueue({ method: 'POST', url: '/b', body: '{"x":2}' });
  await flush();
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), ['/a', '/b'], '严格按顺序');
  assert.equal((await store.getAllQueue()).length, 0, '成功后移出队列');
  const hist = await store.getAllHistory();
  assert.equal(hist.length, 2);
  assert.ok(hist.every((h) => h.ok));
  restoreClock();
});

await test('相同方法/地址/内容（含 JSON 字段乱序）自动去重，只发一次', async () => {
  installClock();
  const { engine, fetchImpl } = await makeEngine();
  await engine.enqueue({ method: 'POST', url: '/d', body: '{"a":1,"b":2}' });
  await engine.enqueue({ method: 'POST', url: '/d', body: '{"b":2,"a":1}' });
  await engine.enqueue({ method: 'POST', url: '/d', body: '{"a":1,"b":2}' });
  await flush();
  assert.equal(fetchImpl.calls.length, 1);
  restoreClock();
});

await test('离线排队：离线不发送，联网后自动按 id 顺序补偿', async () => {
  installClock();
  const { engine, network, fetchImpl } = await makeEngine({ online: false });
  await engine.enqueue({ method: 'POST', url: '/o1' });
  await engine.enqueue({ method: 'POST', url: '/o2' });
  await flush();
  assert.equal(fetchImpl.calls.length, 0);
  network.set(true);
  await flush();
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), ['/o1', '/o2']);
  restoreClock();
});

await test('可重试失败：指数退避后自动重试，最终成功', async () => {
  installClock();
  let n = 0;
  const fetchImpl = makeFetch(async () => (++n < 3 ? errResponse(503) : okResponse()));
  const { engine, scheduler } = await makeEngine({ fetchImpl });
  await engine.enqueue({ method: 'POST', url: '/flaky' });
  await flush();
  assert.equal(fetchImpl.calls.length, 1);
  await scheduler.advance(350);
  assert.equal(fetchImpl.calls.length, 2);
  await scheduler.advance(700);
  assert.equal(fetchImpl.calls.length, 3, '第三次成功');
  restoreClock();
});

await test('达到尝试上限队首阻塞；手动重试后按序恢复全部成功', async () => {
  installClock();
  let mode = 'fail';
  const fetchImpl = makeFetch(async () => (mode === 'ok' ? okResponse() : errResponse(503)));
  const { engine, store, scheduler } = await makeEngine({
    fetchImpl, opts: { maxAttempts: 2, baseDelayMs: 100 },
  });
  await engine.enqueue({ method: 'POST', url: '/bad' });
  await engine.enqueue({ method: 'POST', url: '/good2' });
  await flush();
  await scheduler.advance(400); // 两次尝试用尽
  let q = await store.getAllQueue();
  assert.equal(q[0].status, STATUS.BLOCKED, '队首阻塞');
  assert.equal(q[1].status, STATUS.QUEUED, '后续请求不被提前发送');
  assert.equal(fetchImpl.calls.length, 2);

  mode = 'ok';
  await engine.retryItem(q[0].id);
  await flush();
  q = await store.getAllQueue();
  assert.equal(q.length, 0, '阻塞解除后两条都成功');
  restoreClock();
});

await test('队列超长：截断最老且未开始的排队请求，并在历史留痕', async () => {
  installClock();
  const dropped = [];
  const { engine, store } = await makeEngine({ online: false });
  engine.on('item-dropped', (p) => dropped.push(p.item.id));
  await engine.enqueue({ method: 'POST', url: '/1' });
  await engine.enqueue({ method: 'POST', url: '/2' });
  await engine.enqueue({ method: 'POST', url: '/3' });
  await engine.enqueue({ method: 'POST', url: '/4' });
  await flush();
  assert.deepEqual((await store.getAllQueue()).map((i) => i.request.url), ['/2', '/3', '/4']);
  assert.deepEqual(dropped, [1]);
  assert.ok((await store.getAllHistory()).some((h) => h.id === 1 && h.dropped));
  restoreClock();
});

await test('队列上限为 1 且队首处理中时，新请求被拒绝而不丢在途请求', async () => {
  installClock();
  const fetchImpl = makeFetch(async () => errResponse(503));
  const { engine } = await makeEngine({ fetchImpl, opts: { maxQueue: 1, baseDelayMs: 100000 } });
  await engine.enqueue({ method: 'POST', url: '/only' });
  await flush(); // 第一次失败后进入长退避（非 queued）
  await assert.rejects(
    () => engine.enqueue({ method: 'POST', url: '/second' }),
    QueueFullError,
  );
  restoreClock();
});

await test('发送中断网：在途请求中止且不消耗次数，恢复后自动补偿', async () => {
  installClock();
  let call = 0;
  const fetchImpl = makeFetch(async ({ init }) => {
    call += 1;
    if (call === 1) return new Promise(() => {}); // 在途挂起，等 abort
    return okResponse();
  });
  const { engine, network, store } = await makeEngine({ fetchImpl });
  engine.enqueue({ method: 'POST', url: '/hung' });
  await flush();
  let item = (await store.getAllQueue())[0];
  assert.equal(item.status, STATUS.RUNNING);
  network.set(false);
  await flush();
  item = await store.getQueue(1);
  assert.equal(item.status, STATUS.QUEUED);
  assert.equal(item.attempts, 0, '离线中断不消耗重试');
  network.set(true);
  await flush();
  assert.equal(call, 2);
  assert.equal((await store.getAllQueue()).length, 0, '恢复后发送成功');
  restoreClock();
});

await test('取消单条：在途请求被中止并写入历史', async () => {
  installClock();
  const fetchImpl = makeFetch(async () => new Promise(() => {}));
  const { engine, store } = await makeEngine({ fetchImpl });
  engine.enqueue({ method: 'POST', url: '/cancel-me' });
  await flush();
  await engine.cancel(1);
  await flush();
  assert.equal((await store.getAllQueue()).length, 0);
  assert.equal((await store.getAllHistory())[0].error, '用户取消');
  restoreClock();
});

await test('清空队列：未完成请求全部进入历史', async () => {
  installClock();
  const { engine, store } = await makeEngine({ online: false });
  await engine.enqueue({ method: 'POST', url: '/c1' });
  await engine.enqueue({ method: 'POST', url: '/c2' });
  await flush();
  const n = await engine.clearQueue();
  assert.equal(n, 2);
  assert.equal((await store.getAllQueue()).length, 0);
  assert.equal((await store.getAllHistory()).length, 2);
  restoreClock();
});

await test('手动立即重放可打断退避睡眠', async () => {
  installClock();
  let n = 0;
  const fetchImpl = makeFetch(async () => (++n < 3 ? errResponse(503) : okResponse()));
  const { engine, scheduler } = await makeEngine({ fetchImpl, opts: { baseDelayMs: 100000 } });
  await engine.enqueue({ method: 'POST', url: '/skip' });
  await flush();
  assert.equal(n, 1);
  assert.ok(scheduler.hasTimer(), '处于退避睡眠');
  assert.equal(engine.replayNow(), true);
  await flush();
  assert.equal(n, 2, '跳过等待立即第 2 次');
  restoreClock();
});

await test('页面卸载后队列落盘，重启引擎时自动归位并重放', async () => {
  installClock();
  const fetchImpl = makeFetch(async () => new Promise(() => {}));
  const { engine, store } = await makeEngine({ fetchImpl });
  engine.enqueue({ method: 'POST', url: '/persist' });
  await flush();
  await engine.flushAndPause();

  const network2 = new FakeNetwork(true);
  const scheduler2 = makeScheduler();
  const fetch2 = makeFetch(async () => okResponse());
  const engine2 = new OfflineQueueEngine({
    store, network: network2, scheduler: scheduler2, fetchImpl: fetch2,
    opts: { maxQueue: 3, maxAttempts: 4, baseDelayMs: 100 },
  });
  await engine2.start();
  await flush();
  assert.equal(fetch2.calls.length, 1);
  assert.equal((await store.getAllQueue()).length, 0);
  restoreClock();
});

console.log(`\n${passed} 个用例通过${process.exitCode ? '，存在失败' : ''}`);
