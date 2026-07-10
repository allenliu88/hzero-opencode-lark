/**
 * Interactive card action handler.
 * Handles question answers and permission replies from Feishu card button clicks,
 * forwarding responses back to the opencode server.
 *
 * Feedback to the user is handled by the card callback response (toast + card update)
 * in ws-client.ts — this module only handles the opencode POST.
 */

import type { Logger } from "../utils/logger.js"
import type { FeishuCardAction } from "../types.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { EmbeddedInteractionRegistry } from "../feishu/embedded-interaction-registry.js"

// ── Types ──

export interface InteractiveHandlerDeps {
  serverUrl: string
  logger: Logger
  feishuClient?: FeishuApiClient
  interactiveCardRegistry?: InteractiveCardRegistry
  embeddedInteractionRegistry?: EmbeddedInteractionRegistry
}

// ── Factory ──

export function createInteractiveHandler(deps: InteractiveHandlerDeps) {
  const { serverUrl, logger } = deps
  const resolvingRequests = new Set<string>()
  const resolvedRequests = new Set<string>()

  return async (action: FeishuCardAction): Promise<void> => {
    const actionValue = action.action?.value
    if (!actionValue) return

    const actionType = actionValue.action

    if (actionType === "question_answer") {
      await handleQuestionAnswer(actionValue, action.action.form_value, action.open_message_id)
      return
    }

    if (actionType === "permission_reply") {
      await handlePermissionReply(actionValue)
      return
    }
  }

  async function handleQuestionAnswer(
    value: Record<string, string>,
    formValue: Record<string, unknown> | undefined,
    messageId: string,
  ): Promise<void> {
    const { requestId, answers } = value
    if (!requestId || (!answers && !formValue)) {
      logger.warn("Missing requestId or answers in question_answer action")
      return
    }
    if (resolvingRequests.has(requestId) || resolvedRequests.has(requestId)) {
      logger.info(`Ignoring duplicate question answer for ${requestId}`)
      return
    }

    let parsedAnswers: string[][]
    if (answers) {
      try {
        parsedAnswers = JSON.parse(answers) as string[][]
      } catch {
        logger.warn(`Failed to parse question answers: ${answers}`)
        return
      }
    } else {
      const selections = value.multiple === "true"
        ? parseCheckedSelections(formValue, value.optionLabels)
        : parseFormSelections(formValue?.question_choices)
      if (selections.length === 0) {
        logger.warn("Missing question choices in form submission")
        return
      }
      parsedAnswers = [selections]
    }

    resolvingRequests.add(requestId)
    try {
      deps.interactiveCardRegistry?.markFeishuResolving("question", requestId)
      const resp = await fetch(`${serverUrl}/question/${requestId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: parsedAnswers }),
      })
      if (!resp.ok) {
        deps.interactiveCardRegistry?.clearFeishuResolving("question", requestId)
        logger.warn(`Question reply failed: ${resp.status} ${resp.statusText}`)
      } else {
        resolvedRequests.add(requestId)
        if (resolvedRequests.size > 1_000) resolvedRequests.clear()
        deps.interactiveCardRegistry?.untrack("question", requestId)
        const embedded = deps.embeddedInteractionRegistry?.get("question", requestId)
        if (embedded) {
          deps.embeddedInteractionRegistry?.untrack("question", requestId)
          try {
            await embedded.resolve(parsedAnswers.flat())
          } catch (err) {
            logger.warn(`Embedded question cleanup failed for ${requestId}: ${err}`)
          }
        } else {
          await recycleQuestionCard(messageId)
        }
        logger.info(`Question ${requestId} answered: ${parsedAnswers[0]?.[0] ?? ""}`)
      }
    } catch (err) {
      deps.interactiveCardRegistry?.clearFeishuResolving("question", requestId)
      logger.warn(`Question reply request failed: ${err}`)
    } finally {
      resolvingRequests.delete(requestId)
    }
  }

  async function recycleQuestionCard(messageId: string): Promise<void> {
    if (!messageId || !deps.feishuClient) return
    try {
      const response = await deps.feishuClient.deleteMessage(messageId)
      if (response.code !== 0) {
        logger.warn(`Question card recycle failed: ${response.code} ${response.msg}`)
      }
    } catch (err) {
      logger.warn(`Question card recycle request failed: ${err}`)
    }
  }

  async function handlePermissionReply(
    value: Record<string, string>,
  ): Promise<void> {
    const { requestId, reply } = value
    if (!requestId || !reply) {
      logger.warn("Missing requestId or reply in permission_reply action")
      return
    }

    try {
      deps.interactiveCardRegistry?.markFeishuResolving("permission", requestId)
      const resp = await fetch(`${serverUrl}/permission/${requestId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply }),
      })
      if (!resp.ok) {
        deps.interactiveCardRegistry?.clearFeishuResolving("permission", requestId)
        logger.warn(`Permission reply failed: ${resp.status} ${resp.statusText}`)
      } else {
        deps.interactiveCardRegistry?.untrack("permission", requestId)
        const labelMap: Record<string, string> = {
          once: "Allowed (once)",
          always: "Always allowed",
          reject: "Rejected",
        }
        const embedded = deps.embeddedInteractionRegistry?.get("permission", requestId)
        if (embedded) {
          const selection = reply === "reject"
            ? "拒绝"
            : reply === "always" ? "始终允许" : "仅允许本次"
          await embedded.resolve([selection])
          deps.embeddedInteractionRegistry?.untrack("permission", requestId)
        }
        logger.info(`Permission ${requestId}: ${labelMap[reply] ?? reply}`)
      }
    } catch (err) {
      deps.interactiveCardRegistry?.clearFeishuResolving("permission", requestId)
      logger.warn(`Permission reply request failed: ${err}`)
    }
  }
}

function parseFormSelections(value: unknown): string[] {
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
  return labels.filter((label, index): label is string => (
    typeof label === "string" && isChecked(formValue[`question_choice_${index}`])
  ))
}

function isChecked(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (typeof value !== "string") return false
  return ["true", "1", "on", "checked"].includes(value.toLowerCase())
}
