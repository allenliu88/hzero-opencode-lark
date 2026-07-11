/**
 * Feima agent console card session.
 * Renders an execution timeline for one Feishu-triggered OpenCode request.
 */

import type {
  CardKitClient,
  CardElement,
  CardKitSchema,
  CardKitStreamingConfig,
} from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { QuestionAsked, PermissionRequested } from "./event-processor.js"

export interface AgentConsoleOptions {
  cardkitClient: CardKitClient
  feishuClient: FeishuApiClient
  chatId: string
  replyToMessageId?: string
  requestText?: string
}

export type AgentConsoleStatus =
  | "starting"
  | "running"
  | "waiting_question"
  | "waiting_permission"
  | "completed"
  | "error"

export type AgentConsoleToolState = "pending" | "running" | "completed" | "error"

export interface AgentConsoleToolEvent {
  partId?: string
  name: string
  state: AgentConsoleToolState
  title?: string
  input?: Record<string, unknown>
}

export interface AgentConsoleTaskEvent {
  partId: string
  description: string
  agent: string
  state: AgentConsoleToolState
  childSessionId?: string
}

export interface AgentConsoleCloseOptions {
  status?: "completed" | "error"
  reason?: string
  finalAnswer?: string
}

interface CardState {
  cardId: string
  messageId: string
  sequence: number
}

type AgentConsoleItemKind =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "bash"
  | "task"
  | "question"
  | "permission"
  | "selection"
  | "message"

type AgentConsoleItemStatus = "pending" | "running" | "done" | "error" | "waiting"

interface AgentConsoleItem {
  id: string
  kind: AgentConsoleItemKind
  status: AgentConsoleItemStatus
  label: string
  detail?: string
  toolName?: string
  interactionStartedAt?: number
  startedAt: number
  endedAt?: number
  task?: {
    description: string
    agent: string
    childSessionId?: string
  }
}

interface ChildViewState {
  sessionId: string
  title: string
  hasOutput: boolean
  status: "running" | "completed" | "error"
  items: AgentConsoleItem[]
  analysisStartedAt: number
  outputStartedAt?: number
  outputEndedAt?: number
}

interface AgentConsoleModel {
  status: AgentConsoleStatus
  items: AgentConsoleItem[]
  foldedCount: number
  analysisStartedAt: number
  errorReason?: string
}

const PROGRESS_ELEMENT_ID = "progress"
const ANSWER_ELEMENT_ID = "answer"
const INTERACTION_ELEMENT_ID = "interaction"
const NAVIGATION_ELEMENT_ID = "session_navigation"
const TASK_LINKS_ELEMENT_ID = "task_links"
export const ANSWER_ELEMENT_MAX_BYTES = 18 * 1024
const TIMELINE_VISIBLE_LIMIT = 5
const UPDATE_INTERVAL_MS = 300
const HEARTBEAT_INTERVAL_MS = 8 * 60 * 1_000
const HEARTBEAT_SKIP_IF_UPDATED_WITHIN_MS = 7 * 60 * 1_000

const STREAMING_CONFIG: CardKitStreamingConfig = {
  print_frequency_ms: { default: 70 },
  print_step: { default: 5 },
  print_strategy: "fast",
}

export class AgentConsoleSession {
  private readonly cardkitClient: CardKitClient
  private readonly feishuClient: FeishuApiClient
  private readonly chatId: string
  private readonly replyToMessageId?: string
  private readonly requestText?: string

  private state: CardState | null = null
  private startPromise: Promise<void> | null = null
  private status: AgentConsoleStatus = "starting"
  private items: AgentConsoleItem[] = []
  private closed = false
  private closing = false
  private updatePromise: Promise<void> | null = null
  private pendingContent = new Map<string, string>()
  private lastSentContent = new Map<string, string>()
  private lastUpdateStartedAt = 0
  private fallbackCounter = 0
  private elapsedTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastVisibleUpdateAt = 0
  private errorReason: string | undefined
  private answerStarted = false
  private answerText = ""
  private readonly analysisStartedAt = Date.now()
  private streamingPaused = false
  private interactionVisible = false
  private activeInteractionId: string | null = null
  private interactionMutation: Promise<void> = Promise.resolve()
  private selectedChildSessionId: string | null = null
  private readonly childViews = new Map<string, ChildViewState>()
  private navigationVisible = false
  private taskLinksVisible = false
  private navigationSignature = ""

  constructor(options: AgentConsoleOptions) {
    this.cardkitClient = options.cardkitClient
    this.feishuClient = options.feishuClient
    this.chatId = options.chatId
    this.replyToMessageId = options.replyToMessageId
    this.requestText = options.requestText
  }

  get isActive(): boolean {
    return this.state !== null && !this.closed
  }

  get cardMessageId(): string | undefined {
    return this.state?.messageId
  }

  get targetChatId(): string {
    return this.chatId
  }

  async start(): Promise<void> {
    if (this.state) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startOnce()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startOnce(): Promise<void> {
    const initialProgress = this.renderProgress()
    const cardJson: CardKitSchema = {
      schema: "2.0",
      header: {
        title: { tag: "plain_text", content: "🧠 飞码智能体" },
        template: "blue",
      },
      config: {
        streaming_mode: true,
        summary: { content: "飞码智能体执行中" },
        width_mode: "fill",
        streaming_config: STREAMING_CONFIG,
      },
      body: {
        elements: [
          { tag: "markdown", content: initialProgress, element_id: PROGRESS_ELEMENT_ID },
          { tag: "markdown", content: "", element_id: ANSWER_ELEMENT_ID },
        ],
      },
    }

    const cardId = await this.cardkitClient.createCard(cardJson)
    const cardMessage = {
      msg_type: "interactive" as const,
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
    }
    const result = this.replyToMessageId
      ? await this.feishuClient.replyMessage(this.replyToMessageId, cardMessage)
      : await this.feishuClient.sendMessage(this.chatId, cardMessage)

    const messageId = result.data?.["message_id"] as string | undefined
    if (!messageId) {
      throw new Error("sendMessage returned no message_id")
    }

    this.state = { cardId, messageId, sequence: 1 }
    this.lastSentContent.set(PROGRESS_ELEMENT_ID, initialProgress)
    this.lastSentContent.set(ANSWER_ELEMENT_ID, "")
    this.lastVisibleUpdateAt = Date.now()
    this.lastUpdateStartedAt = Date.now()
    this.startHeartbeat()
    this.syncElapsedTimer()
  }

  async setToolStatus(event: AgentConsoleToolEvent): Promise<void> {
    if (!this.state || this.closed || this.closing) return

    const state = normalizeToolState(event.state)
    this.status = state === "error" ? "error" : "running"
    const description = describeToolEvent(event.name, event.title, event.input)
    const id = event.partId ?? this.resolveFallbackId(event.name, event.title, state)
    const existing = this.items.find((item) => item.id === id)
    const now = Date.now()
    const isQuestionTool = event.name.toLowerCase() === "question"
    const isTerminal = state === "completed" || state === "error"

    if (existing) {
      existing.status = state === "completed" ? "done" : state
      existing.label = description.label
      existing.toolName = event.name
      if (isQuestionTool) existing.interactionStartedAt ??= now
      if (description.detail) existing.detail = description.detail
      if (isTerminal) existing.endedAt = now
    } else {
      this.items.push({
        id,
        kind: description.kind,
        status: state === "completed" ? "done" : state,
        label: description.label,
        detail: description.detail,
        toolName: event.name,
        ...(isQuestionTool ? { interactionStartedAt: now } : {}),
        startedAt: now,
        ...(isTerminal ? { endedAt: now } : {}),
      })
    }

    this.syncElapsedTimer()
    await this.updateProgress()
  }

  async addSubtask(description: string, agent?: string): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    this.status = "running"
    this.items.push({
      id: this.nextFallbackId("task", description),
      kind: "task",
      status: "running",
      label: agent ? `执行子任务 ${agent}` : "执行子任务",
      detail: truncate(description),
      startedAt: Date.now(),
    })
    this.syncElapsedTimer()
    await this.updateProgress()
  }

  async setTaskStatus(event: AgentConsoleTaskEvent): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    const now = Date.now()
    const state = normalizeToolState(event.state)
    const existing = this.items.find((item) => item.id === event.partId)
    const task = {
      description: event.description,
      agent: event.agent,
      ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    }
    if (existing) {
      existing.status = state === "completed" ? "done" : state
      existing.label = "执行子任务"
      existing.detail = `${event.description}@${event.agent}`
      existing.task = { ...existing.task, ...task }
      if (state === "completed" || state === "error") existing.endedAt = now
    } else {
      this.items.push({
        id: event.partId,
        kind: "task",
        status: state === "completed" ? "done" : state,
        label: "执行子任务",
        detail: `${event.description}@${event.agent}`,
        startedAt: now,
        ...(state === "completed" || state === "error" ? { endedAt: now } : {}),
        task,
      })
    }
    if (event.childSessionId && !this.childViews.has(event.childSessionId)) {
      this.childViews.set(event.childSessionId, {
        sessionId: event.childSessionId,
        title: `${event.description}@${event.agent}`,
        hasOutput: false,
        status: "running",
        items: [],
        analysisStartedAt: now,
      })
    }
    this.status = state === "error" ? "error" : "running"
    this.syncElapsedTimer()
    await this.updateProgress()
    await this.refreshNavigationElements()
  }

  async markChildOutput(sessionId: string): Promise<void> {
    const child = this.childViews.get(sessionId)
    if (!child || this.closed || this.closing) return
    child.hasOutput = true
    if (!hasActiveItems(child.items)) {
      child.outputStartedAt ??= Date.now()
      child.outputEndedAt = undefined
    }
    this.syncElapsedTimer()
    if (this.selectedChildSessionId === sessionId && !this.streamingPaused) {
      await this.updateViewContent(PROGRESS_ELEMENT_ID, renderChildProgress(child))
    }
  }

  async setChildStatus(sessionId: string, status: ChildViewState["status"]): Promise<void> {
    const child = this.childViews.get(sessionId)
    if (!child) return
    child.status = status
    if (status !== "running" && child.outputStartedAt) child.outputEndedAt ??= Date.now()
    this.syncElapsedTimer()
    if (this.selectedChildSessionId === sessionId) await this.updateSelectedChild(child)
    else await this.refreshNavigationElements()
  }

  async setChildToolStatus(sessionId: string, event: AgentConsoleToolEvent): Promise<void> {
    const child = this.childViews.get(sessionId)
    if (!child || this.closing) return
    const state = normalizeToolState(event.state)
    const id = event.partId ?? `${event.name}:${event.title ?? ""}`
    const description = describeToolEvent(event.name, event.title, event.input)
    const existing = child.items.find((item) => item.id === id)
    const now = Date.now()
    if (existing) {
      existing.status = state === "completed" ? "done" : state
      existing.label = description.label
      if (description.detail) existing.detail = description.detail
      if (state === "completed" || state === "error") existing.endedAt = now
    } else {
      child.items.push({
        id,
        kind: description.kind,
        status: state === "completed" ? "done" : state,
        label: description.label,
        detail: description.detail,
        startedAt: now,
        ...(state === "completed" || state === "error" ? { endedAt: now } : {}),
      })
    }
    if (state === "pending" || state === "running") {
      child.outputStartedAt = undefined
      child.outputEndedAt = undefined
    } else if (child.hasOutput && !hasActiveItems(child.items)) {
      child.outputStartedAt ??= now
    }
    this.syncElapsedTimer()
    if (this.selectedChildSessionId === sessionId) await this.updateSelectedChild(child)
  }

  async viewChild(sessionId: string): Promise<void> {
    const child = this.childViews.get(sessionId)
    if (!child || !this.state || this.closing) return
    await this.awaitPendingUpdates()
    this.selectedChildSessionId = sessionId
    await this.refreshNavigationElements()
    await this.updateSelectedChild(child)
  }

  async viewParent(): Promise<void> {
    if (!this.state || this.closing) return
    await this.awaitPendingUpdates()
    this.selectedChildSessionId = null
    await this.refreshNavigationElements()
    await this.updateViewContent(PROGRESS_ELEMENT_ID, this.renderProgress())
    await this.updateViewContent(ANSWER_ELEMENT_ID, this.answerText)
  }

  async setWaitingForQuestion(title: string, requestId: string): Promise<void> {
    await this.setWaiting("waiting_question", "question", requestId, "等待用户回答", title)
  }

  async setWaitingForPermission(title: string, requestId: string): Promise<void> {
    await this.setWaiting("waiting_permission", "permission", requestId, "等待权限确认", title)
  }

  async showQuestion(action: QuestionAsked): Promise<void> {
    const question = action.questions[0]
    if (!question) throw new Error("Question contains no prompts")
    this.activeInteractionId = `question:${action.requestId}`
    if (question.multiple) {
      await this.showInteraction([{
        tag: "form",
        element_id: INTERACTION_ELEMENT_ID,
        name: "question_form",
        direction: "vertical",
        vertical_spacing: "8px",
        elements: [
          { tag: "markdown", content: `**${question.header || "需要你的回答"}**\n${question.question}` },
          {
            tag: "column_set",
            flex_mode: "flow",
            horizontal_spacing: "8px",
            columns: [
              ...question.options.map((option, index) => ({
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "checker",
                  name: `question_choice_${index}`,
                  checked: false,
                  overall_checkable: true,
                  text: { tag: "plain_text", content: option.label },
                }],
              })),
            ],
          },
          {
            tag: "column_set",
            horizontal_align: "left",
            columns: [{
              tag: "column",
              width: "auto",
              elements: [{
                tag: "button",
                element_id: "question_submit",
                name: "question_submit",
                form_action_type: "submit",
                type: "primary",
                size: "medium",
                text: { tag: "plain_text", content: "✅ 确认选择" },
                behaviors: [{
                  type: "callback",
                  value: {
                    action: "question_answer",
                    requestId: action.requestId,
                    embedded: "true",
                    multiple: "true",
                    optionLabels: JSON.stringify(question.options.map((option) => option.label)),
                  },
                }],
              }],
            }],
          },
        ],
      }])
      return
    }
    await this.showInteraction([
      {
        tag: "column_set",
        element_id: INTERACTION_ELEMENT_ID,
        flex_mode: "flow",
        columns: [{
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            { tag: "markdown", content: `**${question.header || "需要你的回答"}**\n${question.question}` },
            {
              tag: "column_set",
              flex_mode: "flow",
              horizontal_spacing: "8px",
              columns: question.options.map((option, index) => ({
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  element_id: `question_btn_${index}`,
                  type: index === 0 ? "primary" : "default",
                  size: "small",
                  width: "fill",
                  text: { tag: "plain_text", content: option.label },
                  behaviors: [{
                    type: "callback",
                    value: {
                      action: "question_answer",
                      requestId: action.requestId,
                      answers: JSON.stringify([[option.label]]),
                      embedded: "true",
                    },
                  }],
                }],
              })),
            },
          ],
        }],
      },
    ])
  }

  async showPermission(action: PermissionRequested): Promise<void> {
    this.activeInteractionId = `permission:${action.requestId}`
    const choices = [
      ["仅允许本次", "once", "primary"],
      ["始终允许", "always", "default"],
      ["拒绝", "reject", "danger"],
    ] as const
    await this.showInteraction([{
      tag: "column_set",
      element_id: INTERACTION_ELEMENT_ID,
      flex_mode: "flow",
      columns: [{
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          { tag: "markdown", content: `**需要权限：${action.permissionType}**\n${action.title}` },
          {
            tag: "column_set",
            flex_mode: "flow",
            horizontal_spacing: "8px",
            columns: choices.map(([label, reply, type], index) => ({
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [{
                tag: "button",
                element_id: `permission_btn_${index}`,
                type,
                size: "small",
                width: "fill",
                text: { tag: "plain_text", content: label },
                behaviors: [{
                  type: "callback",
                  value: {
                    action: "permission_reply",
                    requestId: action.requestId,
                    reply,
                    embedded: "true",
                  },
                }],
              }],
            })),
          },
        ],
      }],
    }])
  }

  async resolveInteraction(selections?: readonly string[]): Promise<void> {
    await this.mutateInteraction(async () => {
      if (!this.state) return
      this.state.sequence += 1
      await this.cardkitClient.deleteElement(this.state.cardId, INTERACTION_ELEMENT_ID, this.state.sequence)
      this.interactionVisible = false
      this.state.sequence += 1
      await this.cardkitClient.renewStreaming(this.state.cardId, this.state.sequence, STREAMING_CONFIG)
      this.streamingPaused = false
      const waitingItem = this.items.find((item) => item.id === this.activeInteractionId)
      if (waitingItem) {
        if (selections && selections.length > 0) {
          waitingItem.status = "done"
          waitingItem.endedAt = Date.now()
          this.items.push({
            id: this.nextFallbackId("selection", this.activeInteractionId ?? undefined),
            kind: "selection",
            status: "done",
            label: `你选择的是：**${selections.map(escapeMarkdown).join("，")}**。`,
            startedAt: Date.now(),
            endedAt: Date.now(),
          })
        } else {
          this.items = this.items.filter((item) => item.id !== this.activeInteractionId)
        }
      }
      this.finishInteractionClock()
      this.activeInteractionId = null
      this.status = "running"
      this.syncElapsedTimer()
    })
    await this.updateProgress()
  }

  async markError(reason: string): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    this.status = "error"
    this.errorReason = reason
    this.stopElapsedTimer()
    await this.updateProgress()
  }

  async setAnswerText(text: string): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    this.answerStarted ||= text.length > 0
    this.syncElapsedTimer()
    this.answerText = truncateUtf8(text, ANSWER_ELEMENT_MAX_BYTES)
    if (this.selectedChildSessionId) return
    const elementId = this.items.length === 0 ? PROGRESS_ELEMENT_ID : ANSWER_ELEMENT_ID
    if (this.streamingPaused) return
    await this.enqueueUpdate(elementId, this.answerText)
  }

  async close(options: AgentConsoleCloseOptions = {}): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    this.closing = true
    this.stopHeartbeat()
    this.stopElapsedTimer()
    await this.interactionMutation.catch(() => {})
    if (this.interactionVisible) {
      try {
        this.state.sequence += 1
        await this.cardkitClient.deleteElement(this.state.cardId, INTERACTION_ELEMENT_ID, this.state.sequence)
      } catch {}
      this.interactionVisible = false
    }
    if (this.streamingPaused) {
      try {
        this.state.sequence += 1
        await this.cardkitClient.renewStreaming(this.state.cardId, this.state.sequence, STREAMING_CONFIG)
      } catch {}
      this.streamingPaused = false
    }
    try {
      await this.updatePromise
    } catch {
      // A failed intermediate update must not prevent the final close.
    }

    this.status = options.status ?? (this.status === "error" ? "error" : "completed")
    if (options.reason) this.errorReason = options.reason
    const finalAnswer = options.finalAnswer === undefined
      ? undefined
      : truncateUtf8(options.finalAnswer, ANSWER_ELEMENT_MAX_BYTES)
    if (finalAnswer !== undefined) {
      this.answerStarted ||= finalAnswer.length > 0
      this.answerText = finalAnswer
    }
    const finalProgress = this.renderProgress()
    try {
      this.pendingContent.clear()
      if (finalProgress !== this.lastSentContent.get(PROGRESS_ELEMENT_ID)) {
        await this.sendContent(PROGRESS_ELEMENT_ID, finalProgress)
      }
      if (this.items.length > 0 && finalAnswer !== undefined && finalAnswer !== this.lastSentContent.get(ANSWER_ELEMENT_ID)) {
        await this.sendContent(ANSWER_ELEMENT_ID, finalAnswer)
      }
    } finally {
      try {
        this.state.sequence += 1
        await this.cardkitClient.closeStreaming(
          this.state.cardId,
          this.status === "error" ? "飞码智能体执行失败" : "飞码智能体已完成",
          this.state.sequence,
        )
      } finally {
        this.closed = true
        this.closing = false
      }
    }
  }

  private async setWaiting(
    status: "waiting_question" | "waiting_permission",
    kind: "question" | "permission",
    requestId: string,
    label: string,
    detail: string,
  ): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    this.status = status
    this.activeInteractionId = `${kind}:${requestId}`
    const now = Date.now()
    if (kind === "question") {
      const questionTool = [...this.items]
        .reverse()
        .find((item) => item.toolName?.toLowerCase() === "question")
      if (questionTool) questionTool.interactionStartedAt ??= now
    }
    const existing = this.items.find((item) => item.id === `${kind}:${requestId}`)
    if (existing) {
      existing.status = "waiting"
      existing.detail = truncate(detail)
      existing.interactionStartedAt = now
    } else {
      this.items.push({
        id: `${kind}:${requestId}`,
        kind,
        status: "waiting",
        label,
        detail: truncate(detail),
        interactionStartedAt: now,
        startedAt: now,
      })
    }
    this.syncElapsedTimer()
    await this.updateProgress()
  }

  private finishInteractionClock(): void {
    const now = Date.now()
    for (const item of this.items) {
      if (!item.interactionStartedAt) continue
      item.interactionStartedAt = undefined
      item.endedAt = now
    }
  }

  private async updateProgress(): Promise<void> {
    await this.interactionMutation
    if (this.streamingPaused) return
    if (this.selectedChildSessionId) return
    if (this.items.length > 0 && this.answerStarted) {
      await this.enqueueUpdate(ANSWER_ELEMENT_ID, this.answerText)
    }
    await this.enqueueUpdate(PROGRESS_ELEMENT_ID, this.renderProgress())
  }

  private async refreshNavigationElements(): Promise<void> {
    await this.mutateInteraction(async () => {
      if (!this.state || this.closing) return
      const selected = this.selectedChildSessionId
      const taskItems = this.items.filter((item) => {
        const childSessionId = item.task?.childSessionId
        if (!childSessionId || item.status === "done" || item.status === "error") return false
        return this.childViews.get(childSessionId)?.status === "running"
      })
      const signature = selected
        ? `child:${selected}`
        : `parent:${taskItems.map((item) => item.id).join(",")}`
      if (signature === this.navigationSignature) return
      if (this.navigationVisible) {
        this.state.sequence += 1
        await this.cardkitClient.deleteElement(this.state.cardId, NAVIGATION_ELEMENT_ID, this.state.sequence)
        this.navigationVisible = false
      }
      if (this.taskLinksVisible) {
        this.state.sequence += 1
        await this.cardkitClient.deleteElement(this.state.cardId, TASK_LINKS_ELEMENT_ID, this.state.sequence)
        this.taskLinksVisible = false
      }
      if (selected) {
        const child = this.childViews.get(selected)
        if (!child) return
        this.state.sequence += 1
        await this.cardkitClient.insertElements(this.state.cardId, [buildChildNavigation(child)], this.state.sequence)
        this.navigationVisible = true
      } else if (taskItems.length > 0) {
        this.state.sequence += 1
        await this.cardkitClient.insertElements(
          this.state.cardId,
          [buildTaskLinks(taskItems)],
          this.state.sequence,
          PROGRESS_ELEMENT_ID,
        )
        this.taskLinksVisible = true
      }
      this.navigationSignature = signature
    })
  }

  private async updateSelectedChild(child: ChildViewState): Promise<void> {
    await this.updateViewContent(PROGRESS_ELEMENT_ID, renderChildProgress(child))
    await this.updateViewContent(ANSWER_ELEMENT_ID, "")
  }

  private async awaitPendingUpdates(): Promise<void> {
    try {
      await this.updatePromise
    } catch {
      // A failed stale-view update must not block navigation.
    }
    await this.interactionMutation
  }

  private async updateViewContent(elementId: string, content: string): Promise<void> {
    if (this.closed) {
      await this.sendContent(elementId, content)
      return
    }
    await this.enqueueUpdate(elementId, content)
  }

  private async showInteraction(elements: CardElement[]): Promise<void> {
    await this.mutateInteraction(async () => {
      if (!this.state || this.closed || this.closing) return
      try {
        this.state.sequence += 1
        await this.cardkitClient.pauseStreaming(this.state.cardId, "等待用户操作", this.state.sequence)
        this.streamingPaused = true
        this.state.sequence += 1
        await this.cardkitClient.insertElements(
          this.state.cardId,
          elements,
          this.state.sequence,
          ANSWER_ELEMENT_ID,
        )
        this.interactionVisible = true
      } catch (err) {
        if (this.streamingPaused) {
          this.state.sequence += 1
          await this.cardkitClient.renewStreaming(this.state.cardId, this.state.sequence, STREAMING_CONFIG)
          this.streamingPaused = false
        }
        this.activeInteractionId = null
        throw err
      }
    })
  }

  private async mutateInteraction(operation: () => Promise<void>): Promise<void> {
    const mutation = this.interactionMutation.then(operation)
    this.interactionMutation = mutation.catch(() => {})
    await mutation
  }

  private async enqueueUpdate(elementId: string, content: string): Promise<void> {
    if (content === this.lastSentContent.get(elementId) && !this.pendingContent.has(elementId)) return

    this.pendingContent.set(elementId, content)
    if (!this.updatePromise) {
      this.updatePromise = this.drainUpdates().finally(() => {
        this.updatePromise = null
      })
    }
    await this.updatePromise
    if (this.pendingContent.size > 0 && !this.updatePromise) {
      await this.enqueueUpdate(elementId, this.pendingContent.get(elementId) ?? content)
    }
  }

  private async drainUpdates(): Promise<void> {
    let firstError: unknown
    while (this.pendingContent.size > 0 && !this.closed && !this.closing) {
      const delayMs = Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - this.lastUpdateStartedAt))
      if (delayMs > 0) await delay(delayMs)
      if (this.closed || this.closing) break

      const updates = [...this.pendingContent.entries()]
      this.pendingContent.clear()
      for (const [elementId, content] of updates) {
        if (content === this.lastSentContent.get(elementId)) continue
        try {
          await this.sendContent(elementId, content)
        } catch (err) {
          firstError ??= err
        }
      }
    }
    if (firstError) throw firstError
  }

  private async sendContent(elementId: string, content: string): Promise<void> {
    if (!this.state) return
    await this.mutateInteraction(async () => {
      if (!this.state) return
      this.lastUpdateStartedAt = Date.now()
      this.state.sequence += 1
      await this.cardkitClient.updateElement(
        this.state.cardId,
        elementId,
        content,
        this.state.sequence,
      )
      this.lastSentContent.set(elementId, content)
      this.lastVisibleUpdateAt = Date.now()
    })
  }

  private renderProgress(): string {
    if (this.answerStarted && this.items.length === 0 && this.status !== "error") {
      return this.answerText
    }
    const visibleItems = this.items.slice(-TIMELINE_VISIBLE_LIMIT)
    const foldedCount = Math.max(0, this.items.length - visibleItems.length)
    return renderAgentConsole({
      status: this.status,
      items: visibleItems,
      foldedCount,
      analysisStartedAt: this.analysisStartedAt,
      errorReason: this.errorReason,
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      this.renewStreamingIfNeeded().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async renewStreamingIfNeeded(): Promise<void> {
    if (!this.state || this.closed || this.closing) return
    if (!["starting", "running", "waiting_question", "waiting_permission"].includes(this.status)) return
    if (Date.now() - this.lastVisibleUpdateAt < HEARTBEAT_SKIP_IF_UPDATED_WITHIN_MS) return
    await this.mutateInteraction(async () => {
      if (!this.state || this.closed || this.closing) return
      this.state.sequence += 1
      await this.cardkitClient.renewStreaming(
        this.state.cardId,
        this.state.sequence,
        STREAMING_CONFIG,
      )
    })
  }

  private syncElapsedTimer(): void {
    const selectedChild = this.selectedChildSessionId
      ? this.childViews.get(this.selectedChildSessionId)
      : undefined
    const visibleItems = selectedChild?.items ?? this.items
    const hasTimedItem = hasActiveItems(visibleItems)
      || Boolean(selectedChild?.status === "running" && selectedChild.outputStartedAt)
    const isAnalyzing = !selectedChild && this.items.length === 0 && !this.answerStarted && this.status === "starting"
    if (!hasTimedItem && !isAnalyzing) {
      this.stopElapsedTimer()
      return
    }
    if (this.elapsedTimer) return
    this.scheduleElapsedTick()
  }

  private scheduleElapsedTick(): void {
    const selectedChild = this.selectedChildSessionId
      ? this.childViews.get(this.selectedChildSessionId)
      : undefined
    const visibleItems = selectedChild?.items ?? this.items
    const activeItems = visibleItems.filter((item) => item.status === "running" || item.status === "waiting")
    const isOutputting = Boolean(selectedChild?.status === "running" && selectedChild.outputStartedAt)
    const isAnalyzing = !selectedChild && this.items.length === 0 && !this.answerStarted && this.status === "starting"
    if ((activeItems.length === 0 && !isAnalyzing && !isOutputting) || this.closing) {
      this.stopElapsedTimer()
      return
    }
    const elapsedValues = activeItems.map((item) => Date.now() - item.startedAt)
    if (isOutputting) elapsedValues.push(Date.now() - selectedChild!.outputStartedAt!)
    if (isAnalyzing) elapsedValues.push(Date.now() - this.analysisStartedAt)
    const shortestElapsed = Math.min(...elapsedValues)
    this.elapsedTimer = setTimeout(() => {
      this.elapsedTimer = null
      if (this.closing) return
      if (this.selectedChildSessionId) {
        const child = this.childViews.get(this.selectedChildSessionId)
        if (child) this.updateSelectedChild(child).catch(() => {})
      } else {
        this.updateProgress().catch(() => {})
      }
      this.scheduleElapsedTick()
    }, elapsedRefreshInterval(shortestElapsed))
    this.elapsedTimer.unref?.()
  }

  private stopElapsedTimer(): void {
    if (!this.elapsedTimer) return
    clearTimeout(this.elapsedTimer)
    this.elapsedTimer = null
  }

  private nextFallbackId(toolName: string, title?: string): string {
    this.fallbackCounter += 1
    return `${toolName}:${title ?? ""}:${this.fallbackCounter}`
  }

  private resolveFallbackId(
    toolName: string,
    title: string | undefined,
    state: AgentConsoleToolState,
  ): string {
    if (state !== "running") {
      const prefix = `${toolName}:${title ?? ""}:`
      const running = [...this.items]
        .reverse()
        .find((item) => item.status === "running" && item.id.startsWith(prefix))
      if (running) return running.id
    }
    return this.nextFallbackId(toolName, title)
  }
}

function renderAgentConsole(model: AgentConsoleModel): string {
  const lines: string[] = []

  if (model.foldedCount > 0) {
    lines.push(`... 已折叠 ${model.foldedCount} 个早期步骤`)
  }

  if (model.items.length === 0) {
    lines.push(`正在分析请求... · 已用时 ${formatElapsed(Date.now() - model.analysisStartedAt, false)}`)
  } else {
    lines.push(...model.items.map(renderItem))
  }

  if (model.status === "waiting_permission") {
    lines.push("请在下方权限卡片中选择。")
  }
  if (model.status === "waiting_question") {
    lines.push("请在下方问题卡片中回复。")
  }
  if (model.status === "error") {
    lines.push(model.errorReason ? `异常原因：${truncate(model.errorReason, 240)}` : "执行遇到异常。")
  }

  return lines.join("\n")
}

function renderItem(item: AgentConsoleItem): string {
  if (item.kind === "selection") return item.label
  const detail = item.detail ? ` ${item.detail}` : ""
  const elapsedMs = (item.endedAt ?? Date.now()) - item.startedAt
  if (item.interactionStartedAt) {
    const prefix = item.status === "waiting"
      ? `? ${item.label}${detail}`
      : item.status === "done"
        ? `✓ 已${item.label}${detail}`
        : item.status === "pending"
          ? `正在${item.label}${detail}`
        : `正在${item.label}${detail}`
    return `${prefix} · ${formatClock(item.interactionStartedAt)}`
  }
  if ((item.kind === "question" || item.kind === "permission") && item.status === "done") {
    return `? ${item.label}${detail} · 已等待 ${formatElapsed(elapsedMs, false)}`
  }
  switch (item.status) {
    case "running":
      return `正在${item.label}${detail} · 已用时 ${formatElapsed(elapsedMs, false)}`
    case "done":
      return `✓ 已${item.label}${detail} · 用时 ${formatElapsed(elapsedMs, true)}`
    case "error":
      return `! ${item.label}失败${detail} · 运行 ${formatElapsed(elapsedMs, true)}`
    case "waiting":
      return `? ${item.label}${detail} · 已等待 ${formatElapsed(elapsedMs, false)}`
    case "pending":
      return `○ 正在${item.label}${detail}`
  }
}

function buildTaskLinks(items: AgentConsoleItem[]): CardElement {
  return {
    tag: "column_set",
    element_id: TASK_LINKS_ELEMENT_ID,
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: items.slice(-TIMELINE_VISIBLE_LIMIT).map((item) => ({
      tag: "column",
      width: "auto",
      elements: [{
        tag: "button",
        type: "default",
        size: "small",
        text: { tag: "plain_text", content: `${item.task!.description}@${item.task!.agent}` },
        behaviors: [{
          type: "callback",
          value: {
            action: "agent_console_view_child",
            taskKey: item.id,
          },
        }],
      }],
    })),
  }
}

function buildChildNavigation(child: ChildViewState): CardElement {
  return {
    tag: "column_set",
    element_id: NAVIGATION_ELEMENT_ID,
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [{
          tag: "button",
          type: "default",
          size: "small",
          text: { tag: "plain_text", content: "← 返回" },
          behaviors: [{ type: "callback", value: { action: "agent_console_back" } }],
        }],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [{ tag: "markdown", content: `**${escapeMarkdown(child.title)}**` }],
      },
    ],
  }
}

function renderChildProgress(child: ChildViewState): string {
  const timeline = child.items.length === 0 && child.outputStartedAt
    ? ""
    : renderAgentConsole({
    status: child.status === "running" ? "running" : child.status === "error" ? "error" : "completed",
    items: child.items.slice(-TIMELINE_VISIBLE_LIMIT),
    foldedCount: Math.max(0, child.items.length - TIMELINE_VISIBLE_LIMIT),
    analysisStartedAt: child.analysisStartedAt,
    ...(child.status === "error" ? { errorReason: "子任务执行失败" } : {}),
    })
  if (!child.outputStartedAt || hasActiveItems(child.items) || !child.hasOutput) return timeline
  const elapsed = (child.outputEndedAt ?? Date.now()) - child.outputStartedAt
  const output = child.status === "running"
    ? `正在输出... · 已用时 ${formatElapsed(elapsed, false)}`
    : child.status === "completed"
      ? `✓ 已输出 · 用时 ${formatElapsed(elapsed, true)}`
      : `! 输出失败 · 运行 ${formatElapsed(elapsed, true)}`
  return timeline ? `${timeline}\n${output}` : output
}

function hasActiveItems(items: AgentConsoleItem[]): boolean {
  return items.some((item) => item.status === "pending" || item.status === "running" || item.status === "waiting")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function elapsedRefreshInterval(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1_000
  if (elapsedMs < 60_000) return 5_000
  if (elapsedMs < 10 * 60_000) return 30_000
  return 60_000
}

function formatElapsed(elapsedMs: number, precise: boolean): string {
  if (elapsedMs < 60_000) {
    const seconds = precise
      ? Math.max(0, Math.round(elapsedMs / 100) / 10)
      : Math.max(0, Math.floor(elapsedMs / 1_000))
    return `${seconds} 秒`
  }
  if (elapsedMs < 60 * 60_000) {
    const minutes = Math.floor(elapsedMs / 60_000)
    const seconds = Math.floor((elapsedMs % 60_000) / 1_000)
    return `${minutes} 分 ${seconds} 秒`
  }
  const hours = Math.floor(elapsedMs / (60 * 60_000))
  const minutes = Math.floor((elapsedMs % (60 * 60_000)) / 60_000)
  return `${hours} 小时 ${minutes} 分`
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":")
}

function statusText(status: AgentConsoleStatus): string {
  switch (status) {
    case "starting":
      return "启动中"
    case "running":
      return "执行中"
    case "waiting_permission":
      return "等待确认"
    case "waiting_question":
      return "等待回答"
    case "completed":
      return "已完成"
    case "error":
      return "执行异常"
  }
}

function normalizeToolState(state: AgentConsoleToolState): AgentConsoleToolState {
  return state
}

function describeToolEvent(
  toolName: string,
  title?: string,
  input?: Record<string, unknown>,
): { kind: AgentConsoleItemKind; label: string; detail?: string } {
  const normalized = toolName.toLowerCase().replace(/[-.]/g, "_")
  const inputDetail = extractInputDetail(input)
  const rawDetail = inputDetail ?? title ?? ""
  const detail = rawDetail ? truncate(rawDetail) : undefined

  if (["read", "read_file"].includes(normalized)) return { kind: "read", label: "读取", detail }
  if (["write", "write_file"].includes(normalized)) return { kind: "write", label: "写入", detail }
  if (["edit", "apply_patch"].includes(normalized)) return { kind: "edit", label: "修改", detail }
  if (["grep", "search", "glob", "find"].includes(normalized)) return { kind: "search", label: "搜索", detail }
  if (["bash", "shell"].includes(normalized)) return { kind: "bash", label: "执行命令", detail }
  if (normalized === "task") return { kind: "task", label: "执行子任务", detail }
  return { kind: "message", label: `执行 ${toolName}`, detail }
}

function extractInputDetail(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  for (const key of ["filePath", "path", "command", "pattern", "query", "cwd"]) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  for (const key of ["paths", "args"]) {
    const value = input[key]
    if (!Array.isArray(value)) continue
    const parts = value.filter((item): item is string => typeof item === "string" && item.length > 0)
    if (parts.length > 0) return parts.join(" ")
  }
  return undefined
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_`])/g, "\\$1")
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const suffix = "\n\n…(内容过长，已截断)"
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8")
  let result = ""
  let size = 0
  for (const char of value) {
    const charSize = Buffer.byteLength(char, "utf8")
    if (size + charSize > budget) break
    result += char
    size += charSize
  }
  return result + suffix
}
