# 弱网离线请求队列（Offline Request Queue）

纯原生实现（无任何框架），面向弱网/断网环境保证请求不丢：离线入队、联网后严格按序自动重放、失败重试、重复去重、超长截断、卸载保存，并提供 Canvas 队列时序可视化。

## 运行

Service Worker 需要 http(s) 环境（`file://` 下不生效）：

```bash
npm start          # 等价于 python3 -m http.server 8080
# 然后访问 http://127.0.0.1:8080/
```

测试：

```bash
npm test           # 纯函数单测 + 内存 IDB/fetch 桩的队列集成测试
```

## 功能与验收对照

| 验收项 | 实现 |
| --- | --- |
| 离线排队正确 | `NetworkMonitor` 三重判定离线后，`enqueue` 只写 IndexedDB 不发送 |
| 联网后按序重放 | `QueueManager.runLoop` 以单调递增 `seq` 严格 FIFO，同一时刻只发一条；永久失败项不阻塞后续 |
| 失败可重试 | 408/429/5xx 与网络错误按指数退避（500ms→1s→2s，上限 8s，含抖动）自动重试，默认 3 次；支持手动重试 |
| 重复请求去重 | `方法+路径+白名单头+请求体` SHA-256 指纹 + 可配置时间窗口（默认 60s），窗口内合并并累计 `dupCount` |
| 队列截断正确 | 超过 `maxQueueLength` 时只按 seq 丢弃最旧的**排队中**项（标记 `dropped`），发送中/失败/历史不受影响 |
| 页面卸载保存队列 | 每次状态流转都写 IndexedDB，`pagehide` 再兜底全量保存；重开页面把残留 `sending` 恢复为 `queued`（at-least-once） |
| 时序可视化准确 | Canvas 按 seq 分泳道：排队段/发送段/结果标记/重试竖线/离线背景带，悬停看详情 |

其余功能：队列状态与重试次数展示、手动「立即重放」、清空队列（未完成项标记取消，历史保留）、取消单条、请求历史持久化与清理。

## 异常链路设计

- **离线检测准确**：`navigator.onLine` + SW mock 开关 + 每 5s 心跳 `/api/ping`；心跳失败后 800ms 复检，连续失败才判离线，抵御网络抖动。
- **发送途中断网**：`AbortController` 中止在途请求，**不计重试次数**，回到队首等待恢复。
- **多标签页**：`BroadcastChannel` 同步队列状态；Web Locks 选出唯一 leader 负责重放，杜绝跨标签重复发送。
- **确定性错误**：404 等 4xx（除 408/429）不自动重试，需手动触发。

## 技术栈

`Fetch` · `AbortController` · `Service Worker`（mock API + 强制离线/失败率/延迟 + 外壳 network-first 缓存）· `IndexedDB`（队列与设置持久化）· `BroadcastChannel`（跨标签）· Web Locks（leader 选举）· `Canvas 2D`（时序图）· 原生 DOM。

## 目录

```
index.html            页面结构
styles.css            样式
sw.js                 Service Worker：mock API 与弱网模拟
js/db.js              IndexedDB 封装
js/utils.js           去重键/退避/重试判定/截断等纯函数
js/bus.js             BroadcastChannel 事件总线
js/network.js         离线检测（事件 + 心跳 + 抖动复检）
js/queue.js           队列核心：入队/去重/截断/顺序重放/重试/取消/恢复
js/timeline.js        Canvas 时序图
js/ui.js              DOM 绑定与渲染
js/app.js             入口组装
tests/                单测与集成测试
```

## mock API

- `GET /api/ping` 心跳（只受强制离线影响）
- `POST/GET /api/echo`、`GET/POST /api/tasks` 常规成功路由
- `/api/error` 固定 500（验证自动重试）
- `/api/notfound` 固定 404（验证不重试）
- `/api/flaky` 按失败率随机失败

页面上的「强制离线 / 失败率 / 延迟」控件通过 `postMessage` 下发给 Service Worker。
