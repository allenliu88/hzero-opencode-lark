import { describe, expect, it, vi } from "vitest"
import { AgentConsoleRegistry } from "./agent-console-registry.js"

function action(type: string, value: Record<string, string> = {}) {
  return {
    action: { tag: "button", value: { action: type, ...value } },
    open_message_id: "msg-card",
    open_chat_id: "chat-1",
    operator: { open_id: "user-1" },
  }
}

describe("AgentConsoleRegistry", () => {
  it("routes task navigation and Back only for the matching card and chat", async () => {
    const registry = new AgentConsoleRegistry()
    const target = { chatId: "chat-1", viewTask: vi.fn(), viewParent: vi.fn() }
    registry.register("msg-card", target)

    await expect(registry.handle(action("agent_console_view_child", { taskKey: "task-1" }))).resolves.toBe(true)
    expect(target.viewTask).toHaveBeenCalledWith("task-1")
    await expect(registry.handle(action("agent_console_back"))).resolves.toBe(true)
    expect(target.viewParent).toHaveBeenCalledOnce()

    const wrongChat = { ...action("agent_console_back"), open_chat_id: "chat-2" }
    await expect(registry.handle(wrongChat)).resolves.toBe(false)
  })

  it("keeps completed-card navigation until its TTL expires", async () => {
    vi.useFakeTimers()
    const registry = new AgentConsoleRegistry(1_000)
    const target = { chatId: "chat-1", viewTask: vi.fn(), viewParent: vi.fn() }
    registry.register("msg-card", target)

    await vi.advanceTimersByTimeAsync(999)
    await expect(registry.handle(action("agent_console_back"))).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await expect(registry.handle(action("agent_console_back"))).resolves.toBe(false)
    vi.useRealTimers()
  })

  it("routes control actions only when selected options are registered", async () => {
    const registry = new AgentConsoleRegistry()
    const target = {
      chatId: "chat-1",
      agentOptions: new Set(["build"]),
      modelOptions: new Set(["anthropic:claude-sonnet-4"]),
      projectOptions: new Set(["proj-1"]),
      viewTask: vi.fn(),
      viewParent: vi.fn(),
      switchAgent: vi.fn(),
      switchModel: vi.fn(),
      switchProject: vi.fn(),
      abort: vi.fn(),
    }
    registry.register("msg-card", target)

    await expect(registry.handle({ ...action("agent_console_switch_agent"), action: { tag: "select_static", value: { action: "agent_console_switch_agent" }, option: "build" } })).resolves.toBe(true)
    expect(target.switchAgent).toHaveBeenCalledWith("build")
    await expect(registry.handle({ ...action("agent_console_switch_model"), action: { tag: "select_static", value: { action: "agent_console_switch_model" }, option: "anthropic:claude-sonnet-4" } })).resolves.toBe(true)
    expect(target.switchModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4")
    await expect(registry.handle({ ...action("agent_console_switch_project"), action: { tag: "select_static", value: { action: "agent_console_switch_project" }, option: "proj-1" } })).resolves.toBe(true)
    expect(target.switchProject).toHaveBeenCalledWith("proj-1")
    await expect(registry.handle(action("agent_console_abort"))).resolves.toBe(true)
    expect(target.abort).toHaveBeenCalledOnce()
    await expect(registry.handle({ ...action("agent_console_switch_agent"), action: { tag: "select_static", value: { action: "agent_console_switch_agent" }, option: "unknown" } })).resolves.toBe(false)
  })
})
