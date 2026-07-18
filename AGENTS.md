# AGENTS.md — opencode-lark

Architecture guide for contributors. Covers module layout, key abstractions, data flow, and how to extend the system.

## What This Project Does

`opencode-lark` bridges Feishu group chats with opencode TUI sessions. Messages sent in Feishu flow into opencode as if typed in the terminal. Agent replies, tool status, and task timelines stream into one Agent Console CardKit card with serialized delivery; sub-agent discovery may additionally emit a separate navigation or notification card.

```
Feishu client
    ↕  WebSocket (long-lived)
Feishu Open Platform
    ↕  WebSocket / Webhook
opencode-lark  (this project)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

---

## Module Map

```
src/
├── index.ts         Entry point, 9-phase startup + graceful shutdown
├── types.ts         Shared type definitions
├── channel/         ChannelPlugin interface, ChannelManager, FeishuPlugin
├── feishu/          Feishu REST client, CardKit, WebSocket, message dedup
├── file-browser/    Read-only remote OpenCode workspace browser
├── handler/         MessageHandler (inbound pipeline) + StreamingBridge (SSE → cards)
├── opencode/        Directory-scoped OpenCode control API adapter
├── selection-picker/ Card JSON 2.0 Agent/Model/Session picker registry
├── session/         TUI session discovery, thread→session mapping, progress cards
├── streaming/       EventProcessor (SSE parsing), SessionObserver, SubAgentTracker
├── cron/            CronService (scheduled jobs) + HeartbeatService
└── utils/           Config loader, logger, SQLite init, EventListenerMap, paths helper
```

---

## Key Abstractions

### ChannelPlugin (`src/channel/types.ts`)

The core extension contract. Any chat platform (Slack, Discord, etc.) implements this interface to plug into `ChannelManager`.

```typescript
interface ChannelPlugin {
  id: ChannelId           // e.g. "feishu"
  meta: ChannelMeta       // label + description
  config: ChannelConfigAdapter      // list accounts, resolve credentials
  gateway?: ChannelGatewayAdapter   // start/stop connections
  messaging?: ChannelMessagingAdapter  // normalize inbound, format outbound
  outbound?: ChannelOutboundAdapter    // sendText, sendCard
  streaming?: ChannelStreamingAdapter  // createStreamingSession, coalesceUpdates
  threading?: ChannelThreadingAdapter  // resolveThread, mapSession, getSession
}
```

All adapters except `config` are optional. Implement only what your channel needs.

### EventProcessor (`src/streaming/event-processor.ts`)

Consumes the raw SSE stream from opencode and emits structured events such as `TextDelta`, `SessionIdle`, tool state changes, and `MessageModelResolved`. The model event carries the actual provider/model reported by User or Assistant messages so the Agent Console footer and persisted mapping stay accurate.

### SessionManager (`src/session/session-manager.ts`)

Binds a Feishu thread key (chat ID + thread ID) to a specific OpenCode session and persists session/project/Agent/Model context in SQLite. New mappings create a clean session by default; optional TUI discovery is enabled only by `session.autoDiscoverTui`.

### StreamingBridge (`src/handler/streaming-integration.ts`)

Buffers `TextDelta` events and queues them into CardKit streaming card updates (serialized to avoid rate limits). It hydrates session, project, branch, and actual model context before creating the card, refreshes the footer when a newer message model arrives, and closes the streaming card when `SessionIdle` fires.

### SelectionPickerRegistry (`src/selection-picker/selection-picker-registry.ts`)

Owns Agent, Model, and Session picker cards. It uses eight-row in-place pagination, rotating view tokens, per-view action IDs for in-flight duplicate suppression, opaque entry keys, per-operator authorization, action serialization, TTL cleanup, and limited update retries. Picker data comes from directory-scoped OpenCode APIs that match the OpenCode Web application.

---

## Data Flow

### Inbound (Feishu → opencode)

```
Feishu WebSocket
  → FeishuPlugin.gateway.startAccount()
    → raw event received
      → ChannelMessagingAdapter.normalizeInbound()
        → MessageHandler
          1. MessageDedup: skip if already seen
          2. SessionManager: resolve/create session, with optional TUI discovery
          3. Inject Lark context signature (first message per session)
          4. HTTP POST to opencode /session/{id}/message
          5. Register SSE listener for this session
          6. ProgressTracker: show "thinking..." reaction/card in Feishu

### Outbound (opencode → Feishu)

```
opencode SSE stream
  → EventProcessor: parse raw event → typed event
    → SessionObserver: fan-out to registered listeners
      → StreamingBridge
          TextDelta  → accumulate text, queued CardKit update
          SessionIdle → flush final card to Feishu via CardKitClient
          ToolStart  → update progress card
```
---

## Startup Phases (`src/index.ts`)

1. Load config (`opencode-lark.jsonc` or env vars)
2. Connect to opencode server (exponential-backoff retry, max 10 attempts)
3. Init SQLite database
4. Create shared services (SessionManager, EventProcessor, StreamingBridge)
5. Subscribe to opencode SSE event stream
6. Instantiate FeishuPlugin + register with ChannelManager
7. Start channels (WebSocket) + webhook server (card action callbacks)
8. Start optional CronService + HeartbeatService
9. Register SIGTERM/SIGINT handlers for graceful shutdown
---

## Extension Points

### Adding a New Channel

1. Create `src/channel/{platform}/` directory.
2. Implement `ChannelPlugin` from `src/channel/types.ts`. Start with `config` (required), then add `gateway`, `messaging`, `outbound` as needed.
3. In `src/index.ts` Phase 6, instantiate your plugin and call `channelManager.register(yourPlugin)`.
4. `ChannelManager.startAll()` will call `gateway.startAccount()` for each configured account automatically.
### Adding a Cron Job


1. Open `src/cron/cron-service.ts`.
2. Add your job definition to the cron config schema in `src/types.ts`.
3. Register the new job inside `CronService.start()` with a cron expression and handler function.
4. Enable it in `opencode-lark.jsonc` under the `cron` key.

### Adding a Heartbeat Check

`src/cron/heartbeat.ts` pings the opencode server and optionally posts a status message to a Feishu chat. Extend `HeartbeatService` to check additional endpoints or post richer status cards via `CardKitClient`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | Card action callback port |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory |

See `.env.example` and `opencode-lark.example.jsonc` for full reference.
