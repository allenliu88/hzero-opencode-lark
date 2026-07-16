import { randomBytes } from "node:crypto"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { FeishuCardAction } from "../types.js"
import {
  buildDirectoryCard,
  buildFileBrowserErrorCard,
  buildFileBrowserLoadingCard,
  buildFileCard,
} from "./file-browser-card.js"
import { isSensitivePath, joinBrowserPath, normalizeBrowserPath, parentBrowserPath } from "./path-policy.js"
import type { FileBrowserEntryAction, RemoteFileClient, RemoteFileEntry } from "./types.js"
import { RemoteFileError } from "./types.js"

const DIRECTORY_PAGE_SIZE = 8
const FILE_PAGE_LINES = 60
const DEFAULT_TTL_MS = 30 * 60 * 1000
const UPDATE_RETRY_DELAYS_MS = [0, 200, 600] as const

type BrowserView =
  | { type: "directory"; path: string; page: number }
  | {
      type: "file"
      path: string
      page: number
      returnPath: string
      returnPage: number
    }

type QueuedAction =
  | { type: "directory"; path: string; page: number; label: string }
  | {
      type: "file"
      path: string
      page: number
      returnPath: string
      returnPage: number
      label: string
    }

interface BrowserState {
  messageId: string
  chatId: string
  operatorOpenId: string
  sessionId: string
  directory: string
  view: BrowserView
  viewToken: string
  entries: Map<string, RemoteFileEntry>
  pendingActionIds: Set<string>
  queue: Promise<void>
  timer: ReturnType<typeof setTimeout>
}

export interface OpenFileBrowserOptions {
  chatId: string
  replyToMessageId: string
  operatorOpenId: string
  relativePath?: string
  sessionId: string
}

export interface FileBrowserActionResult {
  handled: boolean
  response?: Record<string, unknown>
}

export class FileBrowserRegistry {
  private readonly states = new Map<string, BrowserState>()

  constructor(
    private readonly remoteFileClient: RemoteFileClient,
    private readonly feishuClient: FeishuApiClient,
    private readonly logger: Logger,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  async open(options: OpenFileBrowserOptions): Promise<void> {
    const path = normalizeBrowserPath(options.relativePath ?? ".")
    if (isSensitivePath(path)) throw new Error("该路径不允许预览")
    const directory = await this.remoteFileClient.getSessionDirectory(options.sessionId)
    const rendered = await this.renderDirectory(options.sessionId, directory, path, 0)
    const result = await this.feishuClient.replyMessage(options.replyToMessageId, {
      msg_type: "interactive",
      content: JSON.stringify(rendered.card),
    })
    const messageId = result.data?.message_id
    if (typeof messageId !== "string" || !messageId) {
      throw new Error("飞书未返回文件浏览卡片消息 ID")
    }

    this.register({
      messageId,
      chatId: options.chatId,
      operatorOpenId: options.operatorOpenId,
      sessionId: options.sessionId,
      directory,
      view: { type: "directory", path, page: rendered.page },
      viewToken: rendered.viewToken,
      entries: rendered.entries,
      pendingActionIds: new Set(),
    })
    this.logger.info(`File browser opened for session ${options.sessionId}`)
  }

  enqueue(action: FeishuCardAction): FileBrowserActionResult {
    const actionType = action.action.value.action
    if (!actionType?.startsWith("file_browser_")) return { handled: false }

    const state = this.states.get(action.open_message_id)
    if (!state || state.chatId !== action.open_chat_id) {
      return { handled: true, response: toast("warning", "浏览会话已过期，请重新发送 /files") }
    }
    if (state.operatorOpenId !== action.operator.open_id) {
      this.logger.warn(`Rejected file browser action from unauthorized operator for ${state.messageId}`)
      return { handled: true, response: toast("warning", "只有文件浏览器创建者可以操作") }
    }

    const value = action.action.value
    const actionId = value.actionId
    if (actionId && state.pendingActionIds.has(actionId)) {
      return { handled: true, response: toast("info", "该操作正在处理中") }
    }
    if (!value.viewToken || value.viewToken !== state.viewToken) {
      return { handled: true, response: toast("warning", "目录已更新，请点击最新卡片") }
    }
    const queued = this.resolveAction(state, actionType, value)
    if (!queued) {
      return { handled: true, response: toast("warning", "该操作已失效，请点击最新卡片") }
    }

    if (!actionId) {
      return { handled: true, response: toast("warning", "该操作已失效，请点击最新卡片") }
    }

    state.pendingActionIds.add(actionId)
    state.viewToken = createToken()
    this.touch(state)
    state.queue = state.queue
      .catch(() => {})
      .then(() => this.runAction(state, queued))
      .catch((error) => this.handleActionError(state, error))
      .finally(() => state.pendingActionIds.delete(actionId))

    return { handled: true, response: toast("info", queued.label) }
  }

  unregister(messageId: string): void {
    const state = this.states.get(messageId)
    if (!state) return
    clearTimeout(state.timer)
    this.states.delete(messageId)
  }

  close(): void {
    for (const state of this.states.values()) clearTimeout(state.timer)
    this.states.clear()
  }

  private register(input: Omit<BrowserState, "queue" | "timer">): void {
    this.unregister(input.messageId)
    const state = {
      ...input,
      queue: Promise.resolve(),
      timer: setTimeout(() => this.unregister(input.messageId), this.ttlMs),
    }
    state.timer.unref?.()
    this.states.set(input.messageId, state)
  }

  private touch(state: BrowserState): void {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => this.unregister(state.messageId), this.ttlMs)
    state.timer.unref?.()
  }

  private resolveAction(
    state: BrowserState,
    actionType: string,
    value: Record<string, string>,
  ): QueuedAction | null {
    switch (actionType) {
      case "file_browser_open_entry": {
        if (state.view.type !== "directory") return null
        const entry = state.entries.get(value.entryKey ?? "")
        if (!entry) return null
        const path = joinBrowserPath(state.view.path, entry.name)
        if (entry.type === "directory") {
          return { type: "directory", path, page: 0, label: `正在打开目录 ${entry.name}` }
        }
        if (isSensitivePath(path)) return null
        return {
          type: "file",
          path,
          page: 0,
          returnPath: state.view.path,
          returnPage: state.view.page,
          label: `正在打开文件 ${entry.name}`,
        }
      }
      case "file_browser_parent":
        return state.view.type === "directory"
          ? { type: "directory", path: parentBrowserPath(state.view.path), page: 0, label: "正在返回上一级" }
          : null
      case "file_browser_root":
        return { type: "directory", path: ".", page: 0, label: "正在打开根目录" }
      case "file_browser_refresh":
        return state.view.type === "directory"
          ? { type: "directory", path: state.view.path, page: state.view.page, label: "正在刷新目录" }
          : { ...state.view, label: "正在刷新文件" }
      case "file_browser_page": {
        const delta = value.direction === "previous" ? -1 : value.direction === "next" ? 1 : 0
        if (!delta) return null
        return state.view.type === "directory"
          ? { type: "directory", path: state.view.path, page: state.view.page + delta, label: "正在切换目录页" }
          : { ...state.view, page: state.view.page + delta, label: "正在切换文件页" }
      }
      case "file_browser_back":
        return state.view.type === "file"
          ? { type: "directory", path: state.view.returnPath, page: state.view.returnPage, label: "正在返回目录" }
          : null
      default:
        return null
    }
  }

  private async runAction(state: BrowserState, action: QueuedAction): Promise<void> {
    await this.updateCard(
      state.messageId,
      buildFileBrowserLoadingCard(state.sessionId, action.path, action.label),
      false,
    )
    if (action.type === "directory") {
      await this.showDirectory(state, action.path, action.page)
    } else {
      await this.showFile(
        state,
        action.path,
        action.page,
        action.returnPath,
        action.returnPage,
      )
    }
  }

  private async showDirectory(state: BrowserState, path: string, page: number): Promise<void> {
    const rendered = await this.renderDirectory(state.sessionId, state.directory, path, page)
    await this.updateCard(state.messageId, rendered.card)
    state.view = { type: "directory", path, page: rendered.page }
    state.viewToken = rendered.viewToken
    state.entries = rendered.entries
  }

  private async renderDirectory(
    sessionId: string,
    directory: string,
    path: string,
    requestedPage: number,
  ): Promise<{
    card: Record<string, unknown>
    page: number
    viewToken: string
    entries: Map<string, RemoteFileEntry>
  }> {
    const allEntries = (await this.remoteFileClient.listDirectory(directory, path))
      .filter((entry) => !isSensitivePath(joinBrowserPath(path, entry.name)))
      .sort(compareEntries)
    const pageCount = Math.max(1, Math.ceil(allEntries.length / DIRECTORY_PAGE_SIZE))
    const page = clamp(requestedPage, 0, pageCount - 1)
    const viewToken = createToken()
    const visible = allEntries.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE)
    const actions: FileBrowserEntryAction[] = visible.map((entry, index) => ({
      key: `${viewToken}:${index}`,
      viewToken,
      entry,
    }))
    return {
      page,
      viewToken,
      entries: new Map(actions.map((item) => [item.key, item.entry])),
      card: buildDirectoryCard({ sessionId, path, page, pageCount, viewToken, entries: actions }),
    }
  }

  private async showFile(
    state: BrowserState,
    path: string,
    requestedPage: number,
    returnPath: string,
    returnPage: number,
  ): Promise<void> {
    const file = await this.remoteFileClient.readFile(state.directory, path)
    const lines = file.content === "" ? [] : file.content.split("\n")
    const pageCount = Math.max(1, Math.ceil(lines.length / FILE_PAGE_LINES))
    const page = clamp(requestedPage, 0, pageCount - 1)
    const startIndex = page * FILE_PAGE_LINES
    const viewToken = createToken()
    const card = buildFileCard({
      path,
      page,
      pageCount,
      startLine: lines.length === 0 ? 0 : startIndex + 1,
      endLine: Math.min(lines.length, startIndex + FILE_PAGE_LINES),
      totalLines: lines.length,
      content: lines.slice(startIndex, startIndex + FILE_PAGE_LINES).join("\n"),
      viewToken,
    })
    await this.updateCard(state.messageId, card)
    state.view = { type: "file", path, page, returnPath, returnPage }
    state.viewToken = viewToken
    state.entries = new Map()
  }

  private async handleActionError(state: BrowserState, error: unknown): Promise<void> {
    const message = userMessage(error)
    const viewToken = createToken()
    state.viewToken = viewToken
    this.logger.warn(`File browser action failed for ${state.messageId}: ${message}`)
    try {
      await this.updateCard(state.messageId, buildFileBrowserErrorCard(message, viewToken))
    } catch (updateError) {
      this.logger.warn(`Failed to update file browser error card: ${updateError}`)
    }
  }

  private async updateCard(
    messageId: string,
    card: Record<string, unknown>,
    throwOnFailure = true,
  ): Promise<void> {
    let lastError: unknown
    for (const delay of UPDATE_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const result = await this.feishuClient.updateMessage(messageId, JSON.stringify(card))
        if (!result || result.code === 0) return
        lastError = new Error(`Feishu card update failed: ${result.code}`)
      } catch (error) {
        lastError = error
      }
    }
    if (throwOnFailure) throw lastError ?? new Error("飞书卡片更新失败")
    this.logger.warn(`Loading state update failed for file browser ${messageId}: ${lastError}`)
  }
}

function compareEntries(a: RemoteFileEntry, b: RemoteFileEntry): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function createToken(): string {
  return randomBytes(8).toString("hex")
}

function toast(type: "info" | "warning", content: string): Record<string, unknown> {
  return { toast: { type, content } }
}

function userMessage(error: unknown): string {
  if (error instanceof RemoteFileError) {
    const messages: Record<RemoteFileError["code"], string> = {
      not_found: "文件或目录已不存在。",
      forbidden: "无权读取该路径。",
      binary: "该文件不支持文本预览。",
      too_large: "文件超过预览大小限制。",
      timeout: "OpenCode 文件请求超时。",
      invalid_response: "OpenCode 返回了无效的文件数据。",
      unavailable: "暂时无法访问 OpenCode 文件服务。",
    }
    return messages[error.code]
  }
  if (error instanceof Error && error.message.startsWith("该")) return error.message
  return "文件浏览操作失败，请重试。"
}
