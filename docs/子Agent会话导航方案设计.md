# 子 Agent 会话导航方案设计

## 目标

飞书用户可以在同一张智能体卡片中查看主 Session 和 Task 创建的子 Session。
主视图中的子任务名称、子视图标题统一使用以下格式：

```text
Excel开发问答@问答助手
```

主视图保留原有执行时间线：

```text
正在执行子任务 Excel开发问答@问答助手 · 已用时 2 分 23 秒
```

任务名称旁提供轻量交互入口。点击后不发送新卡片，而是将原卡片切换为对应
子 Session 的实时视图。子视图顶部展示：

```text
[← 返回]  Excel开发问答@问答助手
```

点击返回后恢复主 Session 的缓存内容。卡片导航只改变展示状态，飞书线程中的
后续消息仍发送到原来绑定的主 Session。

## OpenCode 数据契约

OpenCode 通过 Task 工具 Part 精确记录并行任务与子 Session 的关系：

```text
父 Session 的 Task ToolPart.state.metadata.sessionId -> 子 Session.id
子 Session.parentID                                  -> 父 Session.id
```

系统必须使用 `part.state.metadata.sessionId` 作为权威关联，不能通过
`GET /session/{parent}/children` 返回的最后一个元素推测子 Session。children
接口没有顺序承诺，并行 Task 下可能把多个任务错误关联到同一个子 Session。

任务展示字段来自 Task 工具输入：

```text
description   -> Excel开发问答
subagent_type -> 问答助手
```

展示名称为 `description@subagent_type`。Task 使用父 Session、message ID 和 part
ID 标识；child Session ID 可能在后续 ToolPart 状态更新中才出现。

## 卡片视图模型

每次飞书请求对应一张 Agent Console 卡片和一个内存视图模型：

```ts
type SelectedView =
  | { type: "parent" }
  | { type: "child"; childSessionId: string }

interface TaskView {
  partId: string
  description: string
  agent: string
  childSessionId?: string
  status: "pending" | "running" | "completed" | "error"
}
```

主 Session 和每个子 Session 都维护独立状态：

- 按 message ID、part ID 保存流式文本；
- 保存工具调用时间线；
- 保存工具开始和结束时间，用于动态显示耗时；
- 保存运行、完成和失败状态；
- 保存最终回答。

未选中的 Session 仍持续接收 SSE 并更新缓存，但不会覆盖当前卡片正文。切换后
立即使用缓存渲染，不等待下一条事件。

## 主视图任务入口

CardKit Markdown 中的普通链接只能打开 URL，不能携带卡片 callback。因此任务
时间线继续使用 Markdown 展示状态和耗时，并在其旁边插入尽可能轻量的 CardKit
小型回调控件，控件文案就是 `description@agent`，不额外显示“查看详情”。

当 `metadata.sessionId` 尚未出现时，任务只显示普通时间线；取得精确 child ID 后
才启用交互入口。子任务运行期间显示入口；如果用户正在查看该子任务，完成后仍可
停留并查看最终过程和回答。用户返回主面板后移除该已完成任务的入口，避免误点击。

Task 名称必须同时取得有效的 `description` 和 `subagent_type` 后才渲染。`子任务`、
`子Agent` 等占位值以及 Tool 状态中的通用 `title: Agent` 不得进入时间线或导航；
后续状态更新复用同一 part ID 首次缓存的真实名称。

## 子 Session 视图

现有 CardKit 客户端不能动态修改卡片 Header，因此返回按钮和子任务标题放在正文
导航栏中，卡片全局 Header 保持不变。

子视图与主视图使用相同的工具描述和时间线渲染规则，例如：

```text
[← 返回]  Excel开发问答@问答助手

正在读取 workbook.ts · 已用时 3 秒
✓ 已搜索 formula · 用时 1.2 秒
正在执行命令 bun test · 已用时 8 秒

子 Agent 的流式回答……
```

子工具的 running、completed、error 事件更新同一条时间线记录。运行中工具的耗时
按主视图相同的刷新周期动态更新。

子视图另起一行展示回答输出状态：

```text
正在输出... · 已用时 8 秒
```

只有 child 已产生回答文本，并且当前没有 pending、running、waiting 状态的工具或
子子任务时，才展示该行并开始计时。执行工具或子子任务期间只展示对应工具时间线，
不同时展示“正在输出”，避免状态含义冲突。child 完成后冻结为“已输出”及最终耗时。

子视图不展示 child 的实际回答正文，只展示工具时间线和输出状态。收到首个 child
`TextDelta` 时仅记录 `hasOutput` 状态，不保存文本内容，也不会写入卡片 `answer` 元素。

耗时刷新只针对当前选中的 parent 或 child 视图。导航元素仅在可点击任务集合或当前
视图发生变化时重建，普通 Tool 状态和读秒更新只修改 Markdown 内容，避免卡片跳动。
查看 child 期间，parent 的 TextDelta 只更新缓存，不更新当前卡片；返回 parent 前等待
旧视图内容队列完成，再一次性恢复 parent 最新的 progress 和 answer，避免往返覆盖。

## 事件流程

1. 父 Session 产生 `tool === "task"` 的 `message.part.updated`。
2. `EventProcessor` 保留 part ID、Task 输入和 `state.metadata`。
3. StreamingBridge 按 part ID 幂等更新 Task。
4. `metadata.sessionId` 出现后立即：
   - 将 child 加入 owned session 集合；
   - 注册 child SSE listener；
   - 启用任务名称入口。
5. child 的 TextDelta、ToolStateChange、SessionIdle 分别更新回答、工具时间线和状态。
6. 用户点击任务名称时，同卡切换到 child 缓存视图。
7. 用户点击返回时恢复 parent 缓存视图。

先监听再 hydration 可以避免执行很快的 child 在监听注册前已经结束。HTTP 快照和
SSE 增量按 message/part 合并，避免旧快照覆盖较新的流式内容。

## 并行与顺序保证

- 每个 Task Part 绑定自己的 `metadata.sessionId`；
- 每个 child 拥有独立工具时间线和输出阶段标记；
- 所有 CardKit 内容和结构变更共享递增 sequence；
- 内容更新、元素插入删除、heartbeat、暂停和恢复使用同一个串行 mutation 队列；
- 用户切换与流式更新串行执行；
- parent idle 时，如果已知 child 仍在执行，卡片不会提前完成；
- Task completed/error 可作为错过 child idle 事件时的终止兜底；
- 达到最大生命周期时仍按原有超时机制结束。

父 Task 的 completed/error 不能直接代表 child 已 idle。正常完成只接受 child 自身的
`SessionIdle`；漏收 idle 时先等待 grace period，再查询 `/session/status` 确认 child
已经 idle 后兜底完成，避免提前移除监听并丢失最终文本。

child 不执行历史文本 hydration，也不保存 message/part 文本快照。`TextDelta` 仅作为
“已经开始输出”的信号，从根源上移除 snapshot/delta 合并和重复文本复杂度。

## 完成后的导航

如果用户正在查看子 Session，任务完成不会强制切回主面板，用户可以查看最终工具
时间线和回答，并通过返回按钮回到主 Session。返回后主面板不再展示该已完成任务的
跳转入口。导航注册和卡片视图缓存保留 24 小时，用于处理当前子视图的返回操作；TTL
到期或服务重启后注册自动失效，以控制内存占用。

CardKit 结构和内容更新在流式关闭后仍使用严格递增的 sequence。若飞书环境不支持
关闭流式后的元素变更，需要再改为“保持可更新状态到 TTL”或持久化后重建卡片；
当前实现按 CardKit 元素接口继续更新原卡片。

## 回调安全

生成的飞书卡片消息 ID 是导航注册表主键。回调处理时校验：

- 卡片消息仍在注册表中；
- callback chat 与原卡片 chat 一致；
- taskKey 属于该卡片；
- taskKey 在服务端解析出的 child ID 属于当前任务；
- 导航记录没有超过 TTL。

callback 不信任客户端传入的任意 Session ID，也不会修改 SessionManager 中的飞书
线程映射。

## 兼容策略

旧卡片使用的 `view_subagent` 静态详情处理器继续保留。新标准 Task ToolPart 使用
同卡导航，不再发送独立子 Agent 通知卡。旧版 `subtask` Part 仍可解析，但只有标准
Task ToolPart 提供准确 `state.metadata.sessionId` 时才启用同卡导航。

## 验证范围

- running、completed、error Task metadata 解析；
- 两个并行 Task 对应两个不同 child Session；
- 主视图和子视图都显示 `description@agent`；
- 主视图文案为“正在执行子任务”；
- child 动态展示工具调用和耗时；
- 同卡进入 child 和返回 parent；
- completed Task 返回主面板后不再显示入口；
- child 视图显示“正在输出”动态读秒；
- 卡片关闭流式后仍保留导航注册；
- 非当前 child 的事件不会覆盖当前视图；
- callback 卡片、chat 和 taskKey 校验；
- listener、计时器和注册表按生命周期清理；
- CardKit sequence 严格递增。
