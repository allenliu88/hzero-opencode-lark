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
  const session = new AgentConsoleSession({
    cardkitClient,
    feishuClient,
    chatId: "chat_789",
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
    expect(schema.header?.title.content).toBe("飞码智能体")
    expect(schema.config.streaming_mode).toBe(true)
    expect(schema.config.summary.content).toBe("飞码智能体执行中")
    expect(schema.body.elements[0]?.content).toContain("正在分析请求")
    expect(schema.body.elements[0]?.content).toContain("已用时 0 秒")
    expect(schema.body.elements[0]?.element_id).toBe("progress")
    expect(schema.body.elements[1]).toEqual({ tag: "markdown", content: "", element_id: "answer" })
    expect(feishuClient.sendMessage).toHaveBeenCalledWith("chat_789", {
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: "card_123" } }),
    })
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
    expect(feishuClient.sendMessage).toHaveBeenCalledOnce()
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
    expect(questionContent).toContain("等待执行 question Asked 1 question · 08:15:30")

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
