import { describe, expect, it } from "vitest"
import {
  isSensitivePath,
  joinBrowserPath,
  normalizeBrowserPath,
  parentBrowserPath,
} from "./path-policy.js"

describe("file browser path policy", () => {
  it("normalizes project-relative paths", () => {
    expect(normalizeBrowserPath("./src//handler")).toBe("src/handler")
    expect(normalizeBrowserPath(".")).toBe(".")
    expect(parentBrowserPath("src/handler")).toBe("src")
    expect(parentBrowserPath("src")).toBe(".")
    expect(joinBrowserPath("src", "handler")).toBe("src/handler")
  })

  it.each(["/etc/passwd", "../secret", "a/../../secret", "a\\b", "a\0b"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizeBrowserPath(path)).toThrow(),
  )

  it("rejects invalid directory entry names", () => {
    expect(() => joinBrowserPath("src", "../secret")).toThrow()
    expect(() => joinBrowserPath("src", "a/b")).toThrow()
  })

  it.each([".env", ".env.local", "keys/server.pem", "id_rsa", "cert.p12"])(
    "detects sensitive path %s",
    (path) => expect(isSensitivePath(path)).toBe(true),
  )
})
