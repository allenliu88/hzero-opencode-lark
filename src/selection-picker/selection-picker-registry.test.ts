import { describe, expect, it, vi } from "vitest"
import { SelectionPickerRegistry } from "./selection-picker-registry.js"
import type { FeishuCardAction, SessionMapping } from "../types.js"

const mapping: SessionMapping = {
  feishu_key: "chat-1",
  session_id: "ses-1",
  agent: "agent-1",
  directory: "/repo",
  provider_id: "provider-1",
  model_id: "model-1",
  branch_name: "fallback-branch",
  created_at: 1,
  last_active: 1,
}

function callbackValues(card: any): Record<string, string>[] {
  return card.body.elements.flatMap((element: any) => element.columns ?? [])
    .flatMap((column: any) => column.elements ?? [])
    .flatMap((element: any) => element.behaviors ?? [])
    .map((behavior: any) => behavior.value)
}

function action(messageId: string, value: Record<string, string>, operator = "user-1"): FeishuCardAction {
  return {
    open_message_id: messageId,
    open_chat_id: "chat-1",
    operator: { open_id: operator },
    action: { tag: "button", value },
  }
}

function setup() {
  const controlClient = {
    listAgents: vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ id: `agent-${index + 1}`, label: `agent-${index + 1}` }))),
    listModels: vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ value: `provider-${index + 1}:model-${index + 1}`, providerId: `provider-${index + 1}`, modelId: `model-${index + 1}`, label: `Friendly ${index + 1}` }))),
    listSessions: vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
      id: `ses-${index + 1}`,
      title: `Session ${index + 1}`,
      directory: "/repo/hzero-opencode-lark",
      time: { updated: Date.now() - 15 * 60_000 },
      summary: { files: 0 },
    }))),
    getSession: vi.fn(),
    getVcs: vi.fn().mockResolvedValue({ branch: "main" }),
  }
  const sessionManager = {
    getSession: vi.fn().mockReturnValue(mapping),
    updateContext: vi.fn().mockReturnValue(true),
    setMapping: vi.fn().mockReturnValue(true),
  }
  const cards: any[] = []
  const feishuClient = {
    replyMessage: vi.fn(async (_messageId, body) => {
      cards.push(JSON.parse(body.content))
      return { code: 0, msg: "ok", data: { message_id: "picker-1" } }
    }),
    updateMessage: vi.fn(async (_messageId, content) => {
      cards.push(JSON.parse(content))
      return { code: 0, msg: "ok" }
    }),
  }
  const registry = new SelectionPickerRegistry(controlClient as any, sessionManager as any, feishuClient as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any)
  return { registry, controlClient, sessionManager, feishuClient, cards }
}

describe("selection picker registry", () => {
  it("paginates eight agent rows and updates the same card", async () => {
    const { registry, cards, feishuClient } = setup()
    await registry.open({ kind: "agents", feishuKey: "chat-1", chatId: "chat-1", replyToMessageId: "source-1", operatorOpenId: "user-1" })
    expect(cards[0].schema).toBe("2.0")
    expect(cards[0].header.title.content).toBe("🤖 选择智能体")
    expect(cards[0].body.elements[0].content).toBe("当前智能体：`agent-1`")
    expect(cards[0].body.elements[1].tag).toBe("hr")
    expect(cards[0].body.elements.filter((item: any) => item.margin === "0px 0px 2px 0px")).toHaveLength(8)
    expect(JSON.stringify(cards[0])).toContain("第 1/2 页")
    const next = callbackValues(cards[0]).find((value) => value.direction === "next")!
    registry.enqueue(action("picker-1", next))
    await vi.waitFor(() => expect(feishuClient.updateMessage).toHaveBeenCalled())
    expect(JSON.stringify(cards[1])).toContain("agent-9")
    expect(JSON.stringify(cards[1])).toContain("第 2/2 页")
  })

  it("renders models only as providerID/modelID without a detail row", async () => {
    const { registry, cards } = setup()
    await registry.open({ kind: "models", feishuKey: "chat-1", chatId: "chat-1", replyToMessageId: "source-1", operatorOpenId: "user-1" })
    expect(cards[0].header.title.content).toBe("🧩 选择模型")
    expect(cards[0].body.elements[0].content).toBe("当前模型：`provider-1/model-1`")
    expect(cards[0].body.elements[1].tag).toBe("hr")
    const rows = cards[0].body.elements.filter((item: any) => item.margin === "0px 0px 2px 0px")
    expect(rows[0].columns[0].elements).toHaveLength(1)
    expect(rows[0].columns[0].elements[0].text.content).toBe("▶ provider-1/model-1")
    expect(JSON.stringify(cards[0])).not.toContain("Friendly")
  })

  it("renders current session and project branch details on every page", async () => {
    const { registry, cards, controlClient, feishuClient } = setup()
    await registry.open({ kind: "sessions", feishuKey: "chat-1", chatId: "chat-1", replyToMessageId: "source-1", operatorOpenId: "user-1" })
    expect(cards[0].header.title.content).toBe("📋 选择会话")
    expect(cards[0].body.elements[0].content).toBe("当前会话：`Session 1` · `ses-1` · `hzero-opencode-lark#main`")
    expect(cards[0].body.elements[1].tag).toBe("hr")
    const rows = cards[0].body.elements.filter((item: any) => item.margin === "0px 0px 2px 0px")
    expect(rows[0].columns[0].elements).toHaveLength(2)
    expect(rows[0].columns[0].elements[0].text.content).toBe("▶ Session 1 · 15分钟前 · 0文件")
    expect(rows[0].columns[0].elements[1].content).toContain("ses-1 · hzero-opencode-lark#main")
    expect(controlClient.getVcs).toHaveBeenCalledTimes(1)

    const next = callbackValues(cards[0]).find((value) => value.direction === "next")!
    registry.enqueue(action("picker-1", next))
    await vi.waitFor(() => expect(feishuClient.updateMessage).toHaveBeenCalled())
    expect(cards[1].body.elements[0].content).toBe("当前会话：`Session 1` · `ses-1` · `hzero-opencode-lark#main`")
    expect(JSON.stringify(cards[1])).toContain("Session 9 · 15分钟前 · 0文件")
    expect(JSON.stringify(cards[1])).toContain("ses-9 · hzero-opencode-lark#main")
    expect(controlClient.getVcs).toHaveBeenCalledTimes(1)
  })

  it("rejects stale and unauthorized callbacks", async () => {
    const { registry, cards, feishuClient } = setup()
    await registry.open({ kind: "agents", feishuKey: "chat-1", chatId: "chat-1", replyToMessageId: "source-1", operatorOpenId: "user-1" })
    const next = callbackValues(cards[0]).find((value) => value.direction === "next")!
    expect(registry.enqueue(action("picker-1", next, "user-2")).response).toEqual({ toast: { type: "warning", content: "只有选择卡片创建者可以操作" } })
    expect(registry.enqueue(action("picker-1", { ...next, viewToken: "stale" })).response).toEqual({ toast: { type: "warning", content: "列表已更新，请点击最新卡片" } })
    expect(feishuClient.updateMessage).not.toHaveBeenCalled()
  })
})
