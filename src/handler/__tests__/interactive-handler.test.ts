import { describe, it, expect, beforeEach, vi } from "vitest"
import { createInteractiveHandler } from "../interactive-handler.js"
import { createMockFeishuClient, createMockLogger } from "../../__tests__/setup.js"
import type { FeishuCardAction } from "../../types.js"
import { createEmbeddedInteractionRegistry } from "../../feishu/embedded-interaction-registry.js"

function createMockInteractiveCardRegistry() {
  return {
    beginDispatch: vi.fn(),
    failDispatch: vi.fn(),
    track: vi.fn(),
    markFeishuResolving: vi.fn(),
    clearFeishuResolving: vi.fn(),
    untrack: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  }
}

describe("createInteractiveHandler", () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockFetch: ReturnType<typeof vi.fn>
  let mockInteractiveCardRegistry: ReturnType<typeof createMockInteractiveCardRegistry>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockFetch = vi.fn()
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
    })
    mockInteractiveCardRegistry = createMockInteractiveCardRegistry()
    vi.clearAllMocks()
  })

  describe("question_answer action", () => {
    it("successfully answers a question with correct POST request", async () => {
      const feishuClient = createMockFeishuClient()
      vi.mocked(feishuClient.deleteMessage).mockResolvedValue({ code: 0, msg: "ok" })
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        feishuClient,
        interactiveCardRegistry: mockInteractiveCardRegistry,
      })

      const answers = JSON.stringify([["first", "second"]])
      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-123",
            answers,
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
      })

      await handler(action)

      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/question/req-123/reply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: [["first", "second"]] }),
        },
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Question req-123 answered: first",
      )
      expect(mockInteractiveCardRegistry.markFeishuResolving).toHaveBeenCalledWith("question", "req-123")
      expect(mockInteractiveCardRegistry.untrack).toHaveBeenCalledWith("question", "req-123")
      expect(feishuClient.deleteMessage).toHaveBeenCalledWith("msg-1")
    })

    it("resolves an embedded question without deleting the main card", async () => {
      const feishuClient = createMockFeishuClient()
      const embeddedInteractionRegistry = createEmbeddedInteractionRegistry()
      const resolve = vi.fn().mockResolvedValue(undefined)
      embeddedInteractionRegistry.register({ requestId: "req-123", kind: "question", resolve })
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        feishuClient,
        embeddedInteractionRegistry,
      })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" })

      await handler({
        action: { tag: "button", value: {
          action: "question_answer",
          requestId: "req-123",
          answers: JSON.stringify([["继续"]]),
          embedded: "true",
        } },
        open_message_id: "msg-main",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      })

      expect(resolve).toHaveBeenCalledWith(["继续"])
      expect(feishuClient.deleteMessage).not.toHaveBeenCalled()
      expect(embeddedInteractionRegistry.get("question", "req-123")).toBeUndefined()
    })

    it("submits multiple form selections as one question answer", async () => {
      const embeddedInteractionRegistry = createEmbeddedInteractionRegistry()
      const resolve = vi.fn().mockResolvedValue(undefined)
      embeddedInteractionRegistry.register({ requestId: "req-multi", kind: "question", resolve })
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        embeddedInteractionRegistry,
      })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" })

      await handler({
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-multi",
            embedded: "true",
            multiple: "true",
            optionLabels: JSON.stringify(["技术约束", "实现方案"]),
          },
          form_value: { question_choice_0: true, question_choice_1: "true" },
        },
        open_message_id: "msg-main",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/question/req-multi/reply",
        expect.objectContaining({
          body: JSON.stringify({ answers: [["技术约束", "实现方案"]] }),
        }),
      )
      expect(resolve).toHaveBeenCalledWith(["技术约束", "实现方案"])
    })

    it("submits a repeated multi-select callback only once", async () => {
      const embeddedInteractionRegistry = createEmbeddedInteractionRegistry()
      const resolve = vi.fn().mockResolvedValue(undefined)
      embeddedInteractionRegistry.register({ requestId: "req-repeat", kind: "question", resolve })
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        embeddedInteractionRegistry,
      })
      mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK" })
      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-repeat",
            embedded: "true",
            multiple: "true",
            optionLabels: JSON.stringify(["技术约束", "实现方案"]),
          },
          form_value: { question_choice_0: true, question_choice_1: true },
        },
        open_message_id: "msg-main",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await Promise.all([handler(action), handler(action)])

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(1)
    })

    it("logs warn when requestId is missing", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        interactiveCardRegistry: mockInteractiveCardRegistry,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            answers: JSON.stringify([["test"]]),
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Missing requestId or answers in question_answer action",
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("logs warn when answers is missing", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-123",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Missing requestId or answers in question_answer action",
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("logs warn when answers JSON is malformed", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-123",
            answers: "{invalid json",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Failed to parse question answers: {invalid json",
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("logs warn on HTTP non-ok response", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-123",
            answers: JSON.stringify([["test"]]),
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
      })

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Question reply failed: 400 Bad Request",
      )
    })

    it("logs warn on fetch network failure", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        interactiveCardRegistry: mockInteractiveCardRegistry,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-123",
            answers: JSON.stringify([["test"]]),
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      const error = new Error("Network error")
      mockFetch.mockRejectedValueOnce(error)

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Question reply request failed: ${error}`,
      )
      expect(mockInteractiveCardRegistry.clearFeishuResolving).toHaveBeenCalledWith("question", "req-123")
    })
  })

  describe("permission_reply action", () => {
    it("successfully replies permission 'once'", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
        interactiveCardRegistry: mockInteractiveCardRegistry,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            requestId: "req-456",
            reply: "once",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
      })

      await handler(action)

      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/permission/req-456/reply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: "once" }),
        },
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Permission req-456: Allowed (once)",
      )
      expect(mockInteractiveCardRegistry.markFeishuResolving).toHaveBeenCalledWith("permission", "req-456")
      expect(mockInteractiveCardRegistry.untrack).toHaveBeenCalledWith("permission", "req-456")
    })

    it("successfully replies permission 'always'", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            requestId: "req-456",
            reply: "always",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
      })

      await handler(action)

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Permission req-456: Always allowed",
      )
    })

    it("successfully replies permission 'reject'", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            requestId: "req-456",
            reply: "reject",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
      })

      await handler(action)

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Permission req-456: Rejected",
      )
    })

    it("logs warn when requestId is missing", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            reply: "once",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Missing requestId or reply in permission_reply action",
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("logs warn when reply is missing", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            requestId: "req-456",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Missing requestId or reply in permission_reply action",
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it("logs warn on HTTP non-ok response", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            requestId: "req-456",
            reply: "once",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Permission reply failed: 500 Internal Server Error",
      )
    })

    it("logs warn on fetch network failure", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "permission_reply",
            requestId: "req-456",
            reply: "once",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      const error = new Error("Network error")
      mockFetch.mockRejectedValueOnce(error)

      await handler(action)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Permission reply request failed: ${error}`,
      )
    })
  })

  describe("invalid action handling", () => {
    it("returns early when action.action is missing", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {},
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it("returns early when action.value is missing", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action = {
        action: {
          tag: "button",
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      } as any

      await handler(action)

      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it("returns early with unknown action type", async () => {
      const handler = createInteractiveHandler({
        serverUrl: "http://test:4096",
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "unknown_action_type",
            requestId: "req-123",
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })
  })
})
