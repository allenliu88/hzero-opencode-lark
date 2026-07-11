import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { createStreamingBridge, stripThinkingContent, type StreamingBridgeDeps } from "./streaming-integration.js"
import { EventProcessor } from "../streaming/event-processor.js"
import { createMockLogger, createMockFeishuClient, waitFor } from "../__tests__/setup.js"
import type { CardKitClient } from "../feishu/cardkit-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import { ExpiringSet } from "../utils/expiring-set.js"
import { createEmbeddedInteractionRegistry } from "../feishu/embedded-interaction-registry.js"

function createMockInteractiveCardRegistry() {
  const cards = new Map<string, {
    requestId: string
    kind: "question" | "permission"
    chatId: string
    messageId: string
    trackedAt: number
    state: "dispatching" | "sent" | "resolving_feishu"
  }>()

  return {
    beginDispatch: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      if (cards.has(key)) return false
      cards.set(key, {
        requestId,
        kind,
        chatId: "",
        messageId: "",
        trackedAt: Date.now(),
        state: "dispatching",
      })
      return true
    }),
    failDispatch: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      const current = cards.get(key)
      if (!current || current.state !== "dispatching") return false
      cards.delete(key)
      return true
    }),
    track: vi.fn((card: {
      requestId: string
      kind: "question" | "permission"
      chatId: string
      messageId: string
    }) => {
      cards.set(`${card.kind}:${card.requestId}`, {
        ...card,
        trackedAt: Date.now(),
        state: "sent",
      })
    }),
    markFeishuResolving: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      const current = cards.get(key)
      if (!current || current.state !== "sent") return
      cards.set(key, { ...current, state: "resolving_feishu" })
    }),
    clearFeishuResolving: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      const current = cards.get(key)
      if (!current || current.state !== "resolving_feishu") return
      cards.set(key, { ...current, state: "sent" })
    }),
    untrack: vi.fn((kind: "question" | "permission", requestId: string) => cards.delete(`${kind}:${requestId}`)),
    list: vi.fn(() => Array.from(cards.values())),
    close: vi.fn(() => cards.clear()),
  }
}

function createMockCardKitClient() {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
    renewStreaming: vi.fn().mockResolvedValue(undefined),
    pauseStreaming: vi.fn().mockResolvedValue(undefined),
    insertElements: vi.fn().mockResolvedValue(undefined),
    deleteElement: vi.fn().mockResolvedValue(undefined),
  } as unknown as CardKitClient
}

function createMockSubAgentTracker() {
  return {
    onSubtaskDiscovered: vi.fn().mockResolvedValue({
      parentSessionId: "ses-1",
      childSessionId: "child-ses-1",
      prompt: "do something",
      description: "A subtask",
      agent: "code",
      status: "discovering",
    }),
    pollChildSession: vi.fn(),
    getChildMessages: vi.fn(),
    getTrackedSubAgents: vi.fn().mockReturnValue([]),
  } as unknown as SubAgentTracker
}

const createdSeenInteractiveIds: ExpiringSet<string>[] = []

function makeDeps(overrides: Partial<StreamingBridgeDeps> = {}): StreamingBridgeDeps {
  const seenInteractiveIds = new ExpiringSet<string>(30 * 60 * 1000, 2 * 60 * 1000)
  createdSeenInteractiveIds.push(seenInteractiveIds)

  return {
    cardkitClient: createMockCardKitClient(),
    feishuClient: createMockFeishuClient(),
    subAgentTracker: createMockSubAgentTracker(),
    logger: createMockLogger(),
    seenInteractiveIds,
    interactiveCardRegistry: createMockInteractiveCardRegistry(),
    ...overrides,
  }
}

const mockSendMessage = () => Promise.resolve('{"parts":[{"type":"text","text":"mock response"}]}')

describe("createStreamingBridge", () => {
  const ownedSessions = new Set<string>(["ses-1"])
  let eventListeners: EventListenerMap
  let eventProcessor: EventProcessor

  beforeEach(() => {
    vi.restoreAllMocks()
    eventListeners = new Map()
    eventProcessor = new EventProcessor({ ownedSessions })
  })

  afterEach(() => {
    for (const seenSet of createdSeenInteractiveIds.splice(0)) {
      seenSet.close()
    }
  })

  it("embeds questions in the streaming card instead of sending a separate card", async () => {
    const embeddedInteractionRegistry = createEmbeddedInteractionRegistry()
    const deps = makeDeps({
      embeddedInteractionRegistry,
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          msg: "ok",
          data: { message_id: "msg-question" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      vi.fn(),
      "msg_original",
      null,
    )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "question.asked",
      properties: {
        sessionID: "ses-1",
        id: "q-bridge",
        questions: [
          {
            question: "Choose",
            header: "Choice",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect((deps.cardkitClient as any).insertElements).toHaveBeenCalled()

    const inserted = (deps.cardkitClient as any).insertElements.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(inserted)).toContain("question_answer")
    expect(embeddedInteractionRegistry.get("question", "q-bridge")).toBeDefined()
    expect(deps.interactiveCardRegistry?.list()).toEqual([])
    expect(deps.feishuClient.replyMessage).toHaveBeenCalledTimes(1)
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise
  })

  it("creates a streaming card and registers listener", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    ;[...eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlePromise

    expect(deps.feishuClient.replyMessage).toHaveBeenCalledWith(
      "msg_original",
      expect.objectContaining({ msg_type: "interactive" }),
    )

    const callArgs = (deps.feishuClient.replyMessage as any).mock.calls[0]
    const card = JSON.parse(callArgs?.[1]?.content as string)
    expect(card.config?.wide_screen_mode).toBe(true)
    expect(card).not.toHaveProperty("header")
    expect(card.elements?.[0]?.tag).toBe("markdown")
    expect(card.elements?.[0]?.content).toBe("（无回复）")
    expect(onComplete).toHaveBeenCalledWith("（无回复）")
  })

  it("accumulates TextDelta and buffers text locally", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("Hello World")
  })

  it("handles ToolStateChange by calling setToolStatus", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise
    expect((deps.cardkitClient as any).updateElement).toHaveBeenCalled()
  })

  it("handles SubtaskDiscovered by sending separate card via sendMessage", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "subtask",
          prompt: "research topic",
          description: "Research the topic",
          agent: "researcher",
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect((deps.subAgentTracker as any).onSubtaskDiscovered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SubtaskDiscovered",
        description: "Research the topic",
      }),
    )

    const sendCalls = (deps.feishuClient.sendMessage as any).mock.calls
    const subtaskCardCall = sendCalls.find(
      (call: unknown[]) =>
        call[0] === "chat-1" &&
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research the topic"),
    )
    expect(subtaskCardCall).toBeDefined()
    const body1 = subtaskCardCall![1] as { msg_type: string; content: string }
    expect(body1.msg_type).toBe("interactive")
    const cardContent = JSON.parse(body1.content)
    expect(cardContent.header.template).toBe("indigo")
  })

  it("removes listener on SessionIdle", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    ;[...eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlePromise

    expect(eventListeners.size).toBe(0)
  })

  it("serializes concurrent requests for the same session", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
      cardCreationDelayMs: 10_000,
    })
    const bridge = createStreamingBridge(deps)
    const sendFirst = vi.fn().mockResolvedValue("")
    const sendSecond = vi.fn().mockResolvedValue("")

    const first = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor,
      sendFirst, vi.fn(), "msg-first", null,
    )
    await waitFor(() => expect(sendFirst).toHaveBeenCalledOnce())

    const second = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor,
      sendSecond, vi.fn(), "msg-second", null,
    )
    await Promise.resolve()
    expect(sendSecond).not.toHaveBeenCalled()
    expect(eventListeners.get("ses-1")?.size).toBe(1)

    const firstListener = [...eventListeners.get("ses-1")!][0]!
    firstListener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await first

    await waitFor(() => expect(sendSecond).toHaveBeenCalledOnce())
    expect(eventListeners.get("ses-1")?.size).toBe(1)
    const secondListener = [...eventListeners.get("ses-1")!][0]!
    secondListener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await second

    expect(eventListeners.size).toBe(0)
  })

  it("finalizes and removes the listener when the event stream becomes inactive", async () => {
    vi.useFakeTimers()
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const deps = makeDeps({
      feishuClient: mockFeishu,
      inactivityTimeoutMs: 100,
      maxLifetimeMs: 1_000,
      cardCloseTimeoutMs: 50,
    })
    const bridge = createStreamingBridge(deps)
    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      null,
    )
    await vi.advanceTimersByTimeAsync(0)

    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "partial" },
        delta: "partial",
      },
    })

    await vi.advanceTimersByTimeAsync(100)
    await handlePromise

    expect(eventListeners.size).toBe(0)
    expect(onComplete).toHaveBeenCalledWith("partial")
    expect(mockFeishu.replyMessage).toHaveBeenCalled()
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("OpenCode event stream became inactive"),
    )
    vi.useRealTimers()
  })

  it("throws when card.start() fails (for fallback in caller)", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        replyMessage: vi.fn().mockRejectedValue(new Error("Feishu API down")),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation, which will attempt replyMessage and fail
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() attempt
    await new Promise((r) => setTimeout(r, 50))

    // Now complete the session
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    // The bridge should gracefully handle the sendMessage failure from card.start()
    // and still resolve (not reject)
    await handlePromise

    // Verify the handler completed with a response despite card.start() failure
    expect(onComplete).toHaveBeenCalledWith("（无回复）")
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("card start for tool failed"),
    )
    expect(eventListeners.size).toBe(0)
  })

  it("calls close() on the card when SessionIdle received", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect((deps.cardkitClient as any).closeStreaming).toHaveBeenCalled()
  })

  it("logs info when streaming card starts", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve and log
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Streaming card started"),
    )
  })

  it("still completes even if card.close() throws", async () => {
    const mockCardKit = createMockCardKitClient()
    ;(mockCardKit as any).closeStreaming = vi.fn().mockRejectedValue(new Error("close fail"))

    const deps = makeDeps({
      cardkitClient: mockCardKit,
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("（无回复）")
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("card.close() failed"),
    )
  })

  // ── New tests ──

  it("text delta buffers text and sends as replyMessage on idle", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(mockFeishu.replyMessage).toHaveBeenCalledWith(
      "msg_original",
      expect.objectContaining({ msg_type: "interactive" }),
    )

    const replyArgs = (mockFeishu.replyMessage as any).mock.calls[0]
    const card = JSON.parse(replyArgs?.[1]?.content as string)
    expect(card.elements?.[0]?.content).toBe("Hello World")
    expect(onComplete).toHaveBeenCalledWith("Hello World")
  })

  it("streams a direct answer without a blank progress row or duplicate final reply", async () => {
    vi.useFakeTimers()
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const mockCardKit = createMockCardKitClient()
    const deps = makeDeps({
      cardkitClient: mockCardKit,
      feishuClient: mockFeishu,
      cardCreationDelayMs: 0,
    })
    const bridge = createStreamingBridge(deps)
    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      null,
    )
    await vi.advanceTimersByTimeAsync(0)

    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "流式答案" },
        delta: "流式答案",
      },
    })
    await vi.advanceTimersByTimeAsync(300)

    expect((mockCardKit as any).updateElement).toHaveBeenCalledWith(
      "card_123",
      "progress",
      "流式答案",
      expect.any(Number),
    )

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise

    expect(mockFeishu.replyMessage).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith("流式答案")
    vi.useRealTimers()
  })

  it("uses snapshots to correct deltas without duplicating text and ignores other messages", async () => {
    vi.useFakeTimers()
    const mockCardKit = createMockCardKitClient()
    const deps = makeDeps({
      cardkitClient: mockCardKit,
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
      cardCreationDelayMs: 0,
    })
    const bridge = createStreamingBridge(deps)
    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor,
      mockSendMessage, onComplete, "msg_original", null,
    )
    await vi.advanceTimersByTimeAsync(0)
    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.delta",
      properties: {
        sessionID: "ses-1", messageID: "current-message", partID: "part-1",
        field: "text", delta: "你是",
      },
    })
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1", sessionID: "ses-1", messageID: "current-message",
          type: "text", text: "你是谁？",
        },
        delta: "谁？",
      },
    })
    listener({
      type: "message.part.delta",
      properties: {
        sessionID: "ses-1", messageID: "old-message", partID: "old-part",
        field: "text", delta: "无关开发内容",
      },
    })
    await vi.advanceTimersByTimeAsync(300)
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("你是谁？")
    const answerUpdates = (mockCardKit as any).updateElement.mock.calls
      .filter((call: unknown[]) => call[1] === "progress")
    expect(answerUpdates.at(-1)?.[2]).toBe("你是谁？")
    vi.useRealTimers()
  })

  it("does not stream the injected user prompt as the assistant answer", async () => {
    vi.useFakeTimers()
    const mockCardKit = createMockCardKitClient()
    const deps = makeDeps({
      cardkitClient: mockCardKit,
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      },
      cardCreationDelayMs: 0,
    })
    const bridge = createStreamingBridge(deps)
    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor,
      mockSendMessage, onComplete, "msg_original", null,
    )
    await vi.advanceTimersByTimeAsync(0)
    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.updated",
      properties: { info: { id: "user-msg", sessionID: "ses-1", role: "user" } },
    })
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          id: "user-part", sessionID: "ses-1", messageID: "user-msg", type: "text",
          text: "你是谁？\n[Lark context]\nChat: (p2p)",
        },
      },
    })
    listener({
      type: "message.updated",
      properties: { info: { id: "assistant-msg", sessionID: "ses-1", role: "assistant" } },
    })
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          id: "assistant-part", sessionID: "ses-1", messageID: "assistant-msg", type: "text",
          text: "我是飞码智能体。",
        },
      },
    })
    await vi.advanceTimersByTimeAsync(300)
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("我是飞码智能体。")
    const answerUpdates = (mockCardKit as any).updateElement.mock.calls
      .filter((call: unknown[]) => call[1] === "progress")
    expect(answerUpdates.at(-1)?.[2]).toBe("我是飞码智能体。")
    vi.useRealTimers()
  })

  it("rejects a busy session before registering a listener or sending the prompt", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      "ses-1": { type: "busy" },
    }), { status: 200 })) as typeof fetch
    try {
      const deps = makeDeps({ serverUrl: "http://127.0.0.1:4096" })
      const bridge = createStreamingBridge(deps)
      const sendMessage = vi.fn().mockResolvedValue("")

      await expect(bridge.handleMessage(
        "chat-1", "ses-1", eventListeners, eventProcessor,
        sendMessage, vi.fn(), "msg_original", null,
      )).rejects.toMatchObject({ name: "SessionBusyError", sessionId: "ses-1" })

      expect(sendMessage).not.toHaveBeenCalled()
      expect(eventListeners.size).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("skips creating a streaming card for a request completed before the delay", async () => {
    vi.useFakeTimers()
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const mockCardKit = createMockCardKitClient()
    const deps = makeDeps({
      cardkitClient: mockCardKit,
      feishuClient: mockFeishu,
      cardCreationDelayMs: 500,
    })
    const bridge = createStreamingBridge(deps)
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      vi.fn(),
      "msg_original",
      null,
    )
    await vi.advanceTimersByTimeAsync(0)
    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "快速答案" },
        delta: "快速答案",
      },
    })
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise
    await vi.advanceTimersByTimeAsync(500)

    expect((mockCardKit as any).createCard).not.toHaveBeenCalled()
    expect(mockFeishu.replyMessage).toHaveBeenCalledTimes(1)
    const finalReply = mockFeishu.replyMessage.mock.calls[0]!
    const finalCard = JSON.parse((finalReply[1] as { content: string }).content)
    expect(finalCard.elements?.[0]?.content).toBe("快速答案")
    vi.useRealTimers()
  })

  it("sends the complete answer separately when the streaming element is truncated", async () => {
    vi.useFakeTimers()
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const deps = makeDeps({
      cardkitClient: createMockCardKitClient(),
      feishuClient: mockFeishu,
      cardCreationDelayMs: 0,
    })
    const bridge = createStreamingBridge(deps)
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      vi.fn(),
      "msg_original",
      null,
    )
    await vi.advanceTimersByTimeAsync(0)
    const listener = [...eventListeners.get("ses-1")!][0]!
    const longText = "长".repeat(10_000)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: longText },
        delta: longText,
      },
    })
    await vi.advanceTimersByTimeAsync(300)
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise

    expect(mockFeishu.replyMessage).toHaveBeenCalledTimes(2)
    const finalReply = mockFeishu.replyMessage.mock.calls[1]!
    const finalCard = JSON.parse((finalReply[1] as { content: string }).content)
    expect(finalCard.elements?.[0]?.content).toContain("长")
    vi.useRealTimers()
  })

  it("SubtaskDiscovered sends separate card instead of button", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "subtask",
          prompt: "research topic",
          description: "Research the topic",
          agent: "researcher",
        },
      },
    })

    // Wait for async tracker + sendMessage
    await new Promise((r) => setTimeout(r, 50))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    const sendCalls = mockFeishu.sendMessage.mock.calls
    const subtaskCall = sendCalls.find(
      (call: unknown[]) =>
        call[0] === "chat-1" &&
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research the topic"),
    )
    expect(subtaskCall).toBeDefined()
    const body = subtaskCall![1] as { msg_type: string; content: string }
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content)
    expect(parsed.header.template).toBe("indigo")
    expect(parsed.elements[1].actions[0].text.content).toBe("🔍 View Details")
    expect(parsed.elements[1].actions[0].value.childSessionId).toBe("child-ses-1")
  })

  it("text buffer truncates at 100KB", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    const bigText = "x".repeat(110_000)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: bigText },
        delta: bigText,
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    const replyCall = mockFeishu.replyMessage.mock.calls[0]!
    expect(replyCall[0]).toBe("msg_original")
    expect((replyCall[1] as any).msg_type).toBe("interactive")
    const card = JSON.parse((replyCall[1] as { content: string }).content)
    const content = card.elements?.[0]?.content as string
    expect(content).toContain("…(内容过长，已截断)")
    expect(content.length).toBeLessThan(110_000)
  })

  it("sends text as reply and calls deleteReaction when reactionId present", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      deleteReaction: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      "reaction_123",
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Reasoning delta (should be ignored)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "reasoning" },
        delta: "Let me think...",
      },
    })
    // Text delta
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "Hello World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(mockFeishu.replyMessage).toHaveBeenCalledWith(
      "msg_original",
      expect.objectContaining({ msg_type: "interactive" }),
    )

    const replyArgs = (mockFeishu.replyMessage as any).mock.calls[0]
    const card = JSON.parse(replyArgs?.[1]?.content as string)
    expect(card.elements?.[0]?.content).toBe("Hello World")
    // deleteReaction called with correct args
    expect(mockFeishu.deleteReaction).toHaveBeenCalledWith("msg_original", "reaction_123")
  })

  it("sends text as reply and calls deleteReaction when no reasoning content", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      deleteReaction: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      "reaction_123",
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "Hello World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(mockFeishu.replyMessage).toHaveBeenCalledWith(
      "msg_original",
      expect.objectContaining({ msg_type: "interactive" }),
    )
    const replyArgs = (mockFeishu.replyMessage as any).mock.calls[0]
    const card = JSON.parse(replyArgs?.[1]?.content as string)
    expect(card.elements?.[0]?.content).toBe("Hello World")
    // deleteReaction called
    expect(mockFeishu.deleteReaction).toHaveBeenCalledWith("msg_original", "reaction_123")
  })
})

describe("stripThinkingContent", () => {
  it("removes complete thinking and analysis blocks", () => {
    expect(stripThinkingContent(
      "<thinking>内部推理</thinking>可见答案<analysis>更多推理</analysis>",
    )).toBe("可见答案")
  })

  it("hides an incomplete streamed thinking block", () => {
    expect(stripThinkingContent("前文<thinking>尚未结束")).toBe("前文")
    expect(stripThinkingContent("前文<thi")).toBe("前文")
  })
})
