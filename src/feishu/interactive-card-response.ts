import type { FeishuCardAction } from "../types.js"

export const PERMISSION_LABELS: Record<string, string> = {
  once: "Allowed (once)",
  always: "Always allowed",
  reject: "Rejected",
}

export function buildInteractiveCallbackResponse(
  action: FeishuCardAction,
): Record<string, unknown> {
  const actionType = action.action?.value?.action
  const value = action.action?.value ?? {}
  const embedded = value.embedded === "true"

  if (actionType === "question_answer") {
    let answerLabel = "(unknown)"
    try {
      const parsed = JSON.parse(value.answers ?? "[]") as string[][]
      answerLabel = parsed[0]?.join("，") || answerLabel
    } catch {}
    const formSelections = value.multiple === "true"
      ? parseCheckedSelections(action.action.form_value, value.optionLabels)
      : parseSelections(action.action.form_value?.question_choices)
    if (formSelections.length > 0) answerLabel = formSelections.join("，")

    return {
      toast: { type: "success", content: `Answered: ${answerLabel}` },
      ...(!embedded ? { card: {
        type: "raw",
        data: buildAnsweredQuestionCard(answerLabel),
      } } : {}),
    }
  }

  if (actionType === "permission_reply") {
    const reply = value.reply ?? "unknown"
    const label = PERMISSION_LABELS[reply] ?? reply
    const isRejected = reply === "reject"

    return {
      toast: {
        type: isRejected ? "warning" : "success",
        content: `${isRejected ? "❌" : "✅"} ${label}`,
      },
      ...(!embedded ? { card: {
        type: "raw",
        data: buildAnsweredPermissionCard(reply),
      } } : {}),
    }
  }

  if (actionType === "command_execute") {
    const command = value.command
    if (!command) return {}
    return {
      card: {
        type: "raw",
        data: buildCommandSelectedCard(command),
      },
    }
  }

  return {}
}

export function buildCommandSelectedCard(command: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚡ 命令菜单" },
      template: "blue",
    },
    elements: [{
      tag: "markdown",
      content: `已选择执行 **${commandDisplayName(command)}**。`,
    }],
  }
}

function commandDisplayName(command: string): string {
  if (command === "/new") return "新建会话"
  if (command === "/sessions") return "连接会话"
  if (command === "/abort") return "中止任务"
  if (command === "/test-loading") return "Loading 测试"
  if (command === "/test-loading-v2") return "Loading 2.0"
  if (command.startsWith("/connect ")) return "连接会话"
  return command
}

function parseSelections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0)
  }
  if (typeof value !== "string" || value.length === 0) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
    }
  } catch {}
  return [value]
}

function parseCheckedSelections(
  formValue: Record<string, unknown> | undefined,
  rawLabels: string | undefined,
): string[] {
  if (!formValue || !rawLabels) return []
  let labels: unknown
  try {
    labels = JSON.parse(rawLabels)
  } catch {
    return []
  }
  if (!Array.isArray(labels)) return []
  return labels.filter((label, index): label is string => {
    if (typeof label !== "string") return false
    const checked = formValue[`question_choice_${index}`]
    return checked === true
      || checked === 1
      || (typeof checked === "string" && ["true", "1", "on", "checked"].includes(checked.toLowerCase()))
  })
}

export function buildAnsweredQuestionCard(
  answerLabel?: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: answerLabel ? "✅ Question Answered" : "✅ Question Already Answered",
      },
      template: "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: answerLabel
            ? `**Answer:** ${answerLabel}`
            : "**Status:** Answered in opencode TUI.",
        },
      },
    ],
  }
}

export function buildAnsweredPermissionCard(
  reply?: string,
): Record<string, unknown> {
  const label = reply ? (PERMISSION_LABELS[reply] ?? reply) : undefined
  const isRejected = reply === "reject"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: label
          ? `${isRejected ? "❌" : "✅"} Permission: ${label}`
          : "✅ Permission Request Resolved",
      },
      template: label && isRejected ? "red" : "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: label
            ? `**Decision:** ${label}`
            : "**Status:** Already handled in opencode TUI.",
        },
      },
    ],
  }
}
