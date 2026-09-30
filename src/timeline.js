// Canvas 队列时序图：
// - 红色背景带 = 离线窗口；
// - 每条请求一行：蓝（排队）→ 紫斜纹（退避）→ 橙段（发送尝试）→ 绿/红终态标记；
// - 悬停显示详情（id、方法、地址、次数、状态、耗时）。
import { STATUS, STATUS_LABEL, formatTime } from './utils.js';

const ROW_H = 22;
const ROW_GAP = 6;
const AXIS_H = 22;
const LABEL_W = 58;
const WINDOW_MS = 60_000;

const COLORS = {
  queued: 'rgba(79,140,255,.5)',
  attempt: '#f0a93b',
  waiting: '#9a7bff',
  success: '#2fbf71',
  fail: '#ef5b6b',
  offline: 'rgba(239,91,107,.14)',
  grid: 'rgba(139,151,173,.18)',
  text: '#8b97ad',
};

export class Timeline {
  constructor(canvas, tooltip, getSnapshot) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.getSnapshot = getSnapshot; // () => ({ queue: [], history: [], netLog: [] })
    this.hoverIndex = null;
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.draw(); });
    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseleave', () => {
      this.hoverIndex = null;
      this.tooltip.hidden = true;
      this.draw();
    });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 640;
    this.cssW = cssW;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(Number(this.canvas.getAttribute('height')) * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssH = Number(this.canvas.getAttribute('height'));
  }

  draw() {
    const { ctx, cssW } = this;
    const H = this.cssH;
    ctx.clearRect(0, 0, cssW, H);
    const snap = this.getSnapshot();
    const now = Date.now();
    const t0 = now - WINDOW_MS;

    const xAt = (ts) => LABEL_W + ((ts - t0) / WINDOW_MS) * (cssW - LABEL_W);
    const plotW = cssW - LABEL_W;

    // 离线窗口背景。
    for (let i = 0; i < snap.netLog.length; i++) {
      const ev = snap.netLog[i];
      if (ev.online) continue;
      const start = Math.max(ev.at, t0);
      const next = snap.netLog[i + 1];
      const end = next ? Math.min(next.at, now) : now;
      if (end < t0) continue;
      ctx.fillStyle = COLORS.offline;
      ctx.fillRect(xAt(start), 0, Math.max(2, xAt(end) - xAt(start)), H - AXIS_H);
    }

    // 网格 + 时间轴（每 10 秒）。
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.lineWidth = 1;
    for (let s = 0; s <= 60; s += 10) {
      const ts = t0 + s * 1000;
      const x = xAt(ts);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H - AXIS_H);
      ctx.stroke();
      ctx.fillText(`-${60 - s}s`, x + 3, H - 7);
    }

    // 合并队列 + 历史，按 id 升序，只画窗口内创建的请求。
    const rows = [...snap.queue, ...snap.history]
      .filter((it) => it.createdAt >= t0)
      .sort((a, b) => a.id - b.id);
    const visible = rows.slice(-Math.floor((H - AXIS_H) / (ROW_H + ROW_GAP)));

    visible.forEach((item, idx) => {
      const y = 6 + idx * (ROW_H + ROW_GAP);
      const hovered = this.hoverIndex === item.id;
      this._drawRow(item, y, xAt, t0, now, hovered);
    });

    if (!visible.length) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '12px sans-serif';
      ctx.fillText('近 60 秒暂无请求，发起请求后这里会展示排队 / 重放时序', LABEL_W + 8, 30);
    }
  }

  _drawRow(item, y, xAt, t0, now, hovered) {
    const { ctx } = this;
    const created = Math.max(item.createdAt, t0);
    const end = item.completedAt || now;
    const x1 = xAt(created);
    const x2 = Math.max(x1 + 2, xAt(Math.min(end, now)));

    // 行标签：#id + 方法。
    ctx.fillStyle = hovered ? '#e6ebf5' : COLORS.text;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText(`#${item.id} ${item.request.method}`, 4, y + ROW_H / 2 + 3);

    // 排队底条（创建到首个尝试之间；无尝试记录时画到当前/结束）。
    ctx.fillStyle = COLORS.queued;
    ctx.fillRect(x1, y, x2 - x1, ROW_H);

    // 尝试段 + 退避段（根据 attempts 时间戳近似重建）。
    const records = item.attemptRecords || [];
    records.forEach((rec, i) => {
      const next = records[i + 1];
      const segEnd = next ? next.at : (item.completedAt || Math.min(rec.at + 900, now));
      const sx = xAt(Math.max(rec.at, t0));
      const ex = xAt(Math.min(segEnd, now));
      ctx.fillStyle = COLORS.attempt;
      ctx.fillRect(sx, y, Math.max(3, ex - sx), ROW_H);
      // 失败后的退避等待：斜纹紫。
      if (!rec.ok && next) {
        const wx = ex;
        const wxx = xAt(Math.min(next.at, now));
        ctx.save();
        ctx.beginPath();
        ctx.rect(wx, y, Math.max(2, wxx - wx), ROW_H);
        ctx.clip();
        ctx.strokeStyle = 'rgba(154,123,255,.75)';
        ctx.lineWidth = 3;
        for (let xx = wx - ROW_H; xx < wxx + ROW_H; xx += 6) {
          ctx.beginPath();
          ctx.moveTo(xx, y + ROW_H);
          ctx.lineTo(xx + ROW_H, y);
          ctx.stroke();
        }
        ctx.restore();
      }
      // 单次尝试结果标记。
      ctx.fillStyle = rec.ok ? COLORS.success : COLORS.fail;
      ctx.fillRect(ex - 2, y - 2, 4, ROW_H + 4);
    });

    // 终态标记（队列项用 status，历史项用 state）。
    const finalState = item.status || item.state;
    if (item.completedAt) {
      const cx = xAt(Math.min(item.completedAt, now));
      ctx.fillStyle = finalState === STATUS.SUCCEEDED
        ? COLORS.success
        : finalState === STATUS.DROPPED ? '#f0a93b'
        : COLORS.fail;
      ctx.beginPath();
      ctx.arc(Math.min(cx, this.cssW - 8), y + ROW_H / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hovered) {
      ctx.strokeStyle = '#e6ebf5';
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 - 1, y - 1, x2 - x1 + 2, ROW_H + 2);
    }
  }

  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const snap = this.getSnapshot();
    const now = Date.now();
    const rows = [...snap.queue, ...snap.history]
      .filter((it) => it.createdAt >= now - WINDOW_MS)
      .sort((a, b) => a.id - b.id);
    const idx = Math.floor((y - 6) / (ROW_H + ROW_GAP));
    const H = this.cssH;
    const maxRows = Math.floor((H - AXIS_H) / (ROW_H + ROW_GAP));
    const visible = rows.slice(-maxRows);
    const item = visible[idx];
    this.hoverIndex = item?.id ?? null;
    this.draw();
    if (!item) {
      this.tooltip.hidden = true;
      return;
    }
    const state = STATUS_LABEL[item.status || item.state] || (item.status || item.state);
    const dur = item.completedAt ? `${((item.completedAt - item.createdAt) / 1000).toFixed(1)}s` : '进行中';
    this.tooltip.innerHTML = `
      <div class="tt-title">#${item.id} ${item.request.method} ${escapeHtml(item.request.url)}</div>
      <div class="tt-row">状态：${state}　尝试：${item.attempts} 次　耗时：${dur}</div>
      ${item.duplicateCount ? `<div class="tt-row">重复合并：${item.duplicateCount} 次</div>` : ''}
      ${item.lastError ? `<div class="tt-row" style="color:#ff9aa5">${escapeHtml(item.lastError)}</div>` : ''}
      <div class="tt-row">创建：${formatTime(item.createdAt)}</div>`;
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 300)}px`;
    this.tooltip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - 120)}px`;
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
