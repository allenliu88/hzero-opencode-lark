# file-browser/

Read-only browser for the workspace on the OpenCode Server host.

- `remote-file-client.ts` adapts OpenCode SDK session/file responses into local models.
- `path-policy.ts` validates project-relative paths and blocks common credential files.
- `file-browser-card.ts` builds Card JSON 2.0 directory and paginated text-preview cards. Directory entries are single-column full-width icon buttons; all bottom actions stay in one `flex_mode: none` row.
- `file-browser-registry.ts` owns per-card state, view tokens, idempotent action IDs, operator authorization, TTL cleanup, serialized navigation, loading states, and card-update retries.
- `remote-file-client.ts` applies 5-second session/directory timeouts and a 10-second file timeout through `AbortSignal`.

Never use Node filesystem APIs here to validate or read project files. The bridge and OpenCode server may run on different hosts. Callback values are untrusted; resolve navigation through the registry's current entry map rather than accepting paths, directories, session IDs, or page numbers from the card. Validate `viewToken` and `actionId` synchronously before enqueueing an immutable navigation action.
