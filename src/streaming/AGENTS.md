# streaming/

Parses the raw SSE stream from opencode and distributes typed events to whoever needs them. Both `streaming-card.ts` and `session-observer.ts` send messages and cards to Feishu via the `FeishuApiClient`.

## Files

### `event-processor.ts`
Parses raw SSE event objects (dispatched by `src/index.ts`) into typed action objects. It does **not** own the SSE connection — `src/index.ts` subscribes to the opencode event stream and dispatches events to per-session listeners via `EventListenerMap`. `EventProcessor.processEvent(raw)` converts a raw event into one of the following typed actions:

| Action | Meaning |
|---|---|
| `TextDelta` | A chunk of text from the agent |
| `SessionIdle` | The agent finished responding |
| `ToolStateChange` | A tool call's state changed (running, completed, error) |
| `SubtaskDiscovered` | A sub-agent task was spawned |
| `QuestionAsked` | The agent is asking the user a question |
| `PermissionRequested` | The agent is requesting permission (file edit, bash, etc.) |
| `MessageModelResolved` | A User or Assistant message reports the actual provider/model used for the turn |

`EventProcessor` is a stateful class (tracks `ownedSessions`, message roles, and reasoning part IDs) but does not manage any connections or listeners itself. `StreamingBridge` consumes `MessageModelResolved` to persist the actual model and refresh the Agent Console footer.

### `session-observer.ts`
Manages per-session observation for forwarding TUI-initiated events to Feishu. Key API: `observe(sessionId, chatId)` registers a listener for a session, `markOwned(messageId)` marks a Feishu-initiated message to skip during forwarding, `markSessionBusy(sessionId)` / `markSessionFree(sessionId)` controls whether TextDelta/SessionIdle are forwarded (suppressed during active streaming bridge), `getChatForSession(sessionId)` returns the associated chat, and `stop()` cleans up all listeners.

Also handles a secondary path: if a message was sent from the opencode TUI directly (not via Feishu), `SessionObserver` can still forward the resulting events to any active Feishu listener for that session.

### `agent-console.ts`
The production live-card implementation used by `StreamingBridge`. It renders progress/tool/task timelines, streamed answers, embedded question/permission interactions, and a read-only runtime-context/help footer. Element updates are serialized and coalesced; `setControls()` refreshes the footer when the actual model becomes available.

### `agent-console-registry.ts`
Routes Agent Console navigation and compatibility callbacks by card message ID and chat ID. Picker-opening, direct switch, project-switch, and abort methods exist in the target contract, but the currently rendered Agent Console footer is read-only and exposes slash commands rather than direct buttons.

### `streaming-card.ts`
Legacy standalone streaming-card implementation retained for compatibility and tests. New production work should normally target `AgentConsoleSession` unless intentionally maintaining this path.

## Design notes

The split between `EventProcessor` (parses events, stateful but passive) and `SessionObserver` (routes to Feishu chats, manages busy/free state) keeps concerns clean. If you want to add a new consumer of SSE events, register a listener in `EventListenerMap` from `src/index.ts`. If you want to react to TUI-initiated events for a specific session, use `SessionObserver.observe()`.

## Gotchas

- `SessionIdle` fires once per agent turn, not once per session lifetime. Multiple idle events are expected in a long conversation.
- `TextDelta` events can arrive very rapidly. Never write to Feishu on every delta. `AgentConsoleSession` serializes and coalesces updates through its queue.
- `EventProcessor` does not manage the SSE connection. Reconnection logic lives in `src/index.ts` where the event stream is subscribed.
