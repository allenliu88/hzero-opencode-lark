import type { FeishuCardAction } from "../types.js"

export interface AgentConsoleNavigationTarget {
  readonly chatId: string
  readonly sessionOptions?: ReadonlySet<string>
  readonly agentOptions?: ReadonlySet<string>
  readonly modelOptions?: ReadonlySet<string>
  readonly projectOptions?: ReadonlySet<string>
  viewTask(taskKey: string): Promise<void>
  viewParent(): Promise<void>
  openSessionPicker?(sourceMessageId: string, operatorOpenId: string): Promise<void>
  openAgentPicker?(sourceMessageId: string, operatorOpenId: string): Promise<void>
  openModelPicker?(sourceMessageId: string, operatorOpenId: string): Promise<void>
  selectSession?(sessionId: string): Promise<void>
  switchAgent?(agentId: string): Promise<void>
  switchModel?(providerId: string, modelId: string): Promise<void>
  switchProject?(projectId: string): Promise<void>
  abort?(): Promise<void>
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
    if (actionType === "agent_console_view_child") {
      const taskKey = action.action.value.taskKey
      if (!taskKey) return false
      await target.viewTask(taskKey)
      return true
    }
    if (actionType === "agent_console_switch_agent") {
      const agentId = action.action.option ?? action.action.value.agentId
      if (!agentId || !target.switchAgent || !target.agentOptions?.has(agentId)) return false
      await target.switchAgent(agentId)
      return true
    }
    if (actionType === "agent_console_select_session") {
      const sessionId = action.action.value.sessionId
      if (!sessionId || !target.selectSession || !target.sessionOptions?.has(sessionId)) return false
      await target.selectSession(sessionId)
      return true
    }
    if (actionType === "agent_console_switch_model") {
      const selected = action.action.option ?? action.action.value.modelId
      if (!selected || !target.switchModel || !target.modelOptions?.has(selected)) return false
      const separator = selected.indexOf(":")
      if (separator <= 0 || separator === selected.length - 1) return false
      await target.switchModel(selected.slice(0, separator), selected.slice(separator + 1))
      return true
    }
    if (actionType === "agent_console_switch_project") {
      const projectId = action.action.option
      if (!projectId || !target.switchProject || !target.projectOptions?.has(projectId)) return false
      await target.switchProject(projectId)
      return true
    }
    if (actionType === "agent_console_abort") {
      if (!target.abort) return false
      await target.abort()
      return true
    }
    if (
      actionType === "agent_console_open_project_picker"
    ) {
      return true
    }
    if (actionType === "agent_console_open_session_picker") {
      if (!target.openSessionPicker) return false
      await target.openSessionPicker(action.open_message_id, action.operator.open_id)
      return true
    }
    if (actionType === "agent_console_open_agent_picker") {
      if (!target.openAgentPicker) return false
      await target.openAgentPicker(action.open_message_id, action.operator.open_id)
      return true
    }
    if (actionType === "agent_console_open_model_picker") {
      if (!target.openModelPicker) return false
      await target.openModelPicker(action.open_message_id, action.operator.open_id)
      return true
    }
    return false
  }

  close(): void {
    this.targets.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
