import { describe, expect, it } from "vitest"
import {
  buildAnsweredPermissionCard,
  buildAnsweredQuestionCard,
  buildCommandSelectedCard,
  buildInteractiveCallbackResponse,
} from "./interactive-card-response.js"

describe("interactive-card-response", () => {
  it("immediately replaces a selected command menu with non-interactive text", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: { action: "command_execute", command: "/new" },
      },
      open_message_id: "msg-command",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      card: {
        type: "raw",
        data: buildCommandSelectedCard("/new"),
      },
    })
    expect(JSON.stringify(response)).toContain("已选择执行 **新建会话**。")
    expect(JSON.stringify(response)).not.toContain('"tag":"button"')
  })

  it("returns only a toast for embedded interactions", () => {
    const response = buildInteractiveCallbackResponse({
      action: { tag: "button", value: {
        action: "question_answer",
        requestId: "q-1",
        answers: JSON.stringify([["Yes"]]),
        embedded: "true",
      } },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response.toast).toBeDefined()
    expect(response.card).toBeUndefined()
  })

  it("acknowledges file browser actions without replacing the card", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: { action: "file_browser_refresh" },
      },
      open_message_id: "msg-files",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "info", content: "已收到浏览请求" },
    })
  })

  it("acknowledges agent console control actions", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: { action: "agent_console_abort" },
      },
      open_message_id: "msg-console",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "success", content: "已发送中止请求" },
    })
  })

  it("shows multiple form selections in the callback toast", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: {
          action: "question_answer",
          requestId: "q-1",
          embedded: "true",
          multiple: "true",
          optionLabels: JSON.stringify(["技术约束", "实现方案"]),
        },
        form_value: { question_choice_0: true, question_choice_1: "on" },
      },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "success", content: "Answered: 技术约束，实现方案" },
    })
  })

  it("builds the existing question callback response shape", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: {
          action: "question_answer",
          requestId: "q-1",
          answers: JSON.stringify([["Yes"]]),
        },
      },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "success", content: "Answered: Yes" },
      card: {
        type: "raw",
        data: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: "✅ Question Answered" },
            template: "green",
          },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: "**Answer:** Yes" } },
          ],
        },
      },
    })
  })

  it("builds the existing permission callback response shape", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: {
          action: "permission_reply",
          requestId: "p-1",
          reply: "reject",
        },
      },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "warning", content: "Rejected" },
      card: {
        type: "raw",
        data: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: "❌ Permission: Rejected" },
            template: "red",
          },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: "**Decision:** Rejected" } },
          ],
        },
      },
    })
  })

  it("omits status icons from permission callback toasts", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: {
          action: "permission_reply",
          requestId: "p-1",
          reply: "once",
          embedded: "true",
        },
      },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "success", content: "Allowed (once)" },
    })
  })

  it("builds TUI-resolved cards that clearly show they were handled elsewhere", () => {
    const questionCard = buildAnsweredQuestionCard()
    const permissionCard = buildAnsweredPermissionCard()

    expect(questionCard).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "✅ Question Already Answered" },
        template: "green",
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "**Status:** Answered in opencode TUI." } },
      ],
    })
    expect(permissionCard).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "✅ Permission Request Resolved" },
        template: "green",
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "**Status:** Already handled in opencode TUI." } },
      ],
    })
  })
})
