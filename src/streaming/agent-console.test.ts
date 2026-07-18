import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AgentConsoleSession } from "./agent-console.js"
import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import { createMockFeishuClient } from "../__tests__/setup.js"

function createMockCardKitClient(): CardKitClient & {
  createCard: ReturnType<typeof vi.fn>
  updateElement: ReturnType<typeof vi.fn>
  closeStreaming: ReturnType<typeof vi.fn>
  renewStreaming: ReturnType<typeof vi.fn>
  pauseStreaming: ReturnType<typeof vi.fn>
  insertElements: ReturnType<typeof vi.fn>
  deleteElement: ReturnType<typeof vi.fn>
} {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
    renewStreaming: vi.fn().mockResolvedValue(undefined),
    pauseStreaming: vi.fn().mockResolvedValue(undefined),
    insertElements: vi.fn().mockResolvedValue(undefined),
    deleteElement: vi.fn().mockResolvedValue(undefined),
  } as any
}

function createSession() {
  const cardkitClient = createMockCardKitClient()
  const feishuClient = createMockFeishuClient()
  ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
    code: 0,
    msg: "ok",
    data: { message_id: "msg_456" },
  })
  ;(feishuClient.replyMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
    code: 0,
    msg: "ok",
    data: { message_id: "msg_456" },
  })
  const session = new AgentConsoleSession({
    cardkitClient,
    feishuClient,
    chatId: "chat_789",
    replyToMessageId: "msg_original",
    requestText: "优化飞书交互体验",
  })
  return { session, cardkitClient, feishuClient }
}

describe("AgentConsoleSession", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts a Feima agent streaming card", async () => {
    const { session, cardkitClient, feishuClient } = createSession()

    await session.start()

    const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
    expect(schema.schema).toBe("2.0")
    expect(schema.header?.title.content).toBe("🧠 飞码智能体")
    expect(schema.config.streaming_mode).toBe(true)
    expect(schema.config.summary.content).toBe("飞码智能体执行中")
    expect(schema.body.elements[0]?.content).toContain("正在分析请求")
    expect(schema.body.elements[0]?.content).toContain("已用时 0 秒")
    expect(schema.body.elements[0]?.element_id).toBe("progress")
    expect(schema.body.elements[1]).toEqual({ tag: "markdown", content: "", element_id: "answer" })
    expect(feishuClient.replyMessage).toHaveBeenCalledWith("msg_original", {
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: "card_123" } }),
    })
    expect(feishuClient.sendMessage).not.toHaveBeenCalled()
  })

  it("renders bottom controls with three selectors and abort button", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.replyMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { message_id: "msg_456" },
    })
    const session = new AgentConsoleSession({
      cardkitClient,
      feishuClient,
      chatId: "chat_789",
      replyToMessageId: "msg_original",
      controls: {
        canAbort: true,
        sessionId: "ses-1",
        sessionTitle: "实现主卡控制区",
        agentLabel: "build",
        modelLabel: "anthropic:claude",
        projectName: "opencode-lark",
        branchName: "main",
      },
    })

    await session.start()

    const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
    const serialized = JSON.stringify(schema.body.elements)
    expect(schema.header?.title.content).toBe("🧠 飞码智能体 · opencode-lark#main")
    expect(serialized).toContain("agentCtlHr")
    expect(serialized).toContain("ses-1")
    expect(serialized).toContain("实现主卡控制区")
    expect(serialized).toContain("智能体")
    expect(serialized).toContain("build")
    expect(serialized).toContain("**当前上下文**：会话 `实现主卡控制区` · `ses-1` · 项目 `opencode-lark#main` · 智能体 `build` · 模型 `anthropic/claude`")
    expect(serialized).toContain("**帮助**：")
    expect(serialized).toContain("/agents")
    expect(serialized).toContain("/models")
    expect(serialized).toContain("/sessions")
    expect(serialized).toContain("/files")
    expect(serialized).toContain("/abort")
    expect(serialized).toContain("/help")
  })

  it("keeps bottom controls when closing the streaming card", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.replyMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { message_id: "msg_456" },
    })
    const session = new AgentConsoleSession({
      cardkitClient,
      feishuClient,
      chatId: "chat_789",
      replyToMessageId: "msg_original",
      controls: { canAbort: true, sessionId: "ses-1", sessionTitle: "Session 1" },
    })

    await session.start()
    await session.close({ finalAnswer: "完成" })

    const deletedIds = cardkitClient.deleteElement.mock.calls.map((call) => call[1])
    expect(deletedIds).not.toContain("agentCtl")
    expect(deletedIds).not.toContain("agentCtlInfo")
    expect(deletedIds).not.toContain("agentCtlHr")
  })

  it("refreshes the footer when the actual model becomes available", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.replyMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { message_id: "msg_456" },
    })
    const session = new AgentConsoleSession({
      cardkitClient,
      feishuClient,
      chatId: "chat_789",
      replyToMessageId: "msg_original",
      controls: { canAbort: true, sessionId: "ses-1", sessionTitle: "Session 1" },
    })
    await session.start()
    const initial = JSON.stringify((cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema).body.elements)
    expect(initial).toContain("未知模型")

    cardkitClient.updateElement.mockClear()
    await session.setControls({
      canAbort: true,
      sessionId: "ses-1",
      sessionTitle: "Session 1",
      modelLabel: "anthropic:claude-sonnet-4",
    })
    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123",
      "agentCtlInfo",
      expect.stringContaining("模型 `anthropic/claude-sonnet-4`"),
      expect.any(Number),
    )
  })

  it("starts only once when called concurrently", async () => {
    const { session, cardkitClient, feishuClient } = createSession()
    let resolveCreate!: (cardId: string) => void
    cardkitClient.createCard.mockReturnValue(new Promise((resolve) => {
      resolveCreate = resolve
    }))

    const first = session.start()
    const second = session.start()
    resolveCreate("card_123")
    await Promise.all([first, second])

    expect(cardkitClient.createCard).toHaveBeenCalledOnce()
    expect(feishuClient.replyMessage).toHaveBeenCalledOnce()
  })

  it("updates elapsed time while analyzing", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123",
      "progress",
      "正在分析请求... · 已用时 1 秒",
      expect.any(Number),
    )
    await session.close()
  })

  it("updates the same timeline item when partId matches", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.setToolStatus({ partId: "part-1", name: "read", state: "running", title: "src/index.ts" })
    await session.setToolStatus({ partId: "part-1", name: "read", state: "completed", title: "src/index.ts" })

    const content = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(content).toContain("✓ 已读取 src/index.ts")
    expect(content).not.toContain("正在读取")
  })

  it("renders elapsed time inline after the running action", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.setToolStatus({ partId: "part-1", name: "read", state: "running", title: "pom.xml" })

    const content = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(content).toContain("正在读取 pom.xml · 已用时 0 秒")
  })

  it("shows interaction start time, then freezes question and waiting durations", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 10, 8, 15, 30))
    const { session, cardkitClient } = createSession()
    await session.start()

    const pending = session.setToolStatus({
      partId: "question-tool",
      name: "question",
      state: "pending",
      title: "Asked 1 question",
    })
    await vi.advanceTimersByTimeAsync(300)
    await pending
    let questionContent = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(questionContent).toContain("正在执行 question Asked 1 question · 08:15:30")

    await vi.advanceTimersByTimeAsync(500)
    const running = session.setToolStatus({
      partId: "question-tool",
      name: "question",
      state: "running",
      title: "Asked 1 question",
    })
    await vi.advanceTimersByTimeAsync(300)
    await running
    questionContent = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(questionContent).toContain("正在执行 question Asked 1 question · 08:15:30")

    await vi.advanceTimersByTimeAsync(500)
    const completed = session.setToolStatus({ partId: "question-tool", name: "question", state: "completed" })
    const waiting = session.setWaitingForQuestion("请选择你希望我接下来协助处理的事项（可多选）：", "q-1")
    await vi.advanceTimersByTimeAsync(300)
    await Promise.all([completed, waiting])

    const waitingContent = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(waitingContent).toContain("✓ 已执行 question Asked 1 question · 08:15:30")
    expect(waitingContent).toContain(
      "? 等待用户回答 请选择你希望我接下来协助处理的事项（可多选）： · 08:15:31",
    )

    await vi.advanceTimersByTimeAsync(26_700)
    const resolved = session.resolveInteraction(["技术约束"])
    await vi.advanceTimersByTimeAsync(300)
    await resolved

    const resolvedContent = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(resolvedContent).toContain("✓ 已执行 question Asked 1 question · 用时 28.6 秒")
    expect(resolvedContent).toContain(
      "? 等待用户回答 请选择你希望我接下来协助处理的事项（可多选）： · 已等待 27 秒",
    )
    expect(resolvedContent).toContain("你选择的是：**技术约束**。")
  })

  it("replaces initial progress with a direct answer without a blank placeholder", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()

    const update = session.setAnswerText("正在生成的答案")
    await vi.advanceTimersByTimeAsync(300)
    await update

    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123",
      "progress",
      "正在生成的答案",
      expect.any(Number),
    )
    expect(cardkitClient.updateElement).not.toHaveBeenCalledWith(
      "card_123", "progress", "\u200B", expect.any(Number),
    )
  })

  it("moves an existing answer below the timeline when a tool starts", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()

    const answer = session.setAnswerText("先检查一下")
    await vi.advanceTimersByTimeAsync(300)
    await answer
    const tool = session.setToolStatus({ partId: "part-1", name: "read", state: "running" })
    await vi.advanceTimersByTimeAsync(600)
    await tool

    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123", "answer", "先检查一下", expect.any(Number),
    )
    expect(cardkitClient.updateElement.mock.calls.at(-1)?.[1]).toBe("progress")
  })

  it("refreshes running elapsed time and freezes it on completion", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-10T00:00:00Z"))
    const { session, cardkitClient } = createSession()
    await session.start()

    const running = session.setToolStatus({ partId: "part-1", name: "bash", state: "running", title: "bun test" })
    await vi.advanceTimersByTimeAsync(300)
    await running
    cardkitClient.updateElement.mockClear()

    await vi.advanceTimersByTimeAsync(1_000)
    const elapsedContent = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(elapsedContent).toContain("正在执行命令 bun test · 已用时 1 秒")

    const completed = session.setToolStatus({ partId: "part-1", name: "bash", state: "completed" })
    await vi.advanceTimersByTimeAsync(300)
    await completed
    const completedContent = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(completedContent).toContain("✓ 已执行命令 bun test · 用时 1.3 秒")

    const callCount = cardkitClient.updateElement.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(cardkitClient.updateElement).toHaveBeenCalledTimes(callCount)
  })

  it("keeps existing detail when completed event has no path", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.setToolStatus({ partId: "part-1", name: "read", state: "running", input: { path: "src/streaming" } })
    await session.setToolStatus({ partId: "part-1", name: "read", state: "completed" })

    const content = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(content).toContain("✓ 已读取 src/streaming")
  })

  it("keeps separate timeline items for different partIds", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.setToolStatus({ partId: "part-1", name: "bash", state: "completed", title: "bun test" })
    await session.setToolStatus({ partId: "part-2", name: "bash", state: "completed", title: "bun run build" })

    const content = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(content).toContain("✓ 已执行命令 bun test")
    expect(content).toContain("✓ 已执行命令 bun run build")
  })

  it("renders description@agent as a task navigation control and supports Back", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()
    await session.setTaskStatus({
      partId: "task-1",
      description: "Excel开发问答",
      agent: "问答助手",
      state: "running",
      childSessionId: "ses-child-1",
    })

    const progress = cardkitClient.updateElement.mock.calls
      .find((call) => call[1] === "progress")?.[2] as string
    expect(progress).toContain("正在执行子任务 Excel开发问答@问答助手")

    const taskElements = cardkitClient.insertElements.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(taskElements)).toContain("Excel开发问答@问答助手")
    expect(JSON.stringify(taskElements)).toContain("agent_console_view_child")
    expect(JSON.stringify(taskElements)).toContain('"taskKey":"task-1"')

    await session.markChildOutput("ses-child-1")
    await session.viewChild("ses-child-1")
    const childElements = cardkitClient.insertElements.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(childElements)).toContain("← 返回")
    expect(JSON.stringify(childElements)).toContain("Excel开发问答@问答助手")
    expect(cardkitClient.updateElement).not.toHaveBeenCalledWith(
      "card_123", "answer", "正在分析 Excel 文件", expect.any(Number),
    )
    expect(cardkitClient.updateElement.mock.calls
      .filter((call) => call[1] === "progress")
      .at(-1)?.[2]).toContain("正在输出")

    await session.viewParent()
    const restoredElements = cardkitClient.insertElements.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(restoredElements)).toContain("Excel开发问答@问答助手")
  })

  it("renders child tool calls with the same dynamic timeline as the parent", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()
    const task = session.setTaskStatus({
      partId: "task-1",
      description: "Excel开发问答",
      agent: "问答助手",
      state: "completed",
      childSessionId: "ses-child-1",
    })
    await vi.advanceTimersByTimeAsync(300)
    await task
    const switchView = session.viewChild("ses-child-1")
    await vi.advanceTimersByTimeAsync(600)
    await switchView

    const running = session.setChildToolStatus("ses-child-1", {
      partId: "child-tool-1",
      name: "read",
      state: "running",
      title: "workbook.ts",
    })
    await vi.advanceTimersByTimeAsync(300)
    await running
    let content = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(content).toContain("正在读取 workbook.ts · 已用时 0 秒")

    await vi.advanceTimersByTimeAsync(1_000)
    content = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(content).toContain("正在读取 workbook.ts · 已用时 1 秒")

    const completed = session.setChildToolStatus("ses-child-1", {
      partId: "child-tool-1",
      name: "read",
      state: "completed",
      title: "workbook.ts",
    })
    await vi.advanceTimersByTimeAsync(300)
    await completed
    content = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(content).toContain("✓ 已读取 workbook.ts · 用时 1.3 秒")
  })

  it("removes a completed child navigation control after returning to the parent", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()
    await session.setTaskStatus({
      partId: "task-1",
      description: "Excel开发问答",
      agent: "问答助手",
      state: "running",
      childSessionId: "ses-child-1",
    })
    await session.markChildOutput("ses-child-1")
    await session.viewChild("ses-child-1")
    await session.setChildStatus("ses-child-1", "completed")
    cardkitClient.insertElements.mockClear()
    await session.viewParent()

    expect(JSON.stringify(cardkitClient.insertElements.mock.calls)).not.toContain("agent_console_view_child")
  })

  it("shows a live output timer in the child view", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()
    const task = session.setTaskStatus({
      partId: "task-1",
      description: "Excel开发问答",
      agent: "问答助手",
      state: "running",
      childSessionId: "ses-child-1",
    })
    await vi.advanceTimersByTimeAsync(300)
    await task
    const switchView = session.viewChild("ses-child-1")
    await vi.advanceTimersByTimeAsync(600)
    await switchView
    const answer = session.markChildOutput("ses-child-1")
    await vi.advanceTimersByTimeAsync(300)
    await answer
    const initialProgress = cardkitClient.updateElement.mock.calls
      .filter((call) => call[1] === "progress")
      .at(-1)?.[2] as string
    expect(initialProgress).toContain("正在输出... · 已用时 0 秒")

    await vi.advanceTimersByTimeAsync(1_000)
    const progressUpdates = cardkitClient.updateElement.mock.calls.filter((call) => call[1] === "progress")
    expect(progressUpdates.at(-1)?.[2]).toContain("正在输出... · 已用时 1 秒")
  })

  it("hides the output timer while a child tool is active", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()
    const task = session.setTaskStatus({
      partId: "task-1",
      description: "Excel开发问答",
      agent: "问答助手",
      state: "running",
      childSessionId: "ses-child-1",
    })
    await vi.advanceTimersByTimeAsync(300)
    await task
    const switchView = session.viewChild("ses-child-1")
    await vi.advanceTimersByTimeAsync(600)
    await switchView
    const tool = session.setChildToolStatus("ses-child-1", {
      partId: "nested-task",
      name: "task",
      state: "running",
      title: "执行子子任务",
    })
    await vi.advanceTimersByTimeAsync(300)
    await tool
    await session.markChildOutput("ses-child-1")
    await vi.advanceTimersByTimeAsync(300)

    const progress = cardkitClient.updateElement.mock.calls
      .filter((call) => call[1] === "progress")
      .at(-1)?.[2] as string
    expect(progress).toContain("正在执行子任务")
    expect(progress).not.toContain("正在输出")
  })

  it("keeps parent updates cached while viewing a child and restores them on Back", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()
    await session.setTaskStatus({
      partId: "task-1",
      description: "Excel开发问答",
      agent: "问答助手",
      state: "running",
      childSessionId: "ses-child-1",
    })
    await session.viewChild("ses-child-1")
    cardkitClient.updateElement.mockClear()

    await session.setAnswerText("主 Session 最新回答")

    expect(cardkitClient.updateElement).not.toHaveBeenCalledWith(
      "card_123", "answer", "主 Session 最新回答", expect.any(Number),
    )
    await session.viewParent()
    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123", "answer", "主 Session 最新回答", expect.any(Number),
    )
  })

  it("matches a completed tool to the latest fallback running item", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.setToolStatus({ name: "bash", state: "running", title: "bun test" })
    await session.setToolStatus({ name: "bash", state: "completed", title: "bun test" })

    const content = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(content.match(/bun test/g)).toHaveLength(1)
    expect(content).toContain("✓ 已执行命令 bun test")
  })

  it("coalesces burst updates to the latest timeline snapshot", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()

    const running = session.setToolStatus({ partId: "part-1", name: "bash", state: "running" })
    const completed = session.setToolStatus({ partId: "part-1", name: "bash", state: "completed" })
    await vi.advanceTimersByTimeAsync(300)
    await Promise.all([running, completed])

    expect(cardkitClient.updateElement).toHaveBeenCalledOnce()
    expect(cardkitClient.updateElement.mock.calls[0]![2]).toContain("✓ 已执行命令")
  })

  it("recovers after a failed update and still closes streaming", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()
    cardkitClient.updateElement
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined)

    const failed = session.setToolStatus({ partId: "part-1", name: "read", state: "running" })
    const failedExpectation = expect(failed).rejects.toThrow("temporary failure")
    await vi.advanceTimersByTimeAsync(300)
    await failedExpectation

    const recovered = session.setToolStatus({ partId: "part-1", name: "read", state: "completed" })
    await vi.advanceTimersByTimeAsync(300)
    await recovered
    await session.close()

    expect(cardkitClient.updateElement).toHaveBeenCalledTimes(2)
    expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
  })

  it("renders waiting permission state", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.setWaitingForPermission("bun test", "perm-1")

    const content = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(content).not.toContain("飞码智能体 ·")
    expect(content).toContain("? 等待权限确认 bun test")
    expect(content).toContain("请在下方权限卡片中选择。")
  })

  it("embeds horizontal question options and removes them after resolution", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()
    await session.setWaitingForQuestion("是否继续？", "q-1")

    await session.showQuestion({
      type: "QuestionAsked",
      sessionId: "ses-1",
      requestId: "q-1",
      questions: [{
        header: "确认",
        question: "是否继续？",
        options: [{ label: "继续", description: "" }],
      }],
    })

    expect(cardkitClient.pauseStreaming).toHaveBeenCalledWith(
      "card_123", "等待用户操作", expect.any(Number),
    )
    const elements = cardkitClient.insertElements.mock.calls[0]![1]
    expect(elements[0]?.element_id).toBe("interaction")
    expect(JSON.stringify(elements)).toContain("question_answer")
    expect(JSON.stringify(elements)).toContain('"embedded":"true"')
    const optionRow = (elements[0] as any).columns[0].elements[1]
    expect(optionRow.tag).toBe("column_set")
    expect(optionRow.columns).toHaveLength(1)
    expect(optionRow.columns[0].elements[0]).toMatchObject({
      tag: "button",
      width: "fill",
    })

    await session.resolveInteraction(["继续"])

    expect(cardkitClient.deleteElement).toHaveBeenCalledWith(
      "card_123", "interaction", expect.any(Number),
    )
    expect(cardkitClient.insertElements).toHaveBeenCalledTimes(1)
    expect(cardkitClient.renewStreaming).toHaveBeenCalled()
    const resolvedProgress = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(resolvedProgress).toContain("? 等待用户回答 是否继续？ · 已等待")
    expect(resolvedProgress).toContain("你选择的是：**继续**。")

    cardkitClient.deleteElement.mockClear()
    await session.setAnswerText("继续执行")
    await session.setToolStatus({ partId: "part-1", name: "read", state: "running" })
    await session.close({ finalAnswer: "完成" })
    expect(cardkitClient.deleteElement).not.toHaveBeenCalled()
  })

  it("lays out permission choices horizontally", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.showPermission({
      type: "PermissionRequested",
      sessionId: "ses-1",
      requestId: "p-1",
      permissionType: "edit",
      title: "src/index.ts",
      metadata: {},
    })

    const elements = cardkitClient.insertElements.mock.calls[0]![1]
    const optionRow = (elements[0] as any).columns[0].elements[1]
    expect(optionRow.tag).toBe("column_set")
    expect(optionRow.columns).toHaveLength(3)
    expect(optionRow.columns.map((column: any) => column.elements[0].text.content)).toEqual([
      "仅允许本次",
      "始终允许",
      "拒绝",
    ])
  })

  it("renders horizontal checkboxes and displays all selected values", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()
    await session.setWaitingForQuestion("你希望我接下来做哪类事情？", "q-multi")

    await session.showQuestion({
      type: "QuestionAsked",
      sessionId: "ses-1",
      requestId: "q-multi",
      questions: [{
        header: "类别",
        question: "你希望我接下来做哪类事情？",
        multiple: true,
        options: [
          { label: "技术约束", description: "" },
          { label: "实现方案", description: "" },
        ],
      }],
    })

    const elements = cardkitClient.insertElements.mock.calls[0]![1]
    expect(elements[0]).toMatchObject({ tag: "form", name: "question_form" })
    const optionRow = (elements[0] as any).elements[1]
    expect(optionRow.tag).toBe("column_set")
    expect(optionRow.columns).toHaveLength(2)
    expect(optionRow.columns[0].elements[0]).toMatchObject({
      tag: "checker",
      name: "question_choice_0",
      text: { content: "技术约束" },
    })
    expect(optionRow.columns[1].elements[0]).toMatchObject({
      tag: "checker",
      name: "question_choice_1",
      text: { content: "实现方案" },
    })
    const submitRow = (elements[0] as any).elements[2]
    expect(submitRow).toMatchObject({ tag: "column_set", horizontal_align: "left" })
    expect(submitRow.columns[0].elements[0]).toMatchObject({
      tag: "button",
      form_action_type: "submit",
      text: { content: "✅ 确认选择" },
    })

    await session.resolveInteraction(["技术约束", "实现方案"])

    const resolvedProgress = cardkitClient.updateElement.mock.calls.at(-1)?.[2] as string
    expect(resolvedProgress).toContain("? 等待用户回答 你希望我接下来做哪类事情？ · 已等待")
    expect(resolvedProgress).toContain("你选择的是：**技术约束，实现方案**。")
  })

  it("resumes streaming when embedding an interaction fails", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()
    cardkitClient.insertElements.mockRejectedValueOnce(new Error("unsupported"))

    await expect(session.showPermission({
      type: "PermissionRequested",
      sessionId: "ses-1",
      requestId: "p-1",
      permissionType: "edit",
      title: "src/index.ts",
      metadata: {},
    })).rejects.toThrow("unsupported")

    expect(cardkitClient.renewStreaming).toHaveBeenCalled()
  })

  it("closes streaming with completed summary", async () => {
    const { session, cardkitClient } = createSession()
    await session.start()

    await session.close()

    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "飞码智能体已完成",
      expect.any(Number),
    )
  })

  it("skips heartbeat renewal while analysis timer is visibly updating", async () => {
    vi.useFakeTimers()
    const { session, cardkitClient } = createSession()
    await session.start()

    await vi.advanceTimersByTimeAsync(8 * 60 * 1000)

    expect(cardkitClient.renewStreaming).not.toHaveBeenCalled()
    await session.close()
  })
})
