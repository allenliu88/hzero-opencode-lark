import { describe, expect, it, vi } from "vitest"
import { createMockFeishuClient, createMockLogger, waitFor } from "../__tests__/setup.js"
import type { FeishuCardAction } from "../types.js"
import { FileBrowserRegistry } from "./file-browser-registry.js"
import type { RemoteFileClient } from "./types.js"

function action(
  messageId: string,
  value: Record<string, string>,
  operator = "user-1",
): FeishuCardAction {
  return {
    action: { tag: "button", value },
    open_message_id: messageId,
    open_chat_id: "chat-1",
    operator: { open_id: operator },
  }
}

function callbackValues(card: unknown): Array<Record<string, string>> {
  const values: Array<Record<string, string>> = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (record.type === "callback" && record.value && typeof record.value === "object") {
      values.push(record.value as Record<string, string>)
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
  }
  visit(card)
  return values
}

function makeRemote(): RemoteFileClient {
  return {
    getSessionDirectory: vi.fn().mockResolvedValue("/srv/project"),
    listDirectory: vi.fn().mockResolvedValue([
      { name: ".env", path: ".env", type: "file" },
      { name: "src", path: "src", type: "directory" },
      { name: "README.md", path: "README.md", type: "file" },
    ]),
    readFile: vi.fn().mockResolvedValue({
      path: "README.md",
      content: Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join("\n"),
    }),
  }
}

describe("FileBrowserRegistry", () => {
  it("opens a file, pages, and returns using current view tokens", async () => {
    const remote = makeRemote()
    const feishu = createMockFeishuClient()
    const registry = new FileBrowserRegistry(remote, feishu, createMockLogger())
    await registry.open({
      chatId: "chat-1",
      replyToMessageId: "user-msg",
      operatorOpenId: "user-1",
      sessionId: "ses-1",
    })

    const initial = JSON.parse((feishu.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1].content)
    expect(JSON.stringify(initial)).not.toContain(".env")
    const openReadme = callbackValues(initial).find((value) => value.entryKey?.endsWith(":1"))!
    expect(registry.enqueue(action("msg_mock", openReadme)).response).toEqual({
      toast: { type: "info", content: "正在打开文件 README.md" },
    })
    await waitFor(() => expect(remote.readFile).toHaveBeenCalledWith("/srv/project", "README.md"))
    await waitFor(() => expect(feishu.updateMessage).toHaveBeenCalledTimes(2))

    const fileCard = JSON.parse((feishu.updateMessage as ReturnType<typeof vi.fn>).mock.calls[1]![1])
    const nextPage = callbackValues(fileCard).find((value) => value.direction === "next")!
    registry.enqueue(action("msg_mock", nextPage))
    await waitFor(() => expect(feishu.updateMessage).toHaveBeenCalledTimes(4))
    expect((feishu.updateMessage as ReturnType<typeof vi.fn>).mock.calls[3]![1]).toContain("第 61-70 行")

    const secondFileCard = JSON.parse((feishu.updateMessage as ReturnType<typeof vi.fn>).mock.calls[3]![1])
    const back = callbackValues(secondFileCard).find((value) => value.action === "file_browser_back")!
    registry.enqueue(action("msg_mock", back))
    await waitFor(() => expect(remote.listDirectory).toHaveBeenCalledTimes(2))
    registry.close()
  })

  it("returns accurate toasts for unauthorized, duplicate, and stale actions", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const remote = makeRemote()
    ;(remote.listDirectory as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => [
      { name: "src", path: "src", type: "directory" },
    ]).mockImplementationOnce(async () => {
      await pending
      return []
    })
    const feishu = createMockFeishuClient()
    const registry = new FileBrowserRegistry(remote, feishu, createMockLogger())
    await registry.open({
      chatId: "chat-1",
      replyToMessageId: "user-msg",
      operatorOpenId: "user-1",
      sessionId: "ses-1",
    })
    const initial = JSON.parse((feishu.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1].content)
    const openSrc = callbackValues(initial).find((value) => value.entryKey)!

    expect(registry.enqueue(action("msg_mock", openSrc, "user-2")).response).toEqual({
      toast: { type: "warning", content: "只有文件浏览器创建者可以操作" },
    })
    expect(registry.enqueue(action("msg_mock", openSrc)).response).toEqual({
      toast: { type: "info", content: "正在打开目录 src" },
    })
    expect(registry.enqueue(action("msg_mock", openSrc)).response).toEqual({
      toast: { type: "info", content: "该操作正在处理中" },
    })
    const stale = { ...openSrc, actionId: `${openSrc.actionId}:other` }
    expect(registry.enqueue(action("msg_mock", stale)).response).toEqual({
      toast: { type: "warning", content: "目录已更新，请点击最新卡片" },
    })
    release()
    await waitFor(() => expect(remote.listDirectory).toHaveBeenCalledTimes(2))
    registry.close()
  })

  it("retries transient card update failures", async () => {
    const remote = makeRemote()
    const feishu = createMockFeishuClient()
    ;(feishu.updateMessage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ code: 0, msg: "ok" })
    const registry = new FileBrowserRegistry(remote, feishu, createMockLogger())
    await registry.open({
      chatId: "chat-1",
      replyToMessageId: "user-msg",
      operatorOpenId: "user-1",
      sessionId: "ses-1",
    })
    const initial = JSON.parse((feishu.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1].content)
    const openReadme = callbackValues(initial).find((value) => value.entryKey?.endsWith(":1"))!
    registry.enqueue(action("msg_mock", openReadme))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(remote.readFile).toHaveBeenCalled()
    await waitFor(() => expect(feishu.updateMessage).toHaveBeenCalledTimes(3))
    registry.close()
  })
})
