/* 纯工具函数：去重键、退避、重试判定、队列截断等，便于单测。 */

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DROPPED: 'dropped',
});

/** 生成去重指纹：相同方法/路径/请求头白名单/请求体视为同一请求。 */
export async function buildDedupKey({ method, url, body, headers }) {
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'content-type' || lower === 'x-request-id') {
      normalizedHeaders[lower] = value;
    }
  }
  const raw = JSON.stringify({
    method: method.toUpperCase(),
    url,
    headers: normalizedHeaders,
    body: body ?? null,
  });

  if (globalThis.crypto && crypto.subtle && crypto.subtle.digest) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `fnv-${fnv1a(raw)}`;
}

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** 在去重窗口内命中则返回已有项，否则 null。窗口 0 表示关闭。 */
export function findDuplicate(items, key, windowMs, now = Date.now()) {
  if (!key || windowMs <= 0) return null;
  return items.find((item) =>
    item.dedupKey === key &&
    (item.status === STATUS.QUEUED ||
      item.status === STATUS.SENDING ||
      item.status === STATUS.FAILED ||
      item.status === STATUS.SUCCESS) &&
    now - item.createdAt < windowMs
  ) || null;
}

/** 指数退避 + 抖动：500ms, 1s, 2s … 上限 8s。 */
export function backoffDelay(attempt, baseMs = 500, maxMs = 8000) {
  const expo = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.random() * (baseMs / 2);
  return Math.round(expo + jitter);
}

/** 408/429 与 5xx 可重试；其余 4xx 视为确定性错误，不自动重试。 */
export function isRetryableStatus(status) {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * 队列截断：按 seq 最旧优先丢弃，且只丢弃排队中的项，
 * 已成功/失败/发送中的项不受 maxLength 影响（历史保留）。
 * 返回 { kept, evicted }。
 */
export function truncateQueued(items, maxLength) {
  const queued = items.filter((i) => i.status === STATUS.QUEUED).sort((a, b) => a.seq - b.seq);
  const overflow = queued.length - maxLength;
  if (overflow <= 0) return { kept: items.slice(), evicted: [] };

  const evictIds = new Set(queued.slice(0, overflow).map((i) => i.id));
  const now = Date.now();
  const evicted = [];
  const kept = items.map((item) => {
    if (evictIds.has(item.id)) {
      const marked = {
        ...item,
        status: STATUS.DROPPED,
        finishedAt: now,
        error: '队列超过上限，自动截断丢弃',
      };
      evicted.push(marked);
      return marked;
    }
    return item;
  });
  return { kept, evicted };
}

export function formatTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function relativeCountdown(targetTs, now = Date.now()) {
  const diff = Math.max(0, targetTs - now);
  return Math.ceil(diff / 1000);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function readBody(body) {
  if (body == null || body === '') return null;
  if (typeof body === 'string') {
    try {
      JSON.parse(body);
      return body;
    } catch {
      return body;
    }
  }
  return JSON.stringify(body);
}
