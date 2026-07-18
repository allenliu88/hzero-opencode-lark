import type { Logger } from "../utils/logger.js"
import type { SessionMapping } from "../types.js"

export interface ProjectOption {
  id: string
  label: string
  directory?: string
}

export interface AgentOption {
  id: string
  label: string
}

export interface ModelOption {
  value: string
  providerId: string
  modelId: string
  label: string
}

export interface SessionOption {
  id: string
  title?: string
  directory?: string
  parentId?: string
  time?: { created?: number; updated?: number; archived?: number }
  summary?: { files?: number }
  model?: { providerId: string; modelId: string }
}

export interface ConsoleControlOptions {
  projects: ProjectOption[]
  agents: AgentOption[]
  models: ModelOption[]
}

export interface AbortSessionContext {
  sessionId: string
  projectId?: string | null
}

export interface CreateProjectSessionResult {
  sessionId: string
  directory?: string
}

export interface OpencodeControlClient {
  listProjects(): Promise<ProjectOption[]>
  listProjectDirectories(projectId: string): Promise<string[]>
  listAgents(directory?: string): Promise<AgentOption[]>
  listModels(directory?: string): Promise<ModelOption[]>
  listSessions(directory: string): Promise<SessionOption[]>
  getSession(sessionId: string): Promise<SessionOption | null>
  getVcs(directory: string): Promise<{ branch?: string; defaultBranch?: string }>
  listProjectSessions(projectId: string): Promise<Array<{ id: string; directory?: string; time?: { updated?: number } }>>
  createProjectSession(projectId: string, directory?: string): Promise<CreateProjectSessionResult>
  abortSession(context: AbortSessionContext): Promise<void>
  getConsoleOptions(mapping?: SessionMapping | null): Promise<ConsoleControlOptions>
}

export function createOpencodeControlClient(options: {
  serverUrl: string
  logger?: Logger
  fallbackAgents?: string[]
  fallbackModels?: ModelOption[]
}): OpencodeControlClient {
  const serverUrl = options.serverUrl.replace(/\/$/, "")

  async function getJson<T>(path: string): Promise<T> {
    const resp = await fetch(`${serverUrl}${path}`)
    if (!resp.ok) {
      throw new Error(`OpenCode ${path} failed: HTTP ${resp.status}`)
    }
    const text = await resp.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`OpenCode ${path} returned non-JSON response`)
    }
  }

  async function postJson<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!resp.ok) {
      throw new Error(`OpenCode ${path} failed: HTTP ${resp.status}`)
    }
    return await resp.json() as T
  }

  async function listProjects(): Promise<ProjectOption[]> {
    const data = await getJson<unknown>("/project")
    const items = Array.isArray(data) ? data : []
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const record = item as Record<string, unknown>
      const id = stringValue(record.id) ?? stringValue(record.projectID)
      if (!id) return []
      const label = stringValue(record.name)
        ?? stringValue(record.title)
        ?? stringValue(record.directory)?.split("/").filter(Boolean).at(-1)
        ?? id
      return [{ id, label, ...(stringValue(record.directory) ? { directory: stringValue(record.directory)! } : {}) }]
    })
  }

  async function listProjectDirectories(projectId: string): Promise<string[]> {
    const data = await getJson<unknown>(`/project/${encodeURIComponent(projectId)}/directories`)
    if (Array.isArray(data)) return data.filter((item): item is string => typeof item === "string" && item.length > 0)
    if (data && typeof data === "object") {
      const directories = (data as Record<string, unknown>).directories
      if (Array.isArray(directories)) return directories.filter((item): item is string => typeof item === "string" && item.length > 0)
    }
    return []
  }

  async function listAgents(directory?: string): Promise<AgentOption[]> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const data = await getJson<unknown>(`/agent${query}`)
    const agents = flattenAgents(data)
    options.logger?.debug(`OpenCode agent response keys=${describeKeys(data)} parsed=${agents.length}`)
    return agents
  }

  async function listModels(directory?: string): Promise<ModelOption[]> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const data = await getJson<unknown>(`/provider${query}`)
    const models = flattenProviderModels(data)
    options.logger?.debug(`OpenCode provider response keys=${describeKeys(data)} parsed=${models.length}`)
    return models
  }

  async function listSessions(directory: string): Promise<SessionOption[]> {
    const query = `?directory=${encodeURIComponent(directory)}&roots=true&limit=10000`
    const data = await getJson<unknown>(`/session${query}`)
    if (!Array.isArray(data)) return []
    const sessions = data.flatMap(sessionFromItem)
      .filter((session) => sameDirectory(session.directory, directory) && !session.parentId && !session.time?.archived)
    const unique = new Map(sessions.map((session) => [session.id, session]))
    if (data.length >= 10_000) options.logger?.warn("OpenCode session list reached the 10000 item limit")
    return [...unique.values()]
  }

  async function getSession(sessionId: string): Promise<SessionOption | null> {
    const data = await getJson<unknown>(`/session/${encodeURIComponent(sessionId)}`)
    return sessionFromItem(data)[0] ?? null
  }

  async function getVcs(directory: string): Promise<{ branch?: string; defaultBranch?: string }> {
    const data = await getJson<unknown>(`/vcs?directory=${encodeURIComponent(directory)}`)
    if (!data || typeof data !== "object") return {}
    const record = data as Record<string, unknown>
    return {
      ...(stringValue(record.branch) ? { branch: stringValue(record.branch)! } : {}),
      ...(stringValue(record.default_branch) ? { defaultBranch: stringValue(record.default_branch)! } : {}),
    }
  }

  async function listProjectSessions(projectId: string): Promise<Array<{ id: string; directory?: string; time?: { updated?: number } }>> {
    const data = await getJson<unknown>(`/project/${encodeURIComponent(projectId)}/session`)
    const items = Array.isArray(data) ? data : []
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const record = item as Record<string, unknown>
      const id = stringValue(record.id)
      if (!id) return []
      const time = record.time && typeof record.time === "object" ? record.time as { updated?: number } : undefined
      return [{ id, ...(stringValue(record.directory) ? { directory: stringValue(record.directory)! } : {}), ...(time ? { time } : {}) }]
    })
  }

  async function createProjectSession(projectId: string, directory?: string): Promise<CreateProjectSessionResult> {
    const data = await postJson<unknown>(`/project/${encodeURIComponent(projectId)}/session`, directory ? { directory } : {})
    if (!data || typeof data !== "object") throw new Error("OpenCode create project session returned invalid response")
    const record = data as Record<string, unknown>
    const id = stringValue(record.id)
    if (!id) throw new Error("OpenCode create project session returned no id")
    const resolvedDirectory = stringValue(record.directory) ?? directory
    return { sessionId: id, ...(resolvedDirectory ? { directory: resolvedDirectory } : {}) }
  }

  async function abortSession(context: AbortSessionContext): Promise<void> {
    if (context.projectId) {
      const path = `/project/${encodeURIComponent(context.projectId)}/session/${encodeURIComponent(context.sessionId)}/abort`
      try {
        await postJson<unknown>(path)
        return
      } catch (err) {
        options.logger?.warn(`Project scoped abort failed, falling back to global abort: ${err}`)
      }
    }
    await postJson<unknown>(`/session/${encodeURIComponent(context.sessionId)}/abort`)
  }

  async function getConsoleOptions(mapping?: SessionMapping | null): Promise<ConsoleControlOptions> {
    const projects = await listProjects().catch((err) => {
      options.logger?.debug(`OpenCode project list unavailable: ${err}`)
      return []
    })
    const matchedProject = projectForMapping(projects, mapping)
    const directory = mapping?.directory ?? matchedProject?.directory
    let agents = await listAgents(directory).catch((err) => {
      options.logger?.debug(`OpenCode agent list unavailable: ${err}`)
      return []
    })
    if (agents.length === 0) agents = fallbackAgentOptions(mapping)
    let models = await listModels(directory).catch((err) => {
      options.logger?.debug(`OpenCode provider list unavailable: ${err}`)
      return fallbackModelOptions(mapping)
    })
    if (models.length === 0) models = fallbackModelOptions(mapping)
    return { projects, agents, models }
  }

  function fallbackAgentOptions(mapping?: SessionMapping | null): AgentOption[] {
    const ids = new Set<string>()
    if (mapping?.agent) ids.add(mapping.agent)
    for (const agent of options.fallbackAgents ?? []) ids.add(agent)
    return [...ids].map((id) => ({ id, label: id }))
  }

  function fallbackModelOptions(mapping?: SessionMapping | null): ModelOption[] {
    const models = new Map<string, ModelOption>()
    if (mapping?.provider_id && mapping.model_id) {
      const value = `${mapping.provider_id}:${mapping.model_id}`
      models.set(value, { value, providerId: mapping.provider_id, modelId: mapping.model_id, label: value })
    }
    for (const model of options.fallbackModels ?? []) models.set(model.value, model)
    return [...models.values()]
  }

  return {
    listProjects,
    listProjectDirectories,
    listAgents,
    listModels,
    listSessions,
    getSession,
    getVcs,
    listProjectSessions,
    createProjectSession,
    abortSession,
    getConsoleOptions,
  }
}

function projectForMapping(projects: ProjectOption[], mapping?: SessionMapping | null): ProjectOption | undefined {
  if (mapping?.project_id) return projects.find((project) => project.id === mapping.project_id)
  if (!mapping?.directory) return projects[0]
  return projects.find((project) => project.directory === mapping.directory)
    ?? projects.find((project) => project.directory && mapping.directory?.startsWith(`${project.directory}/`))
}

function flattenAgents(data: unknown): AgentOption[] {
  let items: unknown[] = []
  if (Array.isArray(data)) {
    items = data
  } else if (data && typeof data === "object") {
    const root = data as Record<string, unknown>
    if (Array.isArray(root.agents)) {
      items = root.agents
    } else if (stringValue(root.name) || stringValue(root.id)) {
      items = [data]
    } else {
      items = Object.entries(root).map(([name, item]) => (
        item && typeof item === "object" ? { name, ...(item as Record<string, unknown>) } : item
      ))
    }
  }
  return uniqueAgents(items.flatMap(agentFromItem))
}

function agentFromItem(item: unknown): AgentOption[] {
  if (typeof item === "string") return [{ id: item, label: item }]
  if (!item || typeof item !== "object") return []
  const record = item as Record<string, unknown>
  const id = stringValue(record.name) ?? stringValue(record.id)
  if (!id) return []
  if (record.hidden === true || record.mode === "subagent") return []
  return [{ id, label: id }]
}

function uniqueAgents(agents: AgentOption[]): AgentOption[] {
  const byId = new Map<string, AgentOption>()
  for (const agent of agents) if (!byId.has(agent.id)) byId.set(agent.id, agent)
  return [...byId.values()]
}

function flattenProviderModels(data: unknown): ModelOption[] {
  const providers = providerItems(data)
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null
  const connected = root && Array.isArray(root.connected)
    ? new Set(root.connected.filter((item): item is string => typeof item === "string"))
    : null
  const options: ModelOption[] = []
  for (const provider of providers) {
    if (!provider || typeof provider !== "object") continue
    const providerRecord = provider as Record<string, unknown>
    const providerId = stringValue(providerRecord.id) ?? stringValue(providerRecord.name)
    if (!providerId) continue
    if (connected && !connected.has(providerId)) continue
    const models = providerRecord.models
    if (!models || typeof models !== "object" || Array.isArray(models)) continue
    for (const [modelId, rawModel] of Object.entries(models as Record<string, unknown>)) {
      if (!modelId) continue
      const model = rawModel && typeof rawModel === "object" ? rawModel as Record<string, unknown> : {}
      if (model.status === "deprecated") continue
      const resolvedModelId = stringValue(model.id) ?? modelId
      options.push({
        value: `${providerId}:${resolvedModelId}`,
        providerId,
        modelId: resolvedModelId,
        label: `${providerId}/${resolvedModelId}`,
      })
    }
  }
  return options
}

function providerItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== "object") return []
  const root = data as Record<string, unknown>
  if (Array.isArray(root.providers)) return root.providers
  if (Array.isArray(root.all)) return root.all
  if (root.models && typeof root.models === "object") return [data]
  return []
}

function sessionFromItem(item: unknown): SessionOption[] {
  if (!item || typeof item !== "object") return []
  const record = item as Record<string, unknown>
  const id = stringValue(record.id)
  if (!id) return []
  const rawTime = record.time && typeof record.time === "object" ? record.time as Record<string, unknown> : null
  const rawSummary = record.summary && typeof record.summary === "object" ? record.summary as Record<string, unknown> : null
  const rawModel = record.model && typeof record.model === "object" ? record.model as Record<string, unknown> : null
  const providerId = rawModel ? stringValue(rawModel.providerID) ?? stringValue(rawModel.providerId) : undefined
  const modelId = rawModel ? stringValue(rawModel.id) ?? stringValue(rawModel.modelID) ?? stringValue(rawModel.modelId) : undefined
  return [{
    id,
    ...(stringValue(record.title) ? { title: stringValue(record.title)! } : {}),
    ...(stringValue(record.directory) ? { directory: stringValue(record.directory)! } : {}),
    ...(stringValue(record.parentID) ? { parentId: stringValue(record.parentID)! } : {}),
    ...(rawTime ? { time: {
      ...(numberValue(rawTime.created) !== undefined ? { created: numberValue(rawTime.created)! } : {}),
      ...(numberValue(rawTime.updated) !== undefined ? { updated: numberValue(rawTime.updated)! } : {}),
      ...(numberValue(rawTime.archived) !== undefined ? { archived: numberValue(rawTime.archived)! } : {}),
    } } : {}),
    ...(rawSummary && numberValue(rawSummary.files) !== undefined ? { summary: { files: numberValue(rawSummary.files)! } } : {}),
    ...(providerId && modelId ? { model: { providerId, modelId } } : {}),
  }]
}

function describeKeys(data: unknown): string {
  if (Array.isArray(data)) return "array"
  if (!data || typeof data !== "object") return typeof data
  return Object.keys(data as Record<string, unknown>).slice(0, 12).join(",") || "object"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function sameDirectory(left: string | undefined, right: string): boolean {
  const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/, "")
  return left !== undefined && normalize(left) === normalize(right)
}
