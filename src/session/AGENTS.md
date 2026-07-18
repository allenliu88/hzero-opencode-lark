# session/

Thread-to-session binding and progress feedback. Knows which opencode session a Feishu thread is talking to, and shows "thinking..." cards while the agent works.

## Files

### `session-manager.ts`
The source of truth for thread→session mappings.

Key methods:
- `getOrCreate(threadKey)` — returns the persisted binding. For an unbound thread it creates a clean session by default; when `session.autoDiscoverTui` is true it first tries the latest root TUI session for `OPENCODE_CWD`.
- `getExisting(threadKey)` — returns the current session ID without creating anything. Read-only features such as `/files` use it to avoid spawning sessions.
- `updateContext(threadKey, patch)` — updates selected Agent/Model and hydrated session/project/branch metadata without replacing unspecified values.

Mappings persist session ID/title, directory, project/branch, Agent, and provider/model context in SQLite. `/new`, `/connect`, and Session picker selection can replace the mapping.

The thread key format is `{chatId}:{rootId}` for threaded group chats, `{chatId}:{messageId}` for non-threaded group messages, or just `{chatId}` for p2p chats.

### `progress-tracker.ts`
Sends a "thinking..." placeholder card to Feishu when the agent starts processing, then clears or updates it once the response begins streaming. Prevents the Feishu chat from looking unresponsive during long agent turns.

Lifecycle:
1. `show(threadKey)` — sends the placeholder card, stores the `cardId`
2. `update(threadKey, text)` — replaces the card content (used for tool progress)
3. `dismiss(threadKey)` — removes or replaces with final content

## Gotchas

- `getOrCreate` talks to the OpenCode API while creating or optionally discovering a session. If OpenCode is unreachable, it throws; catch this at the call site.
- SQLite writes are synchronous in bun. Don't call session methods in a tight loop.
- Two Feishu threads can share the same opencode session (e.g. after `/connect`). The mapping is many-threads-to-one-session.
- With auto-discovery enabled, a missing usable TUI session falls back to creating a clean session.
