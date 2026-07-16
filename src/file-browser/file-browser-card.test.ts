import { describe, expect, it } from "vitest"
import { buildDirectoryCard, buildFileCard } from "./file-browser-card.js"

describe("file browser cards", () => {
  it("renders directory entries with opaque keys", () => {
    const card = buildDirectoryCard({
      sessionId: "ses_0a15227e6ffeV837tzQzDxPBjb",
      path: "src",
      page: 0,
      pageCount: 2,
      viewToken: "view-1",
      entries: [
        { key: "view-1:0", viewToken: "view-1", entry: { name: "handler", path: "src/handler", type: "directory" } },
        { key: "view-1:1", viewToken: "view-1", entry: { name: "index.ts", path: "src/index.ts", type: "file" } },
      ],
    })
    const serialized = JSON.stringify(card)
    expect(card).toHaveProperty("schema", "2.0")
    expect(serialized).toContain("📁  handler")
    expect(serialized).toContain("📄  index.ts")
    expect(serialized).toContain('"entryKey":"view-1:0"')
    expect(serialized).toContain('"viewToken":"view-1"')
    expect(serialized).not.toContain("›")
    expect(serialized).toContain("下一页")
    expect(serialized).toContain("ses_0a15227e6ffeV837tzQzDxPBjb")
    expect(serialized).not.toContain("...")
    expect(serialized).not.toContain("/srv/project")

    const elements = (card as any).body.elements
    const entryRows = elements.filter((element: any) => (
      element.tag === "column_set" && element.margin === "0px 0px 2px 0px"
    ))
    expect(entryRows).toHaveLength(2)
    expect(entryRows.every((row: any) => row.columns.length === 1)).toBe(true)

    const navigationRows = elements.filter((element: any) => (
      element.tag === "column_set" && element.margin === undefined
    ))
    expect(navigationRows).toHaveLength(1)
    expect(navigationRows[0].flex_mode).toBe("none")
    expect(navigationRows[0].columns).toHaveLength(4)
  })

  it("renders line metadata and neutralizes nested code fences", () => {
    const card = buildFileCard({
      path: "src/index.ts",
      page: 0,
      pageCount: 1,
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      content: "const value = 1\n```",
      viewToken: "file-view-1",
    })
    const serialized = JSON.stringify(card)
    expect(serialized).toContain("第 1-2 行，共 2 行")
    expect(serialized).toContain("typescript")
    expect(serialized).toContain("`\u200b``")

    const navigation = (card as any).body.elements.find((element: any) => (
      element.tag === "column_set"
    ))
    expect(navigation.flex_mode).toBe("none")
    expect(navigation.columns).toHaveLength(2)
  })
})
