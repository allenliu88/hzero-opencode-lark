import { describe, it, expect, beforeEach, vi } from "vitest"
import { createCommandHandler } from "../command-handler.js"
import { buildCommandSelectedCard } from "../../feishu/interactive-card-response.js"
import { createMockLogger, createMockFeishuClient } from "../../__tests__/setup.js"
import type { SessionManager } from "../../session/session-manager.js"
import type { SessionMapping } from "../../types.js"

function createMockSessionManager(
  mapping: SessionMapping | null = null,
): SessionManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue(mapping?.session_id ?? "ses-new"),
    getSession: vi.fn().mockReturnValue(mapping),
    getExisting: vi.fn().mockResolvedValue(mapping?.session_id),
    deleteMapping: vi.fn().mockReturnValue(true),
    setMapping: vi.fn().mockReturnValue(true),
    updateContext: vi.fn().mockReturnValue(true),
    cleanup: vi.fn().mockReturnValue(0),
    validateAndCleanupStale: vi.fn().mockResolvedValue(0),
  }
}

const DEFAULT_MAPPING: SessionMapping = {
  feishu_key: "chat-1",
  session_id: "ses-123",
  agent: "build",
  created_at: Date.now(),
  last_active: Date.now(),
  is_bound: 1,
}

describe("createCommandHandler", () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockFeishuClient: ReturnType<typeof createMockFeishuClient>
  let mockSessionManager: SessionManager
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockFeishuClient = createMockFeishuClient()
    mockSessionManager = createMockSessionManager(DEFAULT_MAPPING)
    mockFetch = vi.fn()
    globalThis.fetch = mockFetch as any
    vi.clearAllMocks()
  })

  function createHandler(
    sm?: SessionManager,
    opencodeControlClient?: Parameters<typeof createCommandHandler>[0]["opencodeControlClient"],
    selectionPickerRegistry?: Parameters<typeof createCommandHandler>[0]["selectionPickerRegistry"],
  ) {
    return createCommandHandler({
      serverUrl: "http://test:4096",
      sessionManager: sm ?? mockSessionManager,
      feishuClient: mockFeishuClient,
      logger: mockLogger,
      opencodeControlClient,
      selectionPickerRegistry,
    })
  }

  describe("/new", () => {
    it("creates a new session and binds to it via setMapping", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "ses-new" }),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith("http://test:4096/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Feishu chat chat-1" }),
      })
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-new", undefined, {
        sessionTitle: "Feishu chat chat-1",
      })
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已创建并切换到新会话: ses-new" }),
      })
    })

    it("replies with error when session creation fails", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("命令执行失败"),
      })
    })
  })

  describe("/abort", () => {
    it("aborts the current session", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/abort")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/abort",
        { method: "POST" },
      )
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已中止会话: ses-123" }),
      })
    })

    it("replies when no session is bound", async () => {
      const sm = createMockSessionManager(null)
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler(sm)
      const result = await handler("chat-1", "chat-1", "msg-1", "/abort")

      expect(result).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "当前没有绑定的会话。" }),
      })
    })
  })

  describe("/sessions", () => {
    it("opens the shared sessions picker", async () => {
      const selectionPickerRegistry = { open: vi.fn().mockResolvedValue(undefined) }
      const handler = createHandler(undefined, undefined, selectionPickerRegistry as any)
      expect(await handler("chat-1", "chat-1", "msg-1", "/sessions", "user-1")).toBe(true)
      expect(selectionPickerRegistry.open).toHaveBeenCalledWith({
        kind: "sessions", feishuKey: "chat-1", chatId: "chat-1", replyToMessageId: "msg-1", operatorOpenId: "user-1",
      })
    })

    it("rejects opening a picker when operator identity is unavailable", async () => {
      const selectionPickerRegistry = { open: vi.fn() }
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      const handler = createHandler(undefined, undefined, selectionPickerRegistry as any)
      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions")
      expect(result).toBe(true)
      expect(selectionPickerRegistry.open).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "无法确认操作用户，不能打开选择器。" }),
      })
    })
  })

  describe("/agents and /models", () => {
    it("opens the shared agents picker", async () => {
      const selectionPickerRegistry = { open: vi.fn().mockResolvedValue(undefined) }
      const handler = createHandler(undefined, undefined, selectionPickerRegistry as any)
      expect(await handler("chat-1", "chat-1", "msg-1", "/agents", "user-1")).toBe(true)
      expect(selectionPickerRegistry.open).toHaveBeenCalledWith(expect.objectContaining({ kind: "agents", operatorOpenId: "user-1" }))
    })

    it("opens the shared models picker", async () => {
      const selectionPickerRegistry = { open: vi.fn().mockResolvedValue(undefined) }
      const handler = createHandler(undefined, undefined, selectionPickerRegistry as any)
      expect(await handler("chat-1", "chat-1", "msg-1", "/models", "user-1")).toBe(true)
      expect(selectionPickerRegistry.open).toHaveBeenCalledWith(expect.objectContaining({ kind: "models", operatorOpenId: "user-1" }))
    })
  })

  describe("/connect", () => {
    it("connects to a valid session", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ title: "Target Session", directory: "/repo/opencode-lark" }),
        })
        .mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect ses-456")

      expect(result).toBe(true)
      // First fetch: validate session exists
      expect(mockFetch).toHaveBeenNthCalledWith(1, "http://test:4096/session/ses-456")
      // deleteMapping called
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
      // setMapping called
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-456", undefined, {
        sessionTitle: "Target Session",
        directory: "/repo/opencode-lark",
        projectName: "opencode-lark",
        branchName: null,
      })
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已连接到会话: ses-456" }),
      })
    })

    it("replies when session does not exist", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect ses-invalid")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "会话不存在。" }),
      })
    })

    it("replies with usage when session_id is missing", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect")

      expect(result).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "用法: /connect {session_id}" }),
      })
    })
  })

  describe("/files", () => {
    it("opens the browser for the existing session without creating one", async () => {
      const fileBrowserRegistry = { open: vi.fn().mockResolvedValue(undefined) }
      const handler = createCommandHandler({
        serverUrl: "http://test:4096",
        sessionManager: mockSessionManager,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
        fileBrowserRegistry: fileBrowserRegistry as any,
      })

      expect(await handler("chat-1", "chat-1", "msg-1", "/files src", "user-1")).toBe(true)
      expect(fileBrowserRegistry.open).toHaveBeenCalledWith({
        chatId: "chat-1",
        replyToMessageId: "msg-1",
        operatorOpenId: "user-1",
        relativePath: "src",
        sessionId: "ses-123",
      })
      expect(mockSessionManager.getOrCreate).not.toHaveBeenCalled()
    })

    it("prompts for a session when none is bound", async () => {
      const sm = createMockSessionManager(null)
      const fileBrowserRegistry = { open: vi.fn() }
      const handler = createCommandHandler({
        serverUrl: "http://test:4096",
        sessionManager: sm,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
        fileBrowserRegistry: fileBrowserRegistry as any,
      })

      expect(await handler("chat-1", "chat-1", "msg-1", "/files", "user-1")).toBe(true)
      expect(fileBrowserRegistry.open).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("/sessions"),
      })
    })
  })


  describe("/help and /", () => {
    it("builds a command selection card without interactive buttons", () => {
      const card = buildCommandSelectedCard("/new") as {
        elements: Array<{ tag: string; content?: string }>
      }

      expect(card.elements).toEqual([{
        tag: "markdown",
        content: "已选择执行 **新建会话**。",
      }])
      expect(JSON.stringify(card)).not.toContain('"tag":"button"')
    })

    it("/help sends interactive card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/help")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify the card has full structure: config, header, elements
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
      expect(content.header?.title?.content).toContain("命令菜单")
      expect(JSON.stringify(content)).not.toContain("Loading")
      expect(JSON.stringify(content)).not.toContain("test-loading")
    })

    it("/ alone sends interactive card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify the card has full structure
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
    })
  })

  describe("/test-loading", () => {
    it("sends a legacy loading test card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/test-loading")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.header?.title?.content).toBe("工具执行中，请稍候")
      expect(content.header?.template).toBe("yellow")
      expect(content.elements?.[0]?.tag).toBe("div")
      expect(content.elements?.[0]?.loading).toBe(true)
    })

    it("sends a Card JSON 2.0 loading test card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/test-loading-v2")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.schema).toBe("2.0")
      expect(content.header?.title?.content).toBe("工具执行中，请稍候（2.0）")
      expect(content.body?.elements?.[0]?.tag).toBe("div")
      expect(content.body?.elements?.[0]?.loading).toBe(true)
      expect(content.body?.elements?.[0]?.element_id).toBe("loading_div")
    })
  })

  describe("unknown command", () => {
    it("returns false for unrecognized command", async () => {
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/unknown")

      expect(result).toBe(false)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).not.toHaveBeenCalled()
    })

    it("returns false for non-slash text", async () => {
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "hello")

      expect(result).toBe(false)
    })
  })

  describe("error handling", () => {
    it("catches errors and replies with error message", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"))
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("/new failed"),
      )
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("命令执行失败"),
      })
    })

    it("does not crash when error reply also fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"))
      mockFeishuClient.replyMessage = vi.fn().mockRejectedValue(new Error("Reply failed"))

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send error reply"),
      )
    })
  })

  describe("case insensitivity", () => {
    it("handles /NEW as /new", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "ses-new" }),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/NEW")

      expect(result).toBe(true)
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    })
  })
})
