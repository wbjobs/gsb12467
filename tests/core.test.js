import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDedupKey,
  findDuplicate,
  backoffDelay,
  isRetryableStatus,
  truncateQueued,
  readBody,
  STATUS,
} from '../js/utils.js';

test('buildDedupKey: 相同请求指纹一致，方法/路径/内容不同则不同', async () => {
  const base = { method: 'post', url: '/api/tasks', body: '{"a":1}', headers: {} };
  const k1 = await buildDedupKey(base);
  const k2 = await buildDedupKey({ ...base, method: 'POST' });
  assert.equal(k1, k2, '方法大小写不应影响指纹');

  const k3 = await buildDedupKey({ ...base, body: '{"a":2}' });
  assert.notEqual(k1, k3, 'body 不同应区分');

  const k4 = await buildDedupKey({ ...base, url: '/api/other' });
  assert.notEqual(k1, k4, 'url 不同应区分');

  const k5 = await buildDedupKey({ ...base, method: 'PUT' });
  assert.notEqual(k1, k5, 'method 不同应区分');
});

test('findDuplicate: 窗口内命中、窗口外不命中、关闭窗口不命中', () => {
  const now = 1_000_000;
  const items = [
    { dedupKey: 'k1', status: STATUS.QUEUED, createdAt: now - 5_000 },
    { dedupKey: 'k2', status: STATUS.SUCCESS, createdAt: now - 120_000 },
    { dedupKey: 'k3', status: STATUS.CANCELLED, createdAt: now - 1_000 },
  ];
  assert.equal(findDuplicate(items, 'k1', 60_000, now), items[0]);
  assert.equal(findDuplicate(items, 'k2', 60_000, now), null, '窗口外不算重复');
  assert.equal(findDuplicate(items, 'k3', 60_000, now), null, '终态取消项不参与去重');
  assert.equal(findDuplicate(items, 'k1', 0, now), null, '窗口 0 = 关闭去重');
  assert.equal(findDuplicate(items, 'missing', 60_000, now), null);
});

test('backoffDelay: 指数递增、有上限、非负且含抖动', () => {
  const d1 = backoffDelay(1, 500, 8000);
  assert.ok(d1 >= 500 && d1 <= 750);
  const d3 = backoffDelay(3, 500, 8000);
  assert.ok(d3 >= 2000 && d3 <= 2250);
  const d10 = backoffDelay(10, 500, 8000);
  assert.ok(d10 >= 8000 && d10 <= 8250, '不超过上限加最后一次抖动范围');
});

test('isRetryableStatus: 408/429/5xx 可重试，其余 4xx 不重试', () => {
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(201), false);
});

test('truncateQueued: 只丢弃最旧排队项，发送中/失败/成功不受影响', () => {
  const mk = (seq, status) => ({ id: `i${seq}`, seq, status });
  const items = [
    mk(1, STATUS.SUCCESS),
    mk(2, STATUS.QUEUED),
    mk(3, STATUS.SENDING),
    mk(4, STATUS.QUEUED),
    mk(5, STATUS.QUEUED),
    mk(6, STATUS.FAILED),
  ];
  const { kept, evicted } = truncateQueued(items, 2);
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].id, 'i2', '应丢弃 seq 最小的排队项');
  assert.equal(evicted[0].status, STATUS.DROPPED);
  assert.ok(evicted[0].finishedAt > 0);
  const i2 = kept.find((i) => i.id === 'i2');
  assert.equal(i2.status, STATUS.DROPPED, 'kept 中的同一项也被标记');
  assert.equal(kept.find((i) => i.id === 'i1').status, STATUS.SUCCESS);
  assert.equal(kept.find((i) => i.id === 'i3').status, STATUS.SENDING);
  assert.equal(kept.find((i) => i.id === 'i6').status, STATUS.FAILED);
});

test('truncateQueued: 未超长时不丢弃', () => {
  const items = [{ id: 'a', seq: 1, status: STATUS.QUEUED }];
  const { evicted } = truncateQueued(items, 5);
  assert.deepEqual(evicted, []);
});

test('readBody: 合法 JSON 字符串保留，空值为 null', async () => {
  assert.equal(await readBody('{"a":1}'), '{"a":1}');
  assert.equal(await readBody(''), null);
  assert.equal(await readBody(null), null);
  assert.equal(typeof await readBody({ a: 1 }), 'string');
});
