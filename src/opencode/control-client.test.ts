import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpencodeControlClient } from "./control-client.js"

describe("opencode control client", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("uses directory-scoped OpenCode Web APIs and filters selectable agents and models", async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/project")) return new Response(JSON.stringify([{ id: "proj-1", name: "repo", directory: "/repo" }]))
      if (url.includes("/agent?")) return new Response(JSON.stringify([
        { name: "build", mode: "primary" },
        { name: "review", mode: "all" },
        { name: "explore", mode: "subagent" },
        { name: "hidden", mode: "primary", hidden: true },
      ]))
      if (url.includes("/provider?")) return new Response(JSON.stringify({
        connected: ["anthropic"],
        all: [
          { id: "anthropic", models: { sonnet: { id: "sonnet", status: "active" }, old: { id: "old", status: "deprecated" } } },
          { id: "openai", models: { gpt: { id: "gpt", status: "active" } } },
        ],
      }))
      return new Response("not found", { status: 404 })
    })

    const client = createOpencodeControlClient({ serverUrl: "http://127.0.0.1:4096" })
    await expect(client.getConsoleOptions({
      feishu_key: "chat-1", session_id: "ses-1", agent: "build", directory: "/repo", created_at: 1, last_active: 1,
    })).resolves.toEqual({
      projects: [{ id: "proj-1", label: "repo", directory: "/repo" }],
      agents: [{ id: "build", label: "build" }, { id: "review", label: "review" }],
      models: [{ value: "anthropic:sonnet", providerId: "anthropic", modelId: "sonnet", label: "anthropic/sonnet" }],
    })
    expect(calls).toContain("http://127.0.0.1:4096/agent?directory=%2Frepo")
    expect(calls).toContain("http://127.0.0.1:4096/provider?directory=%2Frepo")
  })

  it("lists root unarchived sessions for the exact directory", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "ses-1", directory: "/repo", title: "Current", time: { updated: 3 } },
      { id: "ses-child", directory: "/repo", parentID: "ses-1", time: { updated: 2 } },
      { id: "ses-archived", directory: "/repo", time: { updated: 1, archived: 4 } },
      { id: "ses-other", directory: "/other", time: { updated: 5 } },
    ])))
    const client = createOpencodeControlClient({ serverUrl: "http://127.0.0.1:4096" })
    await expect(client.listSessions("/repo")).resolves.toEqual([
      { id: "ses-1", directory: "/repo", title: "Current", time: { updated: 3 } },
    ])
    expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:4096/session?directory=%2Frepo&roots=true&limit=10000")
  })

  it("gets session and VCS context", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes("/session/")) return new Response(JSON.stringify({
        id: "ses-1",
        title: "Work",
        directory: "/repo",
        model: { providerID: "anthropic", id: "claude-sonnet-4" },
      }))
      return new Response(JSON.stringify({ branch: "main", default_branch: "main" }))
    })
    const client = createOpencodeControlClient({ serverUrl: "http://127.0.0.1:4096" })
    await expect(client.getSession("ses-1")).resolves.toEqual({
      id: "ses-1",
      title: "Work",
      directory: "/repo",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
    })
    await expect(client.getVcs("/repo")).resolves.toEqual({ branch: "main", defaultBranch: "main" })
  })

  it("falls back to mapping agent and model when APIs are unavailable", async () => {
    globalThis.fetch = vi.fn(async (input) => String(input).endsWith("/project")
      ? new Response(JSON.stringify([]))
      : new Response("not found", { status: 404 }))
    const client = createOpencodeControlClient({ serverUrl: "http://127.0.0.1:4096", fallbackAgents: ["build"] })
    await expect(client.getConsoleOptions({
      feishu_key: "chat-1", session_id: "ses-1", agent: "review", provider_id: "anthropic", model_id: "sonnet", created_at: 1, last_active: 1,
    })).resolves.toMatchObject({
      agents: [{ id: "review", label: "review" }, { id: "build", label: "build" }],
      models: [{ value: "anthropic:sonnet", providerId: "anthropic", modelId: "sonnet", label: "anthropic:sonnet" }],
    })
  })

  it("falls back from project scoped abort to global abort", async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("/project/")) return new Response("missing", { status: 404 })
      return new Response(JSON.stringify({ ok: true }))
    })
    const client = createOpencodeControlClient({ serverUrl: "http://127.0.0.1:4096" })
    await client.abortSession({ projectId: "proj-1", sessionId: "ses-1" })
    expect(calls).toEqual([
      "http://127.0.0.1:4096/project/proj-1/session/ses-1/abort",
      "http://127.0.0.1:4096/session/ses-1/abort",
    ])
  })
})
