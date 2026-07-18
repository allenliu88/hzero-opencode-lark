# utils/

Shared infrastructure. No business logic lives here. If something is needed in more than one module and doesn't belong to a specific domain, it goes here.

## Files

### `paths.ts`
`getAttachmentsDir()` — returns the canonical path to the attachments directory used for downloaded Feishu files and uploaded agent outputs. Centralizes this so `outbound-media.ts`, `message-handler.ts`, and tests all resolve the same directory rather than each hardcoding a path.

Always use this instead of constructing attachment paths manually.

### `config.ts`
Loads configuration from `opencode-lark.jsonc` (supports comments via jsonc parsing) and merges with environment variables. Environment variables take precedence over file values.

Returns a typed `Config` object. The config schema lives in `src/types.ts`. Don't access `process.env` directly in other modules — import from here instead.

### `logger.ts`
Factory that returns a named `Logger` instance backed by a structured logging library. Every module should create its logger at the top of the file:

```typescript
const log = createLogger("my-module")
log.info("starting up")
log.error({ err }, "something went wrong")
```

Never use `console.log` anywhere in the codebase. The logger writes structured JSON in production and pretty-printed output in dev (controlled by `LOG_FORMAT` env var).

### `db.ts`
Initializes the SQLite databases using `bun:sqlite`. Exports `initDatabase(dataDir)` which returns an `AppDatabase` object containing the active `sessions` handle and a legacy `memory` database handle plus a `close()` method. The memory feature/module has been removed; do not treat this handle as conversation-history injection. Enables WAL mode for both files. Import and call this once at startup (Phase 3 in `src/index.ts`) — all other modules that need SQLite should receive a handle via dependency injection, not open their own connection.

### `event-listeners.ts`
A typed `Map<string, Set<listener>>` with `addListener(map, sessionId, fn)` and `removeListener(map, sessionId, fn)` helper functions. The map type is exported as `EventListenerMap`. Used by `StreamingBridge`, `SessionObserver`, and `src/index.ts` to manage per-session event subscriptions without leaking listeners. Always call `removeListener` when you're done with a subscription.

## Conventions

- No side effects at import time (except `logger.ts` which is safe).
- No dependencies on `src/feishu/`, `src/handler/`, or any domain module.
- Tests for these utilities live in `src/utils/__tests__/` and `src/utils/event-listeners.test.ts`.
