import type { FeishuCardAction } from "../types.js"

export interface AgentConsoleNavigationTarget {
  readonly chatId: string
  viewTask(taskKey: string): Promise<void>
  viewParent(): Promise<void>
}

export class AgentConsoleRegistry {
  private readonly targets = new Map<string, AgentConsoleNavigationTarget>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1_000) {}

  register(messageId: string, target: AgentConsoleNavigationTarget): void {
    const existing = this.timers.get(messageId)
    if (existing) clearTimeout(existing)
    this.targets.set(messageId, target)
    const timer = setTimeout(() => this.unregister(messageId), this.ttlMs)
    timer.unref?.()
    this.timers.set(messageId, timer)
  }

  unregister(messageId: string): void {
    this.targets.delete(messageId)
    const timer = this.timers.get(messageId)
    if (timer) clearTimeout(timer)
    this.timers.delete(messageId)
  }

  async handle(action: FeishuCardAction): Promise<boolean> {
    const target = this.targets.get(action.open_message_id)
    if (!target || target.chatId !== action.open_chat_id) return false
    const actionType = action.action.value.action
    if (actionType === "agent_console_back") {
      await target.viewParent()
      return true
    }
    if (actionType !== "agent_console_view_child") return false
    const taskKey = action.action.value.taskKey
    if (!taskKey) return false
    await target.viewTask(taskKey)
    return true
  }

  close(): void {
    this.targets.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
