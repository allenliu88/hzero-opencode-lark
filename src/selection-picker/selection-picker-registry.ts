import { randomBytes } from "node:crypto"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { AgentOption, ModelOption, OpencodeControlClient, SessionOption } from "../opencode/control-client.js"
import type { SessionManager } from "../session/session-manager.js"
import type { FeishuCardAction, SessionMapping } from "../types.js"
import type { Logger } from "../utils/logger.js"

const PAGE_SIZE = 8
const DEFAULT_TTL_MS = 30 * 60 * 1000
const UPDATE_RETRY_DELAYS_MS = [0, 200, 600] as const

export type SelectionPickerKind = "sessions" | "agents" | "models"

interface PickerItem {
  key: string
  label: string
  detail?: string
  value: string
  session?: SessionOption
}

interface PickerState {
  messageId: string
  chatId: string
  operatorOpenId: string
  feishuKey: string
  kind: SelectionPickerKind
  page: number
  viewToken: string
  items: Map<string, PickerItem>
  allItems: Omit<PickerItem, "key">[]
  currentContext: string
  pendingActionIds: Set<string>
  queue: Promise<void>
  timer: ReturnType<typeof setTimeout>
}

export interface OpenSelectionPickerOptions {
  kind: SelectionPickerKind
  feishuKey: string
  chatId: string
  replyToMessageId: string
  operatorOpenId: string
}

export interface SelectionPickerActionResult {
  handled: boolean
  response?: Record<string, unknown>
}

export class SelectionPickerRegistry {
  private readonly states = new Map<string, PickerState>()

  constructor(
    private readonly controlClient: OpencodeControlClient,
    private readonly sessionManager: SessionManager,
    private readonly feishuClient: FeishuApiClient,
    private readonly logger: Logger,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly defaultDirectory = process.env.OPENCODE_CWD || process.cwd(),
  ) {}

  async open(options: OpenSelectionPickerOptions): Promise<void> {
    const mapping = this.sessionManager.getSession(options.feishuKey)
    const loaded = await this.loadItems(options.kind, mapping)
    const rendered = this.render(options.kind, loaded.items, 0, loaded.currentContext)
    const result = await this.feishuClient.replyMessage(options.replyToMessageId, {
      msg_type: "interactive",
      content: JSON.stringify(rendered.card),
    })
    const messageId = result.data?.message_id
    if (typeof messageId !== "string" || !messageId) throw new Error("飞书未返回选择卡片消息 ID")
    this.register({
      messageId,
      chatId: options.chatId,
      operatorOpenId: options.operatorOpenId,
      feishuKey: options.feishuKey,
      kind: options.kind,
      page: rendered.page,
      viewToken: rendered.viewToken,
      items: rendered.items,
      allItems: loaded.items,
      currentContext: loaded.currentContext,
      pendingActionIds: new Set(),
    })
  }

  enqueue(action: FeishuCardAction): SelectionPickerActionResult {
    const actionType = action.action.value.action
    if (!actionType?.startsWith("selection_picker_")) return { handled: false }
    const state = this.states.get(action.open_message_id)
    if (!state || state.chatId !== action.open_chat_id) {
      return { handled: true, response: toast("warning", "选择卡片已过期，请重新打开") }
    }
    if (state.operatorOpenId && state.operatorOpenId !== action.operator.open_id) {
      return { handled: true, response: toast("warning", "只有选择卡片创建者可以操作") }
    }
    const value = action.action.value
    if (!value.viewToken || value.viewToken !== state.viewToken) {
      return { handled: true, response: toast("warning", "列表已更新，请点击最新卡片") }
    }
    const actionId = value.actionId
    if (!actionId || state.pendingActionIds.has(actionId)) {
      return { handled: true, response: toast("info", "该操作正在处理中") }
    }
    const queued = this.resolveAction(state, actionType, value)
    if (!queued) return { handled: true, response: toast("warning", "该操作已失效") }
    state.pendingActionIds.add(actionId)
    state.viewToken = token()
    this.touch(state)
    state.queue = state.queue.catch(() => {}).then(queued).catch((error) => {
      this.logger.error(`Selection picker action failed: ${error}`)
    }).finally(() => state.pendingActionIds.delete(actionId))
    return { handled: true, response: toast("info", actionType === "selection_picker_page" ? "正在切换页面" : "正在切换") }
  }

  close(): void {
    for (const state of this.states.values()) clearTimeout(state.timer)
    this.states.clear()
  }

  private resolveAction(state: PickerState, actionType: string, value: Record<string, string>): (() => Promise<void>) | null {
    if (actionType === "selection_picker_page") {
      const delta = value.direction === "previous" ? -1 : value.direction === "next" ? 1 : 0
      if (!delta) return null
      return async () => {
        const rendered = this.render(state.kind, state.allItems, state.page + delta, state.currentContext)
        await this.updateMessage(state.messageId, rendered.card)
        state.page = rendered.page
        state.viewToken = rendered.viewToken
        state.items = rendered.items
      }
    }
    if (actionType !== "selection_picker_select") return null
    const item = state.items.get(value.entryKey ?? "")
    if (!item) return null
    return async () => {
      await this.select(state, item)
      await this.updateMessage(state.messageId, selectedCard(state.kind, item.label))
      this.unregister(state.messageId)
    }
  }

  private async select(state: PickerState, item: PickerItem): Promise<void> {
    if (state.kind === "agents") {
      this.sessionManager.updateContext(state.feishuKey, { agent: item.value })
      return
    }
    if (state.kind === "models") {
      const separator = item.value.indexOf(":")
      if (separator <= 0) throw new Error("Invalid model selection")
      this.sessionManager.updateContext(state.feishuKey, {
        providerId: item.value.slice(0, separator),
        modelId: item.value.slice(separator + 1),
      })
      return
    }
    const session = item.session ?? await this.controlClient.getSession(item.value)
    if (!session) throw new Error("Session no longer exists")
    const branch = session.directory
      ? (await this.controlClient.getVcs(session.directory).catch((): { branch?: string } => ({}))).branch
      : undefined
    this.sessionManager.setMapping(state.feishuKey, session.id, undefined, {
      sessionTitle: session.title ?? null,
      directory: session.directory ?? null,
      projectName: basename(session.directory) ?? null,
      branchName: branch ?? null,
    })
  }

  private async loadItems(kind: SelectionPickerKind, mapping: SessionMapping | null): Promise<{
    items: Omit<PickerItem, "key">[]
    currentContext: string
  }> {
    const directory = await this.resolveDirectory(mapping)
    if (kind === "sessions") {
      if (!directory) return { items: [], currentContext: "当前会话：未绑定" }
      const sessions = await this.controlClient.listSessions(directory)
      const branch = (await this.controlClient.getVcs(directory).catch((): { branch?: string } => ({}))).branch
        ?? mapping?.branch_name
        ?? "未知分支"
      const currentIndex = sessions.findIndex((session) => session.id === mapping?.session_id)
      if (currentIndex > 0) sessions.unshift(...sessions.splice(currentIndex, 1))
      const currentSession = sessions.find((session) => session.id === mapping?.session_id)
        ?? (mapping?.session_id ? await this.controlClient.getSession(mapping.session_id).catch(() => null) : null)
      const currentTitle = currentSession?.title?.trim() || mapping?.session_title?.trim() || "未命名会话"
      const currentProject = mapping?.project_name
        ?? basename(currentSession?.directory)
        ?? basename(directory)
        ?? "未知项目"
      const currentContext = mapping?.session_id
        ? `当前会话：\`${escapeCode(currentTitle)}\` · \`${escapeCode(mapping.session_id)}\` · \`${escapeCode(`${currentProject}#${branch}`)}\``
        : "当前会话：未绑定"
      return { items: sessions.map((session) => ({
        label: `${session.id === mapping?.session_id ? "▶ " : ""}${session.title?.trim() || "未命名会话"} · ${session.time?.updated ? relativeTime(session.time.updated) : "未知时间"} · ${session.summary?.files ?? 0}文件`,
        detail: `${escapeMarkdown(session.id)} · ${escapeMarkdown(basename(session.directory) ?? session.directory ?? "未知项目")}#${escapeMarkdown(branch)}`,
        value: session.id,
        session,
      })), currentContext }
    }
    if (kind === "agents") {
      const agents = await this.controlClient.listAgents(directory).catch((): AgentOption[] => [])
      if (mapping?.agent && !agents.some((agent) => agent.id === mapping.agent)) agents.unshift({ id: mapping.agent, label: mapping.agent })
      return { items: agents.map((agent) => ({
        label: `${agent.id === mapping?.agent ? "▶ " : ""}${agent.id}`,
        value: agent.id,
      })), currentContext: currentContext(kind, mapping) }
    }
    const models = await this.controlClient.listModels(directory).catch((): ModelOption[] => [])
    const current = mapping?.provider_id && mapping.model_id ? `${mapping.provider_id}:${mapping.model_id}` : undefined
    if (current && !models.some((model) => model.value === current)) {
      models.unshift({ value: current, providerId: mapping!.provider_id!, modelId: mapping!.model_id!, label: `${mapping!.provider_id}/${mapping!.model_id}` })
    }
    return { items: models.map((model) => ({
      label: `${model.value === current ? "▶ " : ""}${model.providerId}/${model.modelId}`,
      value: model.value,
    })), currentContext: currentContext(kind, mapping) }
  }

  private async resolveDirectory(mapping: SessionMapping | null): Promise<string | undefined> {
    if (mapping?.directory) return mapping.directory
    if (!mapping?.session_id) return this.defaultDirectory
    const session = await this.controlClient.getSession(mapping.session_id).catch(() => null)
    if (session?.directory) {
      this.sessionManager.updateContext(mapping.feishu_key, {
        directory: session.directory,
        sessionTitle: session.title ?? null,
        projectName: basename(session.directory) ?? null,
      })
    }
    return session?.directory ?? this.defaultDirectory
  }

  private render(kind: SelectionPickerKind, allItems: Omit<PickerItem, "key">[], requestedPage: number, context: string): {
    card: Record<string, unknown>
    page: number
    viewToken: string
    items: Map<string, PickerItem>
  } {
    const pageCount = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE))
    const page = clamp(requestedPage, 0, pageCount - 1)
    const viewToken = token()
    const visible = allItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => ({ ...item, key: `${viewToken}:${index}` }))
    return {
      page,
      viewToken,
      items: new Map(visible.map((item) => [item.key, item])),
      card: pickerCard(kind, visible, page, pageCount, viewToken, context),
    }
  }

  private register(input: Omit<PickerState, "queue" | "timer">): void {
    this.unregister(input.messageId)
    const state: PickerState = {
      ...input,
      queue: Promise.resolve(),
      timer: setTimeout(() => this.unregister(input.messageId), this.ttlMs),
    }
    state.timer.unref?.()
    this.states.set(input.messageId, state)
  }

  private unregister(messageId: string): void {
    const state = this.states.get(messageId)
    if (!state) return
    clearTimeout(state.timer)
    this.states.delete(messageId)
  }

  private touch(state: PickerState): void {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => this.unregister(state.messageId), this.ttlMs)
    state.timer.unref?.()
  }

  private async updateMessage(messageId: string, card: Record<string, unknown>): Promise<void> {
    let lastError: unknown
    for (const delayMs of UPDATE_RETRY_DELAYS_MS) {
      if (delayMs) await delay(delayMs)
      try {
        await this.feishuClient.updateMessage(messageId, JSON.stringify(card))
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
}

function pickerCard(kind: SelectionPickerKind, items: PickerItem[], page: number, pageCount: number, viewToken: string, context: string): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: context },
    { tag: "hr" },
  ]
  if (items.length === 0) {
    elements.push({ tag: "markdown", content: kind === "models" ? "暂无可选模型。当前 OpenCode 未返回模型列表，请检查 provider 配置。" : "暂无可选项。" })
  } else {
    elements.push(...items.map((item) => row(item, viewToken)))
  }
  const actions = [
    ...(page > 0 ? [pageButton("上一页", viewToken, "previous")] : []),
    ...(page + 1 < pageCount ? [pageButton("下一页", viewToken, "next")] : []),
  ]
  if (actions.length > 0) elements.push({ tag: "hr" }, navigationRow(actions))
  elements.push(note(`第 ${page + 1}/${pageCount} 页`))
  return card(kind === "sessions" ? "📋 选择会话" : kind === "agents" ? "🤖 选择智能体" : "🧩 选择模型", elements)
}

function currentContext(kind: SelectionPickerKind, mapping: SessionMapping | null): string {
  if (kind === "sessions") {
    return mapping?.session_id ? `当前会话：\`${escapeCode(mapping.session_id)}\`` : "当前会话：未绑定"
  }
  if (kind === "agents") {
    return mapping?.agent ? `当前智能体：\`${escapeCode(mapping.agent)}\`` : "当前智能体：未指定"
  }
  return mapping?.provider_id && mapping.model_id
    ? `当前模型：\`${escapeCode(`${mapping.provider_id}/${mapping.model_id}`)}\``
    : "当前模型：未指定"
}

function row(item: PickerItem, viewToken: string): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    margin: "0px 0px 2px 0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [{
        tag: "button",
        type: "text",
        size: "medium",
        width: "fill",
        text: { tag: "plain_text", content: item.label },
        behaviors: [{ type: "callback", value: callbackValue("selection_picker_select", viewToken, { entryKey: item.key }) }],
      }, ...(item.detail ? [{ tag: "markdown", content: `<text_tag color='grey'>${item.detail}</text_tag>` }] : [])],
    }],
  }
}

function pageButton(label: string, viewToken: string, direction: string): Record<string, unknown> {
  return {
    tag: "button",
    type: "text",
    size: "small",
    text: { tag: "plain_text", content: label },
    behaviors: [{ type: "callback", value: callbackValue("selection_picker_page", viewToken, { direction }) }],
  }
}

function callbackValue(action: string, viewToken: string, extra: Record<string, string>): Record<string, string> {
  return { action, viewToken, actionId: `${viewToken}:${action}:${extra.entryKey ?? extra.direction}`, ...extra }
}

function navigationRow(actions: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "4px",
    columns: actions.map((action) => ({ tag: "column", width: "auto", elements: [action] })),
  }
}

function card(title: string, elements: Record<string, unknown>[], template = "blue"): Record<string, unknown> {
  return { schema: "2.0", config: { width_mode: "fill", update_multi: true }, header: { title: { tag: "plain_text", content: title }, template }, body: { elements } }
}

function selectedCard(kind: SelectionPickerKind, value: string): Record<string, unknown> {
  const label = kind === "sessions" ? "会话" : kind === "agents" ? "智能体" : "模型"
  return card(`已选择${label}`, [{ tag: "markdown", content: `已切换${label}：\`${escapeCode(value.replace(/^▶ /, ""))}\`，将在下一次消息生效。` }], "green")
}

function note(content: string): Record<string, unknown> {
  return { tag: "markdown", content: `<text_tag color='grey'>${content}</text_tag>` }
}

function toast(type: string, content: string): Record<string, unknown> {
  return { toast: { type, content } }
}

function relativeTime(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}小时前` : `${Math.floor(hours / 24)}天前`
}

function basename(path: string | null | undefined): string | undefined {
  return path?.split("/").filter(Boolean).at(-1)
}

function escapeCode(value: string): string {
  return value.replaceAll("`", "\\`")
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_~])/g, "\\$1")
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function token(): string {
  return randomBytes(12).toString("hex")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
