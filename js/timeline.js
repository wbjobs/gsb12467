/* Canvas 队列时序图：按 seq 分泳道绘制排队等待/发送中/结果，并叠加离线时段。 */

import { STATUS } from './utils.js';

const COLORS = {
  queued: '#7d8aa1',
  sending: '#4f8cff',
  success: '#34c77b',
  failed: '#f25767',
  cancelled: '#f0a93f',
  dropped: '#8a6d3b',
  offlineBand: 'rgba(242, 87, 103, 0.12)',
  offlineGrid: 'rgba(242, 87, 103, 0.35)',
  text: '#8b98ad',
  textStrong: '#e6ecf5',
  laneAlt: 'rgba(255,255,255,0.025)',
  grid: 'rgba(139,152,173,0.18)',
};

export class Timeline {
  static ensureRoundRect(ctx) {
    if (typeof ctx.roundRect === 'function') return;
    ctx.roundRect = (x, y, w, h, r) => {
      const radius = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + w, y, x + w, y + h, radius);
      ctx.arcTo(x + w, y + h, x, y + h, radius);
      ctx.arcTo(x, y + h, x, y, radius);
      ctx.arcTo(x, y, x + w, y, radius);
      ctx.closePath();
    };
  }

  constructor(canvas, queueManager, network) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.queue = queueManager;
    this.network = network;
    this.hoverIndex = null;
    this.lanes = [];

    this.canvas.addEventListener('mousemove', (e) => this.handleMove(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverIndex = null;
      this.draw();
    });
  }

  handleMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * (this.canvas.height / rect.height);
    const hit = this.lanes.find((lane) =>
      y >= lane.y && y <= lane.y + lane.h && x >= this.marginLeft && x <= this.width
    );
    const idx = hit ? hit.seq : null;
    if (idx !== this.hoverIndex) {
      this.hoverIndex = idx;
      this.draw();
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth || 900;
    const cssHeight = 360;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = cssWidth;
    this.height = cssHeight;
  }

  draw(now = Date.now()) {
    this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#1f2839';
    ctx.fillRect(0, 0, this.width, this.height);

    this.marginLeft = 92;
    this.marginRight = 14;
    this.marginTop = 26;
    this.legendHeight = 18;

    const items = this.queue.items
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .slice(-25);

    if (!items.length) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('发起请求后这里会按时序展示每条请求的排队、重放与结果', this.width / 2, this.height / 2);
      this.lanes = [];
      return;
    }

    const starts = items.map((i) => i.createdAt).filter(Boolean);
    let tMin = Math.min(...starts);
    let tMax = now;
    for (const range of this.network.offlineRanges(now)) {
      tMin = Math.min(tMin, range.start);
      tMax = Math.max(tMax, range.end);
    }
    tMax = Math.max(tMax, tMin + 4000);
    const pad = (tMax - tMin) * 0.03;
    tMin -= pad;
    tMax += pad;

    const plotLeft = this.marginLeft;
    const plotRight = this.width - this.marginRight;
    const plotTop = this.marginTop;
    const plotBottom = this.height - 22;
    const xOf = (t) => plotLeft + ((t - tMin) / (tMax - tMin)) * (plotRight - plotLeft);

    // 离线背景带
    for (const range of this.network.offlineRanges(now)) {
      const x1 = xOf(Math.max(range.start, tMin));
      const x2 = xOf(Math.min(range.end, tMax));
      if (x2 <= plotLeft || x1 >= plotRight) continue;
      ctx.fillStyle = COLORS.offlineBand;
      ctx.fillRect(x1, plotTop - 6, x2 - x1, plotBottom - plotTop + 6);
      ctx.strokeStyle = COLORS.offlineGrid;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, plotTop - 6);
      ctx.lineTo(x1, plotBottom);
      ctx.moveTo(x2, plotTop - 6);
      ctx.lineTo(x2, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 时间轴刻度
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const tickCount = 6;
    for (let i = 0; i <= tickCount; i += 1) {
      const t = tMin + ((tMax - tMin) / tickCount) * i;
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 4);
      ctx.stroke();
      const d = new Date(t);
      const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      ctx.fillText(label, x, plotBottom + 16);
    }

    // 泳道
    const laneH = Math.min(26, Math.max(16, (plotBottom - plotTop) / items.length - 3));
    const gap = 3;
    this.lanes = [];

    items.forEach((item, index) => {
      const y = plotTop + index * (laneH + gap);
      this.lanes.push({ seq: item.seq, y, h: laneH });

      if (index % 2 === 0) {
        ctx.fillStyle = COLORS.laneAlt;
        ctx.fillRect(plotLeft, y - 1, plotRight - plotLeft, laneH + 2);
      }

      // 泳道标签：#seq + 方法
      ctx.fillStyle = this.hoverIndex === item.seq ? COLORS.textStrong : COLORS.text;
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`#${item.seq} ${item.method}`, plotLeft - 8, y + laneH / 2 + 3.5);

      const xStart = xOf(item.createdAt);
      const sendStart = item.startedAt ? xOf(item.startedAt) : null;

      // 排队段（创建 -> 开始发送 或 当前）
      const queuedEnd = item.startedAt || (item.status === STATUS.QUEUED ? now : item.finishedAt || now);
      ctx.fillStyle = COLORS.queued;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(xStart, y + laneH / 2 - 3, Math.max(2, xOf(queuedEnd) - xStart), 6);
      ctx.globalAlpha = 1;

      if (sendStart != null) {
        const endTs = item.finishedAt || (item.status === STATUS.SENDING ? now : item.startedAt);
        const sending = item.status === STATUS.SENDING;
        ctx.fillStyle = sending ? COLORS.sending : COLORS.queued;
        ctx.fillRect(sendStart - 1, y + laneH / 2 - 5, Math.max(3, xOf(endTs) - sendStart), 10);

        // 结果标记
        if (item.finishedAt && item.status !== STATUS.SENDING) {
          const color = COLORS[item.status] || COLORS.text;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(xOf(item.finishedAt), y + laneH / 2, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#1f2839';
          ctx.font = 'bold 8px sans-serif';
          ctx.textAlign = 'center';
          const mark = item.status === STATUS.SUCCESS ? '✓'
            : item.status === STATUS.FAILED ? '✕' : '–';
          ctx.fillText(mark, xOf(item.finishedAt), y + laneH / 2 + 2.8);
        } else if (item.status === STATUS.SENDING) {
          ctx.fillStyle = COLORS.sending;
          ctx.beginPath();
          ctx.arc(xOf(now), y + laneH / 2, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (item.status === STATUS.QUEUED) {
        ctx.fillStyle = COLORS.queued;
        ctx.beginPath();
        ctx.arc(xOf(now), y + laneH / 2, 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (item.status === STATUS.FAILED && !item.startedAt) {
        // 理论上不会出现，防御性绘制
        ctx.fillStyle = COLORS.failed;
        ctx.beginPath();
        ctx.arc(xStart, y + laneH / 2, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // 重试次数竖线
      if (item.attempts > 1 && sendStart != null) {
        ctx.strokeStyle = 'rgba(240,169,63,0.7)';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(sendStart - 5, y);
        ctx.lineTo(sendStart - 5, y + laneH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (this.hoverIndex === item.seq) {
        this.drawTooltip(item, xStart, y);
      }
    });

    this.drawLegend(plotLeft, 8);
  }

  drawLegend(x, y) {
    const ctx = this.ctx;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    const entries = [
      [COLORS.queued, '排队等待'],
      [COLORS.sending, '发送中'],
      [COLORS.success, '成功'],
      [COLORS.failed, '失败/重试'],
      [COLORS.cancelled, '取消/截断'],
      [COLORS.offlineGrid, '离线时段'],
    ];
    let cursor = x;
    for (const [color, label] of entries) {
      ctx.fillStyle = color;
      ctx.fillRect(cursor, y, 10, 10);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(label, cursor + 14, y + 9);
      cursor += 14 + ctx.measureText(label).width + 16;
    }
  }

  drawTooltip(item, x, y) {
    const ctx = this.ctx;
    Timeline.ensureRoundRect(ctx);
    const lines = [
      `#${item.seq} ${item.method} ${item.url}`,
      `状态: ${item.status}  重试: ${item.attempts}  去重命中: ${item.dupCount}`,
    ];
    if (item.error) lines.push(`错误: ${item.error}`);
    if (item.responseStatus) lines.push(`响应: HTTP ${item.responseStatus}`);

    ctx.font = '11px sans-serif';
    const padding = 8;
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padding * 2;
    const height = lines.length * 15 + padding * 1.6;
    let tx = Math.min(x + 10, this.width - width - 6);
    let ty = y - height - 6;
    if (ty < 20) ty = y + 22;

    ctx.fillStyle = 'rgba(15,20,32,0.96)';
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.roundRect(tx, ty, width, height, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = COLORS.textStrong;
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? COLORS.textStrong : COLORS.text;
      ctx.fillText(line, tx + padding, ty + padding + 11 + i * 15);
    });
  }
}
