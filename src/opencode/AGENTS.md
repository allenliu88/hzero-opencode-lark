# opencode/

Directory-scoped adapters for OpenCode Server control APIs.

## `control-client.ts`

The picker-facing APIs mirror the OpenCode Web application:

- `GET /agent?directory=...` lists agents; hidden and subagent entries are excluded.
- `GET /provider?directory=...` lists providers/models; when `connected` is present only those providers are exposed, while older responses without it retain all parsed providers. Deprecated models are always excluded.
- `GET /session?directory=...&roots=true&limit=10000` lists root sessions for the current directory; archived and child sessions are excluded.
- `GET /session/:sessionID` hydrates title, directory, summary, and the persisted current model.
- `GET /vcs?directory=...` resolves the current and default branch.

Model identities are always the pair `(providerId, modelId)`. UI labels use `providerID/modelID`; internal picker values use `providerID:modelID`.

The client also retains project-scoped methods needed by compatibility paths and experimental Agent Console project switching. They are not the primary source for picker data, and project switching is not exposed by the currently rendered main card.
