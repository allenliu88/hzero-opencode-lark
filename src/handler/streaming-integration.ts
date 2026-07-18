
import type { CardKitClient } from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import { AgentConsoleSession, ANSWER_ELEMENT_MAX_BYTES } from "../streaming/agent-console.js"
import type { AgentConsoleControls } from "../streaming/agent-console.js"
import type { OutboundMediaHandler } from "./outbound-media.js"
import type { ExpiringSet } from "../utils/expiring-set.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import type { EmbeddedInteractionRegistry } from "../feishu/embedded-interaction-registry.js"
import type { AgentConsoleRegistry } from "../streaming/agent-console-registry.js"
import type { SessionManager } from "../session/session-manager.js"
import type { OpencodeControlClient } from "../opencode/control-client.js"
import type { SelectionPickerRegistry } from "../selection-picker/selection-picker-registry.js"
import {
  extractFeishuMessageId,
  interactiveCardKey,
} from "../feishu/interactive-card-registry.js"

// ── Types ──

export interface StreamingBridgeDeps {
  serverUrl?: string
  cardkitClient: CardKitClient
  feishuClient: FeishuApiClient
  subAgentTracker: SubAgentTracker
  logger: Logger
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
  embeddedInteractionRegistry?: EmbeddedInteractionRegistry
  activeSessions?: Set<string>
  ownedSessions?: Set<string>
  agentConsoleRegistry?: AgentConsoleRegistry
  sessionManager?: SessionManager
  opencodeControlClient?: OpencodeControlClient
  selectionPickerRegistry?: SelectionPickerRegistry
  outboundMedia?: OutboundMediaHandler
  inactivityTimeoutMs?: number
  waitingInactivityTimeoutMs?: number
  maxLifetimeMs?: number
  cardCloseTimeoutMs?: number
  cardCreationDelayMs?: number
}

export interface StreamingBridge {
  handleMessage(
    chatId: string,
    sessionId: string,
    eventListeners: EventListenerMap,
    eventProcessor: EventProcessor,
    sendMessage: () => Promise<string>,
    onComplete: (text: string) => void,
    messageId: string,
    reactionId: string | null,
    requestText?: string,
    feishuKey?: string,
  ): Promise<void>
}

export class SessionBusyError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} is busy`)
    this.name = "SessionBusyError"
  }
}

// ── Constants ──


const FIRST_EVENT_TIMEOUT_MS = 5 * 60 * 1_000 // 5 minutes — long tasks may take minutes before first SSE event
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const WAITING_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1_000
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000
const CARD_CLOSE_TIMEOUT_MS = 3_000
const CARD_CREATION_DELAY_MS = 500
const CHILD_IDLE_GRACE_MS = 1_500

// ── Factory ──

export function createStreamingBridge(
  deps: StreamingBridgeDeps,
): StreamingBridge {
  const { cardkitClient, feishuClient, subAgentTracker, logger, seenInteractiveIds } = deps
  const sessionTails = new Map<string, Promise<void>>()
  const childOwnership = new Map<string, number>()

  return {
    async handleMessage(
      chatId: string,
      sessionId: string,
      eventListeners: EventListenerMap,
      eventProcessor: EventProcessor,
      sendMessage: () => Promise<string>,
      onComplete: (text: string) => void,
      messageId: string,
      reactionId: string | null,
      requestText?: string,
      feishuKey?: string,
    ): Promise<void> {
      const previous = sessionTails.get(sessionId) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.catch(() => {}).then(() => gate)
      sessionTails.set(sessionId, tail)
      await previous.catch(() => {})

      if (deps.serverUrl && await isSessionBusy(deps.serverUrl, sessionId, logger)) {
        release()
        if (sessionTails.get(sessionId) === tail) sessionTails.delete(sessionId)
        throw new SessionBusyError(sessionId)
      }
      deps.activeSessions?.add(sessionId)

      let card: AgentConsoleSession | null = null
      let cardStartPromise: Promise<void> | null = null
      const taskChildren = new Map<string, string>()
      const taskDetails = new Map<string, { description: string; agent: string }>()

      const ensureCard = (): Promise<void> => {
        if (cardStartPromise) return cardStartPromise
        cardStartPromise = (async () => {
          const mapping = await resolveAgentConsoleMapping(
            sessionId,
            feishuKey,
            deps.sessionManager,
            deps.opencodeControlClient,
          )
          card = new AgentConsoleSession({
            cardkitClient,
            feishuClient,
            chatId,
            replyToMessageId: messageId,
            requestText,
            controls: buildAgentConsoleControls(mapping, true),
          })
          await card.start()
        })()
          .then(() => {
            const cardMessageId = card?.cardMessageId
            if (cardMessageId && deps.agentConsoleRegistry) {
              registerAgentConsoleTarget(cardMessageId)
            }
            logger.info(
              `Streaming card started for session ${sessionId} in chat ${chatId}`,
            )
          })
          .catch((err) => {
            card = null
            cardStartPromise = null
            throw err
          })
        return cardStartPromise
      }

      const registerAgentConsoleTarget = (
        cardMessageId: string,
      ): void => {
        deps.agentConsoleRegistry?.register(cardMessageId, {
          chatId,
          viewTask: async (taskKey) => {
            const childSessionId = taskChildren.get(taskKey)
            if (childSessionId) await card?.viewChild(childSessionId)
          },
          viewParent: async () => card?.viewParent(),
          openSessionPicker: async (sourceMessageId, operatorOpenId) => openPicker("sessions", sourceMessageId, operatorOpenId),
          openAgentPicker: async (sourceMessageId, operatorOpenId) => openPicker("agents", sourceMessageId, operatorOpenId),
          openModelPicker: async (sourceMessageId, operatorOpenId) => openPicker("models", sourceMessageId, operatorOpenId),
          selectSession: async (targetSessionId) => {
            if (!feishuKey || !deps.sessionManager) return
            const session = await fetchSessionInfo(targetSessionId)
            deps.sessionManager.setMapping(feishuKey, targetSessionId, undefined, {
              sessionTitle: session?.title ?? null,
              directory: session?.directory ?? null,
              projectName: basename(session?.directory) ?? null,
            })
          },
          switchAgent: async (agentId) => {
            if (!feishuKey) return
            deps.sessionManager?.updateContext(feishuKey, { agent: agentId })
          },
          switchModel: async (providerId, modelId) => {
            if (!feishuKey) return
            deps.sessionManager?.updateContext(feishuKey, { providerId, modelId })
          },
          switchProject: async (projectId) => {
            if (!feishuKey || !deps.sessionManager || !deps.opencodeControlClient) return
            const directory = (await deps.opencodeControlClient.listProjectDirectories(projectId).catch(() => []))[0]
            const sessions = await deps.opencodeControlClient.listProjectSessions(projectId).catch(() => [])
            const matched = sessions
              .filter((session) => !directory || session.directory === directory)
              .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
            const projectSession = matched
              ? { sessionId: matched.id, directory: matched.directory ?? directory }
              : await deps.opencodeControlClient.createProjectSession(projectId, directory)
            deps.sessionManager.updateContext(feishuKey, {
              sessionId: projectSession.sessionId,
              projectId,
              directory: projectSession.directory ?? directory ?? null,
            })
          },
          abort: async () => {
            const current = feishuKey ? deps.sessionManager?.getSession(feishuKey) : null
            await deps.opencodeControlClient?.abortSession({
              sessionId: current?.session_id ?? sessionId,
              projectId: current?.project_id,
            })
          },
        })
      }

      const openPicker = async (kind: "sessions" | "agents" | "models", sourceMessageId: string, operatorOpenId: string): Promise<void> => {
        if (!feishuKey || !deps.selectionPickerRegistry) return
        await deps.selectionPickerRegistry.open({ kind, feishuKey, chatId, replyToMessageId: sourceMessageId, operatorOpenId })
      }

      const fetchSessionInfo = async (targetSessionId: string): Promise<{ id: string; title?: string; directory?: string } | null> => {
        if (!deps.serverUrl) return null
        const resp = await fetch(`${deps.serverUrl}/session/${encodeURIComponent(targetSessionId)}`).catch(() => null)
        if (!resp?.ok) return null
        return await resp.json().catch(() => null) as { id: string; title?: string; directory?: string } | null
      }

      try {
        return await new Promise<void>((resolve, reject) => {
        let boundMessageId: string | null = null
        const textParts = new Map<string, string>()
        const textPartSources = new Map<string, "delta" | "snapshot">()
        let postCompleted = false
        let gotFirstEvent = false
        let settled = false
        let syncResponseBody = ""
        let waitingForUser = false
        let parentIdle = false
        const childStreams = new Map<string, {
          listener: (rawEvent: unknown) => void
          idle: boolean
          idleFallbackTimer: ReturnType<typeof setTimeout> | null
        }>()
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null
        let cardCreationTimer: ReturnType<typeof setTimeout> | null = null
        const getResponseText = (): string => stripThinkingContent([...textParts.values()].join("")).trim()
        const sendFinalResponse = async (text: string): Promise<void> => {
          const card = buildFinalResponseCard(text)
          await feishuClient.replyMessage(messageId, {
            msg_type: "interactive",
            content: JSON.stringify(card),
          })
          if (reactionId) {
            try {
              await feishuClient.deleteReaction(messageId, reactionId)
            } catch (err) {
              logger.warn(`deleteReaction failed: ${err}`)
            }
          }
        }

        const clearTimers = (): void => {
          clearTimeout(firstEventTimer)
          clearTimeout(absoluteTimer)
          if (inactivityTimer) clearTimeout(inactivityTimer)
          if (cardCreationTimer) clearTimeout(cardCreationTimer)
        }

        const closeCard = async (text: string, reason?: string): Promise<boolean> => {
          if (!card) return false
          try {
            await withTimeout(
              (cardStartPromise ?? Promise.resolve()).then(() => card!.close(
                reason
                  ? { status: "error", reason, finalAnswer: text }
                  : { finalAnswer: text },
              )),
              deps.cardCloseTimeoutMs ?? CARD_CLOSE_TIMEOUT_MS,
              "card.close() timed out",
            )
            return true
          } catch (err) {
            logger.warn(`card.close() failed: ${err}`)
            return false
          }
        }

        const complete = async (text: string, closeReason?: string): Promise<void> => {
          clearTimers()
          removeListener(eventListeners, sessionId, myListener)
          for (const [childSessionId, child] of childStreams) {
            removeListener(eventListeners, childSessionId, child.listener)
            if (child.idleFallbackTimer) clearTimeout(child.idleFallbackTimer)
            const owners = (childOwnership.get(childSessionId) ?? 1) - 1
            if (owners <= 0) {
              childOwnership.delete(childSessionId)
              deps.ownedSessions?.delete(childSessionId)
            } else {
              childOwnership.set(childSessionId, owners)
            }
          }
          const cardCompleted = await closeCard(text, closeReason)
          if (!cardCompleted || Buffer.byteLength(text, "utf8") > ANSWER_ELEMENT_MAX_BYTES) {
            try {
              await sendFinalResponse(text)
            } catch (err) {
              logger.warn(`sendFinalResponse failed: ${err}`)
            }
          } else if (reactionId) {
            try {
              await feishuClient.deleteReaction(messageId, reactionId)
            } catch (err) {
              logger.warn(`deleteReaction failed: ${err}`)
            }
          }
          if (deps.outboundMedia) {
            try {
              await deps.outboundMedia.sendDetectedFiles(chatId, text)
            } catch (err) {
              logger.warn(`outboundMedia.sendDetectedFiles failed: ${err}`)
            }
          }
          onComplete(text)
          resolve()
        }

        const handleLifecycleTimeout = (reason: string): void => {
          if (settled) return
          settled = true
          const responseText = getResponseText() || parseSyncResponse(syncResponseBody, logger)
          logger.warn(`${reason} for session ${sessionId}`)
          void complete(responseText, reason)
        }

        const resetInactivityTimer = (): void => {
          if (inactivityTimer) clearTimeout(inactivityTimer)
          inactivityTimer = setTimeout(() => {
            handleLifecycleTimeout("OpenCode event stream became inactive")
          }, waitingForUser
            ? (deps.waitingInactivityTimeoutMs ?? WAITING_INACTIVITY_TIMEOUT_MS)
            : (deps.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS))
          inactivityTimer.unref?.()
        }

        const maybeComplete = (): void => {
          if (settled || !parentIdle) return
          if ([...childStreams.values()].some((child) => !child.idle)) return
          settled = true
          void complete(getResponseText() || "（无回复）")
        }

        const attachChild = (
          taskKey: string,
          childSessionId: string,
        ): void => {
          taskChildren.set(taskKey, childSessionId)
          if (childStreams.has(childSessionId)) return
          deps.ownedSessions?.add(childSessionId)
          childOwnership.set(childSessionId, (childOwnership.get(childSessionId) ?? 0) + 1)
          const child = {
            idle: false,
            idleFallbackTimer: null as ReturnType<typeof setTimeout> | null,
            listener: (_rawEvent: unknown): void => {},
          }
          child.listener = (rawEvent: unknown): void => {
            const action = eventProcessor.processEvent(rawEvent)
            if (!action || action.sessionId !== childSessionId) return
            resetInactivityTimer()
            if (action.type === "TextDelta") {
              card?.markChildOutput(childSessionId).catch((err) => logger.warn(`child output update failed: ${err}`))
            } else if (action.type === "ToolStateChange") {
              card?.setChildToolStatus(childSessionId, {
                partId: action.partId,
                name: action.toolName,
                state: action.state as "pending" | "running" | "completed" | "error",
                title: action.title,
                input: action.input,
              }).catch((err) => logger.warn(`child tool update failed: ${err}`))
            } else if (action.type === "SessionIdle") {
              child.idle = true
              if (child.idleFallbackTimer) clearTimeout(child.idleFallbackTimer)
              card?.setChildStatus(childSessionId, "completed").catch(() => {})
              maybeComplete()
            }
          }
          childStreams.set(childSessionId, child)
          addListener(eventListeners, childSessionId, child.listener)
        }

        // Named listener reference — stored for removeListener calls
        const myListener = (rawEvent: unknown): void => {
          const action = eventProcessor.processEvent(rawEvent)
          if (!action) return
          if (action.sessionId !== sessionId) return

          if (!gotFirstEvent) {
            gotFirstEvent = true
            clearTimeout(firstEventTimer)
          }
          waitingForUser = action.type === "QuestionAsked" || action.type === "PermissionRequested"
          resetInactivityTimer()

          switch (action.type) {
            case "MessageModelResolved": {
              if (feishuKey && deps.sessionManager) {
                deps.sessionManager.updateContext(feishuKey, {
                  providerId: action.providerId,
                  modelId: action.modelId,
                })
                const mapping = deps.sessionManager.getSession(feishuKey)
                if (card && mapping) {
                  card.setControls(buildAgentConsoleControls(mapping, true)).catch((err) => {
                    logger.warn(`actual model context update failed: ${err}`)
                  })
                }
              }
              break
            }
            case "TextDelta": {
              if (boundMessageId === null) {
                boundMessageId = action.messageId
              }
              if (action.messageId !== boundMessageId) {
                logger.debug(`Ignoring text for unrelated message ${action.messageId} in session ${sessionId}`)
                break
              }
              const current = textParts.get(action.partId) ?? ""
              if (
                action.source === "delta" &&
                textPartSources.get(action.partId) === "snapshot" &&
                current.endsWith(action.text)
              ) {
                textPartSources.set(action.partId, "delta")
                break
              }
              textParts.set(
                action.partId,
                truncateResponseText(action.source === "snapshot" ? action.text : current + action.text),
              )
              textPartSources.set(action.partId, action.source)
              const responseText = getResponseText()
              if (cardStartPromise) {
                cardStartPromise
                  .then(() => card!.setAnswerText(responseText))
                  .catch((err) => logger.warn(`stream answer update failed: ${err}`))
              }
              break
            }



            case "ToolStateChange": {
              if (action.toolName.toLowerCase() === "task" && action.partId) {
                const previousTask = taskDetails.get(action.partId)
                const inputDescription = taskDisplayValue(action.input?.description, "子任务")
                const inputAgent = taskDisplayValue(action.input?.subagent_type, "子Agent")
                const description = inputDescription ?? previousTask?.description
                const agent = inputAgent ?? previousTask?.agent
                if (description && agent) taskDetails.set(action.partId, { description, agent })
                const childSessionId = stringValue(action.metadata?.sessionId)
                if (childSessionId) {
                  attachChild(action.partId, childSessionId)
                  if (action.state === "completed" || action.state === "error") {
                    const child = childStreams.get(childSessionId)
                    if (child && !child.idle && !child.idleFallbackTimer && deps.serverUrl) {
                      child.idleFallbackTimer = setTimeout(() => {
                        child.idleFallbackTimer = null
                        confirmSessionIdle(deps.serverUrl!, childSessionId)
                          .then((idle) => {
                            if (!idle || child.idle) return
                            child.idle = true
                            card?.setChildStatus(childSessionId, action.state === "error" ? "error" : "completed").catch(() => {})
                            maybeComplete()
                          })
                          .catch((err) => logger.warn(`child idle confirmation failed: ${err}`))
                      }, CHILD_IDLE_GRACE_MS)
                      child.idleFallbackTimer.unref?.()
                    }
                  }
                }
                if (!description || !agent) break
                ensureCard()
                  .then(async () => {
                    await card!.setTaskStatus({
                      partId: action.partId!,
                      description,
                      agent,
                      state: action.state as "pending" | "running" | "completed" | "error",
                      ...(childSessionId ? { childSessionId } : {}),
                    })
                    if (childSessionId) {
                      await card!.setChildStatus(
                        childSessionId,
                        action.state === "error" ? "error" : action.state === "completed" ? "completed" : "running",
                      )
                      maybeComplete()
                    }
                  })
                  .catch((err) => logger.warn(`task status update failed: ${err}`))
                break
              }
              ensureCard()
                .then(() => {
                  card!
                    .setToolStatus(
                      {
                        partId: action.partId,
                        name: action.toolName,
                        state: action.state as "pending" | "running" | "completed" | "error",
                        title: action.title,
                        input: action.input,
                      },
                    )
                    .catch((err) => {
                      logger.warn(`setToolStatus failed: ${err}`)
                    })
                })
                .catch((err) => {
                  logger.warn(`card start for tool failed: ${err}`)
                })
              break
            }

            case "SubtaskDiscovered": {
              ensureCard()
                .then(() => card!.addSubtask(action.description, action.agent))
                .catch((err) => {
                  logger.warn(`addSubtask failed: ${err}`)
                })
              subAgentTracker
                .onSubtaskDiscovered(action)
                .then((tracked) => {
                  const childSessionId = tracked.childSessionId ?? action.sessionId
                  // Build and send a separate card for this sub-agent
                  const cardData = buildSubAgentNotificationCard(
                    action.description,
                    action.agent ?? "sub-agent",
                    childSessionId,
                  )
                  return feishuClient.sendMessage(chatId, {
                    msg_type: "interactive",
                    content: JSON.stringify(cardData),
                  })
                })
                .catch((err) => {
                  logger.warn(`SubtaskDiscovered handling failed: ${err}`)
                })
              break
            }

            case "QuestionAsked": {
              const cardKey = interactiveCardKey("question", action.requestId)
              if (seenInteractiveIds.has(cardKey)) break
              if (!deps.embeddedInteractionRegistry) {
                sendQuestionCard(action, chatId)
                break
              }
              seenInteractiveIds.add(cardKey)
              ensureCard()
                .then(async () => {
                  deps.embeddedInteractionRegistry?.register({
                    requestId: action.requestId,
                    kind: "question",
                    resolve: (selections) => card!.resolveInteraction(selections),
                  })
                  const title = action.questions[0]?.question ?? action.questions[0]?.header ?? "需要用户回答"
                  await card!.setWaitingForQuestion(title, action.requestId)
                  await card!.showQuestion(action)
                })
                .catch((err) => {
                  deps.embeddedInteractionRegistry?.untrack("question", action.requestId)
                  logger.warn(`Embedded question failed for active bridge session: ${err}`)
                })
              break
            }

            case "PermissionRequested": {
              const cardKey = interactiveCardKey("permission", action.requestId)
              if (seenInteractiveIds.has(cardKey)) break
              if (!deps.embeddedInteractionRegistry) {
                sendPermissionCard(action, chatId)
                break
              }
              seenInteractiveIds.add(cardKey)
              ensureCard()
                .then(async () => {
                  deps.embeddedInteractionRegistry?.register({
                    requestId: action.requestId,
                    kind: "permission",
                    resolve: (selections) => card!.resolveInteraction(selections),
                  })
                  await card!.setWaitingForPermission(action.title, action.requestId)
                  await card!.showPermission(action)
                })
                .catch((err) => {
                  deps.embeddedInteractionRegistry?.untrack("permission", action.requestId)
                  logger.warn(`Embedded permission failed for active bridge session: ${err}`)
                })
              break
            }

            case "SessionIdle": {
              if (settled) return
              if (boundMessageId === null && !postCompleted) {
                logger.debug(`Ignoring idle before current response started for session ${sessionId}`)
                return
              }
              parentIdle = true
              maybeComplete()
              break
            }

            default:
              break
          }
        }

        const firstEventTimer = setTimeout(async () => {
          if (gotFirstEvent || settled) return
          settled = true
          logger.warn(
            `No SSE events received within ${FIRST_EVENT_TIMEOUT_MS}ms for ${sessionId}, falling back to sync response`,
          )
          const fallbackText = parseSyncResponse(syncResponseBody, logger)
          void complete(fallbackText, "OpenCode 长时间未返回事件，已使用同步响应回退。")
        }, FIRST_EVENT_TIMEOUT_MS)
        firstEventTimer.unref?.()

        const absoluteTimer = setTimeout(() => {
          handleLifecycleTimeout("OpenCode request exceeded its maximum lifetime")
        }, deps.maxLifetimeMs ?? MAX_LIFETIME_MS)
        absoluteTimer.unref?.()

        function sendQuestionCard(action: QuestionAsked, targetChatId: string): void {
          const cardKey = interactiveCardKey("question", action.requestId)
          if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("question", action.requestId)) return
          feishuClient.sendMessage(targetChatId, {
            msg_type: "interactive",
            content: JSON.stringify(buildQuestionCard(action)),
          }).then((response) => {
            const sentMessageId = extractFeishuMessageId(response)
            if (!sentMessageId) {
              deps.interactiveCardRegistry?.failDispatch("question", action.requestId)
              return
            }
            seenInteractiveIds.add(cardKey)
            deps.interactiveCardRegistry?.track({
              requestId: action.requestId, kind: "question", chatId: targetChatId, messageId: sentMessageId,
            })
          }).catch((err) => {
            deps.interactiveCardRegistry?.failDispatch("question", action.requestId)
            logger.warn(`Question card send failed: ${err}`)
          })
        }

        function sendPermissionCard(action: PermissionRequested, targetChatId: string): void {
          const cardKey = interactiveCardKey("permission", action.requestId)
          if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("permission", action.requestId)) return
          feishuClient.sendMessage(targetChatId, {
            msg_type: "interactive",
            content: JSON.stringify(buildPermissionCard(action)),
          }).then((response) => {
            const sentMessageId = extractFeishuMessageId(response)
            if (!sentMessageId) {
              deps.interactiveCardRegistry?.failDispatch("permission", action.requestId)
              return
            }
            seenInteractiveIds.add(cardKey)
            deps.interactiveCardRegistry?.track({
              requestId: action.requestId, kind: "permission", chatId: targetChatId, messageId: sentMessageId,
            })
          }).catch((err) => {
            deps.interactiveCardRegistry?.failDispatch("permission", action.requestId)
            logger.warn(`Permission card send failed: ${err}`)
          })
        }

        // Register event listener BEFORE the POST to avoid race condition
        addListener(eventListeners, sessionId, myListener)

        cardCreationTimer = setTimeout(() => {
          if (settled) return
          ensureCard()
            .then(() => getResponseText() ? card!.setAnswerText(getResponseText()) : undefined)
            .catch((err) => logger.warn(`delayed agent console start failed: ${err}`))
        }, deps.cardCreationDelayMs ?? CARD_CREATION_DELAY_MS)
        cardCreationTimer.unref?.()

          sendMessage()
          .then((responseBody) => {
            postCompleted = true
            syncResponseBody = responseBody
            logger.info(
              `POST completed for session ${sessionId} (${responseBody.length} bytes)`,
            )
          })
          .catch((err) => {
            if (settled) return
            // If SSE events have been flowing, the POST timeout is expected
            // (e.g. agent blocked on question/permission). Keep the listener alive.
            if (gotFirstEvent) {
              logger.info(`POST timed out for session ${sessionId} but SSE events are flowing — keeping listener active`)
              return
            }
            settled = true
            clearTimers()
            removeListener(eventListeners, sessionId, myListener)
            if (card) card.close({ status: "error", reason: String(err) }).catch(() => {})
            reject(err)
          })
        })
      } finally {
        deps.activeSessions?.delete(sessionId)
        release()
        void tail.then(() => {
          if (sessionTails.get(sessionId) === tail) {
            sessionTails.delete(sessionId)
          }
        })
      }
    },
  }
}

// ── Helpers ──

function parseSyncResponse(rawText: string, logger: Logger): string {
  if (!rawText.trim()) return "（无回复）"
  try {
    const data = JSON.parse(rawText) as {
      parts?: Array<{ type: string; text?: string }>
    }
    const text = (
      data.parts
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
    ) ?? ""
    return stripThinkingContent(text).trim() || "（无回复）"
  } catch (e) {
    logger.warn(`Failed to parse sync response: ${e}`)
    return stripThinkingContent(rawText).trim() || "（无回复）"
  }
}

function buildAgentConsoleControls(
  mapping: {
    session_id?: string
    agent?: string
    project_id?: string | null
    directory?: string | null
    provider_id?: string | null
    model_id?: string | null
    session_title?: string | null
    project_name?: string | null
    branch_name?: string | null
  } | null | undefined,
  canAbort: boolean,
): AgentConsoleControls | undefined {
  if (!mapping && !canAbort) return undefined
  const modelLabel = mapping?.provider_id && mapping.model_id
    ? `${mapping.provider_id}:${mapping.model_id}`
    : undefined
  return {
    canAbort,
    sessionId: mapping?.session_id,
    sessionTitle: mapping?.session_title ?? undefined,
    agentLabel: mapping?.agent,
    modelLabel,
    projectName: mapping?.project_name ?? basename(mapping?.directory) ?? undefined,
    branchName: mapping?.branch_name ?? undefined,
  }
}

async function resolveAgentConsoleMapping(
  sessionId: string,
  feishuKey: string | undefined,
  sessionManager: SessionManager | undefined,
  controlClient: OpencodeControlClient | undefined,
): Promise<ReturnType<SessionManager["getSession"]>> {
  let mapping = feishuKey ? sessionManager?.getSession(feishuKey) ?? null : null
  if (!controlClient) return mapping
  const session = await controlClient.getSession(sessionId).catch(() => null)
  const directory = mapping?.directory ?? session?.directory
  const vcs = directory && !mapping?.branch_name
    ? await controlClient.getVcs(directory).catch((): { branch?: string } => ({}))
    : {} as { branch?: string }
  if (feishuKey && sessionManager && (session?.directory || session?.title || session?.model || vcs.branch)) {
    sessionManager.updateContext(feishuKey, {
      ...(session?.directory ? { directory: session.directory, projectName: basename(session.directory) ?? null } : {}),
      ...(session?.title ? { sessionTitle: session.title } : {}),
      ...(session?.model ? { providerId: session.model.providerId, modelId: session.model.modelId } : {}),
      ...(vcs.branch ? { branchName: vcs.branch } : {}),
    })
    mapping = sessionManager.getSession(feishuKey)
  }
  return mapping
}

function basename(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return path.split("/").filter(Boolean).at(-1) ?? path
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function truncateResponseText(text: string): string {
  const maxLength = 102_400
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + "\n\n…(内容过长，已截断)"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function taskDisplayValue(value: unknown, placeholder: string): string | undefined {
  const text = stringValue(value)?.trim()
  if (!text) return undefined
  const normalized = text.toLowerCase()
  if (
    normalized === placeholder.toLowerCase()
    || normalized === "agent"
    || normalized === "subagent"
    || normalized === "sub-agent"
    || normalized === "assistant"
  ) return undefined
  return text
}

export function stripThinkingContent(text: string): string {
  let visible = text.replace(
    /<(thinking|think|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  )
  visible = visible.replace(/<(thinking|think|analysis)\b[^>]*>[\s\S]*$/gi, "")
  visible = visible.replace(/<\/(thinking|think|analysis)\s*>/gi, "")

  const lastOpen = visible.lastIndexOf("<")
  if (lastOpen >= 0) {
    const suffix = visible.slice(lastOpen).toLowerCase()
    if (
      "<thinking".startsWith(suffix)
      || "<think".startsWith(suffix)
      || "<analysis".startsWith(suffix)
    ) {
      visible = visible.slice(0, lastOpen)
    }
  }
  return visible
}

async function isSessionBusy(serverUrl: string, sessionId: string, logger: Logger): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/session/status`)
    if (!response.ok) return false
    const statuses = await response.json() as Record<string, { type?: string }>
    return statuses[sessionId]?.type === "busy" || statuses[sessionId]?.type === "retry"
  } catch (err) {
    logger.warn(`Failed to check session status before prompt: ${err}`)
    return false
  }
}

async function confirmSessionIdle(serverUrl: string, sessionId: string): Promise<boolean> {
  const response = await fetch(`${serverUrl}/session/status`)
  if (!response.ok) return false
  const statuses = await response.json() as Record<string, { type?: string }>
  const status = statuses[sessionId]?.type
  return status === undefined || status === "idle"
}

export function buildFinalResponseCard(text: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: text,
      },
    ],
  }
}

function buildSubAgentNotificationCard(
  description: string,
  agent: string,
  childSessionId: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🤖 ${agent}` },
      template: "indigo",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: description },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔍 View Details" },
            type: "primary",
            value: { action: "view_subagent", childSessionId },
          },
        ],
      },
    ],
  }
}

export function buildQuestionCard(
  action: QuestionAsked,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []

  // Render each question (support multi-question requests)
  for (let qi = 0; qi < action.questions.length; qi++) {
    const question = action.questions[qi]!
    if (qi > 0) {
      elements.push({ tag: "hr" })
    }
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: question.question },
    })
    elements.push({
      tag: "action",
      actions: question.options.map((opt, idx) => ({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: idx === 0 ? "primary" : "default",
        value: {
          action: "question_answer",
          requestId: action.requestId,
          answers: JSON.stringify([[opt.label]]),
        },
      })),
    })
  }

  const header = action.questions[0]?.header ?? "Question"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `❓ ${header}` },
      template: "orange",
    },
    elements,
  }
}

export function buildPermissionCard(
  action: PermissionRequested,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🔐 Permission: ${action.permissionType}` },
      template: "yellow",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: action.title },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Allow Once" },
            type: "primary",
            value: { action: "permission_reply", requestId: action.requestId, reply: "once" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Always Allow" },
            type: "default",
            value: { action: "permission_reply", requestId: action.requestId, reply: "always" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ Reject" },
            type: "danger",
            value: { action: "permission_reply", requestId: action.requestId, reply: "reject" },
          },
        ],
      },
    ],
  }
}
