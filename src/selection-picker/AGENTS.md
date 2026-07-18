# selection-picker/

Shared Card JSON 2.0 pickers for Agent, Model, and Session selection.

## `selection-picker-registry.ts`

- Loads directory-scoped options through `OpencodeControlClient`.
- Renders at most eight full-width rows per page.
- Updates the same Feishu message for previous/next navigation.
- Resolves opaque `entryKey` values from server-side state rather than trusting callback business IDs.
- Validates chat, operator, view token, and action ID.
- Serializes actions, expires state after TTL, and retries card updates with bounded delays.

OpenCode parity rules:

- Agents: `GET /agent?directory=...`; exclude hidden and subagent entries.
- Models: `GET /provider?directory=...`; honor `connected` when supplied and exclude deprecated models. Missing `connected` retains all parsed providers for compatibility.
- Sessions: `GET /session?directory=...&roots=true&limit=10000`; exclude archived, child, and other-directory sessions.

Session rows show the title, relative update time, and file count in the button. Session ID and `project#branch` appear as a grey detail line. The current item uses a `▶` prefix.

Selecting a Session replaces the thread mapping. Session metadata is rehydrated, while prior Agent/Model overrides are reset unless selected again.
