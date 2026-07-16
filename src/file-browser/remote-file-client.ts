import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { RemoteFileClient, RemoteFileEntry } from "./types.js"
import { RemoteFileError } from "./types.js"

interface SdkResult<T> {
  data?: T
  error?: unknown
  response?: Response
}

interface SessionInfo {
  directory?: string
}

interface FileNode {
  name: string
  path: string
  type: "file" | "directory"
  ignored: boolean
}

interface FileContent {
  type: "text" | "binary"
  content: string
}

export function createRemoteFileClient(client: OpencodeClient): RemoteFileClient {
  return {
    async getSessionDirectory(sessionId) {
      const result = await callSdk<SessionInfo>(
        (signal) => client.session.get({ sessionID: sessionId }, { signal }),
        5_000,
      )
      if (!result.directory) throw new RemoteFileError("invalid_response", "会话缺少工作目录")
      return result.directory
    },

    async listDirectory(directory, relativePath) {
      const nodes = await callSdk<FileNode[]>(
        (signal) => client.file.list({ directory, path: relativePath }, { signal }),
        5_000,
      )
      if (!Array.isArray(nodes)) {
        throw new RemoteFileError("invalid_response", "目录响应格式无效")
      }
      return nodes
        .filter((node) => !node.ignored && (node.type === "file" || node.type === "directory"))
        .map<RemoteFileEntry>((node) => ({
          name: node.name,
          path: node.path,
          type: node.type,
        }))
    },

    async readFile(directory, relativePath) {
      const result = await callSdk<FileContent>(
        (signal) => client.file.read({ directory, path: relativePath }, { signal }),
        10_000,
      )
      if (result.type === "binary") {
        throw new RemoteFileError("binary", "该文件不支持文本预览")
      }
      if (result.type !== "text" || typeof result.content !== "string") {
        throw new RemoteFileError("invalid_response", "文件响应格式无效")
      }
      if (Buffer.byteLength(result.content, "utf8") > 1024 * 1024) {
        throw new RemoteFileError("too_large", "文件超过 1 MiB 预览上限")
      }
      return { path: relativePath, content: result.content }
    },
  }
}

async function callSdk<T>(
  request: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let raw: unknown
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new RemoteFileError("timeout", "OpenCode 文件请求超时"))
      }, timeoutMs)
      timer.unref?.()
    })
    raw = await Promise.race([request(controller.signal), timeout])
  } catch (error) {
    if (error instanceof RemoteFileError) throw error
    if (error instanceof Error && error.name === "AbortError") {
      throw new RemoteFileError("timeout", "OpenCode 文件请求超时")
    }
    throw new RemoteFileError("unavailable", "无法连接 OpenCode 服务器")
  } finally {
    if (timer) clearTimeout(timer)
  }

  const result = raw as SdkResult<T>
  if (result.error !== undefined || result.data === undefined) {
    const status = result.response?.status
    if (status === 404) throw new RemoteFileError("not_found", "路径不存在")
    if (status === 401 || status === 403) throw new RemoteFileError("forbidden", "无权读取该路径")
    throw new RemoteFileError("unavailable", "OpenCode 文件请求失败")
  }
  return result.data
}
