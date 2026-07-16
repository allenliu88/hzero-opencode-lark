import { posix } from "node:path"

const SENSITIVE_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519)$/i,
  /\.(?:pem|key|p12|pfx)$/i,
]

export function normalizeBrowserPath(raw: string): string {
  const value = raw.trim()
  if (!value || value === ".") return "."
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new Error("路径必须是项目内的相对路径")
  }

  const normalized = posix.normalize(value).replace(/^\.\//, "")
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("路径不能超出项目根目录")
  }
  return normalized || "."
}

export function joinBrowserPath(parent: string, child: string): string {
  if (!child || child === "." || child === ".." || child.includes("/") || child.includes("\\")) {
    throw new Error("目录项名称无效")
  }
  return normalizeBrowserPath(parent === "." ? child : posix.join(parent, child))
}

export function parentBrowserPath(path: string): string {
  const normalized = normalizeBrowserPath(path)
  if (normalized === ".") return "."
  const parent = posix.dirname(normalized)
  return parent === "." ? "." : parent
}

export function isSensitivePath(path: string): boolean {
  const name = posix.basename(path)
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name))
}
