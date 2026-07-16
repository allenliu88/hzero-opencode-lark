import { describe, expect, it, vi } from "vitest"
import { createRemoteFileClient } from "./remote-file-client.js"

function createClient() {
  return {
    session: { get: vi.fn() },
    file: { list: vi.fn(), read: vi.fn() },
  }
}

describe("createRemoteFileClient", () => {
  it("normalizes session, directory, and text responses", async () => {
    const sdk = createClient()
    sdk.session.get.mockResolvedValue({ data: { directory: "/srv/project" } })
    sdk.file.list.mockResolvedValue({
      data: [
        { name: "src", path: "src", absolute: "/srv/project/src", type: "directory", ignored: false },
        { name: "node_modules", path: "node_modules", absolute: "/srv/project/node_modules", type: "directory", ignored: true },
      ],
    })
    sdk.file.read.mockResolvedValue({ data: { type: "text", content: "hello" } })
    const client = createRemoteFileClient(sdk as never)

    expect(await client.getSessionDirectory("ses-1")).toBe("/srv/project")
    expect(await client.listDirectory("/srv/project", ".")).toEqual([
      { name: "src", path: "src", type: "directory" },
    ])
    expect(await client.readFile("/srv/project", "README.md")).toEqual({
      path: "README.md",
      content: "hello",
    })
  })

  it("rejects binary and oversized files", async () => {
    const sdk = createClient()
    const client = createRemoteFileClient(sdk as never)
    sdk.file.read.mockResolvedValueOnce({ data: { type: "binary", content: "" } })
    await expect(client.readFile("/srv/project", "image.png")).rejects.toMatchObject({ code: "binary" })

    sdk.file.read.mockResolvedValueOnce({ data: { type: "text", content: "a".repeat(1024 * 1024 + 1) } })
    await expect(client.readFile("/srv/project", "large.txt")).rejects.toMatchObject({ code: "too_large" })
  })

  it("maps API status errors without leaking the response", async () => {
    const sdk = createClient()
    sdk.file.list.mockResolvedValue({ error: { message: "secret body" }, response: { status: 404 } })
    const client = createRemoteFileClient(sdk as never)

    await expect(client.listDirectory("/srv/project", "missing")).rejects.toMatchObject({
      code: "not_found",
      message: "路径不存在",
    })
  })

  it("aborts a directory request after the timeout", async () => {
    vi.useFakeTimers()
    const sdk = createClient()
    sdk.file.list.mockImplementation((_parameters, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    }))
    const client = createRemoteFileClient(sdk as never)
    const request = client.listDirectory("/srv/project", ".")
    const rejection = expect(request).rejects.toMatchObject({ code: "timeout" })

    await vi.advanceTimersByTimeAsync(5_000)
    await rejection
    vi.useRealTimers()
  })
})
