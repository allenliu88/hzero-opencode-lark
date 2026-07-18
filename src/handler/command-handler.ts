/**
 * Slash command handler for Feishu → opencode bridge.
 *
 * Intercepts messages starting with "/" and routes them to
 * the appropriate opencode API endpoint instead of sending
 * them as plain text to the AI agent.
 */

import type { SessionManager } from "../session/session-manager.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { FileBrowserRegistry } from "../file-browser/file-browser-registry.js"
import type { OpencodeControlClient } from "../opencode/control-client.js"
import type { SelectionPickerRegistry } from "../selection-picker/selection-picker-registry.js"

// ── Dependency injection interface ──

export interface CommandHandlerDeps {
  serverUrl: string
  sessionManager: SessionManager
  feishuClient: FeishuApiClient
  logger: Logger
  fileBrowserRegistry?: FileBrowserRegistry
  opencodeControlClient?: OpencodeControlClient
  selectionPickerRegistry?: SelectionPickerRegistry
}

// ── Types ──

export type CommandHandler = (
  feishuKey: string,
  chatId: string,
  messageId: string,
  commandText: string,
  senderOpenId?: string,
) => Promise<boolean>

interface Session {
  id: string
  title?: string
  directory?: string
}

// ── Card builders ──

// ── Help card builder ──

function buildHelpCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "⚡ 命令菜单",
      },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: "**选择要执行的命令：**",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🆕 新建会话" },
            type: "primary",
            value: { action: "command_execute", command: "/new" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔌 连接会话" },
            value: { action: "command_execute", command: "/sessions" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🤖 切换智能体" },
            value: { action: "command_execute", command: "/agents" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🧩 切换模型" },
            value: { action: "command_execute", command: "/models" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🛑 中止任务" },
            type: "danger",
            value: { action: "command_execute", command: "/abort" },
          },
        ],
      },
    ],
  }
}

function buildLoadingTestCard(): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "工具执行中，请稍候",
      },
      template: "yellow",
    },
    elements: [
      {
        tag: "div",
        loading: true,
        text: {
          tag: "plain_text",
          content: "正在调用外部工具处理数据，请勿关闭卡片\n执行耗时约 5~20 秒",
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "提示：若长时间无响应可重新发起任务",
          },
        ],
      },
    ],
  }
}

function buildLoadingTestV2Card(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "工具执行中，请稍候（2.0）",
      },
      template: "yellow",
    },
    body: {
      elements: [
        {
          tag: "div",
          element_id: "loading_div",
          loading: true,
          text: {
            tag: "plain_text",
            element_id: "loading_text",
            content: "正在调用外部工具处理数据，请勿关闭卡片\n执行耗时约 5~20 秒",
          },
        },
        {
          tag: "div",
          element_id: "loading_note",
          text: {
            tag: "plain_text",
            content: "提示：若长时间无响应可重新发起任务",
            text_size: "notation",
            text_color: "secondary",
          },
        },
      ],
    },
  }
}

// ── Factory ──

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const { serverUrl, sessionManager, feishuClient, logger } = deps

  async function replyText(
    _chatId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await feishuClient.replyMessage(messageId, {
      msg_type: "text",
      content: JSON.stringify({ text }),
    })
  }

  async function handleNew(
    feishuKey: string,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    const resp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Feishu chat ${feishuKey}` }),
    })

    if (!resp.ok) {
      throw new Error(`Failed to create session: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { id: string }
    sessionManager.deleteMapping(feishuKey)
    sessionManager.setMapping(feishuKey, data.id, undefined, { sessionTitle: `Feishu chat ${feishuKey}` })
    logger.info(`/new: created session ${data.id}, bound ${feishuKey}`)
    await replyText(chatId, messageId, `已创建并切换到新会话: ${data.id}`)
  }

  async function handleAbort(
    feishuKey: string,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }

    const resp = await fetch(
      `${serverUrl}/session/${mapping.session_id}/abort`,
      { method: "POST" },
    )

    if (!resp.ok) {
      throw new Error(`Abort failed: HTTP ${resp.status}`)
    }

    logger.info(`/abort: aborted session ${mapping.session_id}`)
    await replyText(chatId, messageId, `已中止会话: ${mapping.session_id}`)
  }

  async function handleSessions(
    feishuKey: string,
    chatId: string,
    messageId: string,
    senderOpenId?: string,
  ): Promise<void> {
    await openSelectionPicker("sessions", feishuKey, chatId, messageId, senderOpenId)
  }

  async function handleAgents(
    feishuKey: string,
    chatId: string,
    messageId: string,
    senderOpenId?: string,
  ): Promise<void> {
    await openSelectionPicker("agents", feishuKey, chatId, messageId, senderOpenId)
  }

  async function handleModels(
    feishuKey: string,
    chatId: string,
    messageId: string,
    senderOpenId?: string,
  ): Promise<void> {
    await openSelectionPicker("models", feishuKey, chatId, messageId, senderOpenId)
  }

  async function openSelectionPicker(
    kind: "sessions" | "agents" | "models",
    feishuKey: string,
    chatId: string,
    messageId: string,
    senderOpenId?: string,
  ): Promise<void> {
    if (!deps.selectionPickerRegistry) throw new Error("当前版本未启用选择器")
    if (!senderOpenId) {
      await replyText(chatId, messageId, "无法确认操作用户，不能打开选择器。")
      return
    }
    await deps.selectionPickerRegistry.open({ kind, feishuKey, chatId, replyToMessageId: messageId, operatorOpenId: senderOpenId })
  }

  async function handleAgentSelect(feishuKey: string, chatId: string, messageId: string, agentId: string): Promise<void> {
    if (!agentId) {
      await replyText(chatId, messageId, "用法: /agent {agent}")
      return
    }
    if (!sessionManager.updateContext(feishuKey, { agent: agentId })) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }
    await replyText(chatId, messageId, `已切换智能体: ${agentId}`)
  }

  async function handleModelSelect(feishuKey: string, chatId: string, messageId: string, modelValue: string): Promise<void> {
    const separator = modelValue.indexOf(":")
    if (separator <= 0 || separator === modelValue.length - 1) {
      await replyText(chatId, messageId, "用法: /model {provider}:{model}")
      return
    }
    const providerId = modelValue.slice(0, separator)
    const modelId = modelValue.slice(separator + 1)
    if (!sessionManager.updateContext(feishuKey, { providerId, modelId })) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }
    await replyText(chatId, messageId, `已切换模型: ${providerId}/${modelId}`)
  }

  async function handleConnect(
    feishuKey: string,
    chatId: string,
    messageId: string,
    targetSessionId: string,
  ): Promise<void> {
    // Validate session exists
    const checkResp = await fetch(`${serverUrl}/session/${targetSessionId}`)
    if (!checkResp.ok) {
      await replyText(chatId, messageId, "会话不存在。")
      return
    }
    const sessionInfo = typeof checkResp.json === "function"
      ? await checkResp.json().catch(() => null) as Session | null
      : null
    const branch = sessionInfo?.directory
      ? (await deps.opencodeControlClient?.getVcs(sessionInfo.directory).catch((): { branch?: string } => ({})))?.branch
      : undefined

    // Unbind current mapping if exists
    sessionManager.deleteMapping(feishuKey)

    // Set new mapping
    const success = sessionManager.setMapping(feishuKey, targetSessionId, undefined, {
      sessionTitle: sessionInfo?.title ?? null,
      directory: sessionInfo?.directory ?? null,
      projectName: projectNameFromDirectory(sessionInfo?.directory),
      branchName: branch ?? null,
    })
    if (success) {
      logger.info(`/connect: bound ${feishuKey} to session ${targetSessionId}`)
      await replyText(chatId, messageId, `已连接到会话: ${targetSessionId}`)
    } else {
      throw new Error("Failed to set session mapping")
    }
  }

  async function handleHelp(
    _chatId: string,
    messageId: string,
  ): Promise<void> {
    const card = buildHelpCard()
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
  }

  async function handleFiles(
    feishuKey: string,
    chatId: string,
    messageId: string,
    senderOpenId: string | undefined,
    relativePath: string | undefined,
  ): Promise<void> {
    if (!deps.fileBrowserRegistry) {
      await replyText(chatId, messageId, "当前版本未启用远程文件浏览。")
      return
    }
    const sessionId = await sessionManager.getExisting(feishuKey)
    if (!sessionId) {
      await replyText(chatId, messageId, "当前话题尚未连接 OpenCode 会话，请先使用 /sessions 选择会话。")
      return
    }
    if (!senderOpenId) {
      await replyText(chatId, messageId, "无法确认操作用户，不能打开文件浏览器。")
      return
    }
    await deps.fileBrowserRegistry.open({
      chatId,
      replyToMessageId: messageId,
      operatorOpenId: senderOpenId,
      relativePath,
      sessionId,
    })
  }

  async function handleTestLoading(messageId: string): Promise<void> {
    const card = buildLoadingTestCard()
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
  }

  async function handleTestLoadingV2(messageId: string): Promise<void> {
    const card = buildLoadingTestV2Card()
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
  }

  return async function handleCommand(
    feishuKey: string,
    chatId: string,
    messageId: string,
    commandText: string,
    senderOpenId?: string,
  ): Promise<boolean> {
    const trimmed = commandText.trim()
    const parts = trimmed.split(/\s+/)
    const cmd = parts[0]?.toLowerCase()

    if (!cmd || !cmd.startsWith("/")) return false

    logger.info(`Slash command: ${cmd} from ${feishuKey}`)

    try {
      switch (cmd) {
        case "/new":
          await handleNew(feishuKey, chatId, messageId)
          return true

        case "/abort":
          await handleAbort(feishuKey, chatId, messageId)
          return true

        case "/sessions":
          await handleSessions(feishuKey, chatId, messageId, senderOpenId)
          return true

        case "/agents":
          await handleAgents(feishuKey, chatId, messageId, senderOpenId)
          return true

        case "/models":
          await handleModels(feishuKey, chatId, messageId, senderOpenId)
          return true

        case "/agent":
          await handleAgentSelect(feishuKey, chatId, messageId, parts[1] ?? "")
          return true

        case "/model":
          await handleModelSelect(feishuKey, chatId, messageId, parts[1] ?? "")
          return true

        case "/files":
          await handleFiles(feishuKey, chatId, messageId, senderOpenId, parts.slice(1).join(" ") || undefined)
          return true

        case "/connect": {
          const targetSessionId = parts[1]
          if (!targetSessionId) {
            await replyText(chatId, messageId, "用法: /connect {session_id}")
            return true
          }
          await handleConnect(feishuKey, chatId, messageId, targetSessionId)
          return true
        }

        case "/":
        case "/help":
          await handleHelp(chatId, messageId)
          return true

        case "/test-loading":
        case "/loading-test":
          await handleTestLoading(messageId)
          return true

        case "/test-loading-v2":
        case "/loading-test-v2":
          await handleTestLoadingV2(messageId)
          return true

        default:
          return false
      }
    } catch (err) {
      logger.error(`Command ${cmd} failed: ${err}`)
      try {
        await replyText(chatId, messageId, `命令执行失败: ${err}`)
      } catch (replyErr) {
        logger.error(`Failed to send error reply: ${replyErr}`)
      }
      return true
    }
  }
}

function projectNameFromDirectory(directory: string | undefined | null): string | null {
  if (!directory) return null
  return directory.split("/").filter(Boolean).at(-1) ?? directory
}
