# 弱网请求队列（离线排队 · 联网自动补偿）

面向弱网/断网场景的请求可靠性演示与实现，**不使用任何框架和构建工具**，原生
Fetch + AbortController + Service Worker + IndexedDB + BroadcastChannel + Canvas + DOM。

## 运行

Service Worker 不支持 file:// 协议，需要通过 HTTP 访问：

```bash
npm start            # 等价于 python3 -m http.server 8080
# 或：npx serve .
```

打开 http://localhost:8080 。

运行单元测试：

```bash
npm test             # node test/engine.test.js
```

## 功能对照

| 需求 | 实现位置 |
| --- | --- |
| 发起请求，离线时进入队列 | src/engine.js 的 enqueue |
| 联网后自动按顺序重放 | src/engine.js 的 _pump（严格按自增 id 排序，逐条发送） |
| 队列状态/顺序/重试次数/成功失败 | 队列面板（计数、徽标、错误信息）+ 历史面板 |
| 手动触发 / 清空 / 取消单条 | replayNow() / clearQueue() / cancel() |
| 保存请求历史 | IndexedDB history store，最多 100 条，跨刷新保留 |
| 离线检测准确 | src/network.js：online/offline 事件 + /probe 心跳双重确认 |
| 重放失败可重试 | 指数退避（1s→2s→4s…，±20% 抖动，封顶 15s），达到上限后队首阻塞可手动重试 |
| 重复请求去重 | 方法+地址+稳定序列化 body+请求头 指纹，命中未完成请求则合并计数 |
| 队列过长截断 | 超上限时丢弃“最老且尚未开始尝试”的请求，并写入历史留痕 |
| 页面卸载保存队列 | 每次状态变更实时写 IndexedDB；pagehide/visibilitychange 中断在途请求并归位 |
| 队列时序可视化 | src/timeline.js，Canvas 绘制排队/退避/尝试/离线窗口/终态，悬停查看详情 |

## 异常链路处理

- **离线**：在途请求立即 abort，条目归位为“排队”且不消耗重试次数；重放泵停止。
- **联网**：online 事件后必须 /probe 探针成功才判定在线（防“假在线”热点），随后自动唤醒重放。
- **网络抖动**：探针需连续 2 次失败（或浏览器 offline 事件）才判离线，避免状态横跳。
- **重放失败**：408/409/425/429/5xx 等瞬时错误走退避重试；其它 4xx 视为永久失败直接进历史；
  达到最大尝试次数（默认 4）后标记“已失败·待处理”，阻塞队首等待人工取消或重试，
  避免失败请求反复占用队列。
- **重复请求**：JSON body 字段乱序也会被识别为同一条（稳定序列化）。
- **队列截断**：只淘汰尚未开始的最老请求；若全部正在处理则抛 QueueFullError，绝不丢在途请求。
- **页面卸载**：状态实时落盘 + 卸载归位，下次打开页面自动恢复遗留 running 条目并重放。
- **多标签页**：BroadcastChannel 同步数据变更；Web Locks API 选出唯一 leader 执行重放，避免重复发送。

## 页面上怎么验收

1. 勾选“模拟离线（Service Worker）”，发起几条请求 → 状态变红“离线”，请求停留在队列。
2. 连续点相同内容的“加入队列” → 出现“重复 ×N”徽标，只保留一条。
3. 把“队列上限”调小（如 3），点“批量压测 ×12” → 出现截断 toast，最老请求进历史。
4. 取消“模拟离线” → 自动按 #id 顺序重放，成功项移入历史。
5. 调大“服务端失败率 %” → 观察退避等待、重试次数递增；失败上限后可“立即重试”或“重试全部失败”。
6. 刷新页面 / 关闭重开 → 未完成队列和历史仍在。
7. Canvas 时序图展示近 60 秒：蓝色排队、紫色斜纹退避、橙色尝试、绿色/红色终态、红色离线背景带。

## 目录结构

```
index.html            页面骨架
styles.css            样式
sw.js                 Service Worker：外壳缓存、/probe 探针、/api/echo mock（可注入失败率/模拟离线）
src/
  app.js              组装与 DOM 交互
  engine.js           队列引擎（依赖注入，可在 Node 中直接测试）
  store-idb.js        IndexedDB 持久化
  store-memory.js     内存存储（测试用）
  network.js          离线检测（事件 + 心跳）
  timeline.js         Canvas 时序图
  utils.js            指纹去重、退避、状态常量等纯函数
test/engine.test.js   12 个零依赖单元测试
```
