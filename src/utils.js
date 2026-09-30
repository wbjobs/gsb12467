// 通用工具：请求归一化、指纹去重、退避算法等纯函数。

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting', // 失败后退避中
  BLOCKED: 'blocked', // 达到尝试上限，等待人工处理
  SUCCEEDED: 'succeeded',
  FAILED: 'failed', // 终态：被取消或无法投递
  DROPPED: 'dropped', // 队列截断时被丢弃
});

export const STATUS_LABEL = Object.freeze({
  queued: '排队',
  running: '发送中',
  waiting: '退避等待',
  blocked: '已失败·待处理',
  succeeded: '成功',
  failed: '失败',
  dropped: '已截断',
});

// 只有这些响应码值得重试（瞬时错误），其它 4xx 视为永久错误。
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function isRetriableStatus(code) {
  return RETRIABLE_STATUS.has(Number(code));
}

// 稳定序列化 body：JSON 字符串按 key 排序，便于按内容去重。
function canonicalBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') return JSON.stringify(body ?? '');
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    return JSON.stringify(stableStringify(JSON.parse(trimmed)));
  } catch {
    return trimmed;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return value.map(stableStringify);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableStringify(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function normalizeRequest(input) {
  const method = (input.method || 'GET').toUpperCase();
  const url = String(input.url || '').trim();
  const headers = { ...(input.headers || {}) };
  const body = method === 'GET' || method === 'HEAD' ? undefined : canonicalBody(input.body);
  return { method, url, headers, body };
}

// 去重指纹：相同方法 + 地址 + 内容（含自定义头）视为重复请求。
export function fingerprint(req) {
  const normalized = normalizeRequest(req);
  const headerPart = Object.keys(normalized.headers)
    .sort()
    .map((k) => `${k.toLowerCase()}:${normalized.headers[k]}`)
    .join('\n');
  return [normalized.method, normalized.url, normalized.body ?? '', headerPart].join('\n');
}

// 指数退避 + ±20% 抖动，封顶 maxDelay。attempt 从 1 开始。
export function backoffDelay(attempt, base = 1000, max = 15000) {
  const expo = base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(expo, max);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(capped + jitter));
}

export function nowTs() {
  return Date.now();
}

export function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(ts)}`;
}

export class TypedEventEmitter {
  constructor() {
    this._listeners = new Map();
  }
  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  emit(type, payload) {
    this._listeners.get(type)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        // 监听者异常不影响引擎主流程。
        console.error(`[event:${type}] listener error:`, err);
      }
    });
  }
}
