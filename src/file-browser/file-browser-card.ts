import { extname } from "node:path"
import type { DirectoryCardModel, FileCardModel } from "./types.js"

const MAX_CODE_BYTES = 14 * 1024

export function buildDirectoryCard(model: DirectoryCardModel): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: `**会话**  \`${escapeCode(model.sessionId)}\`\n**路径**  \`${escapeCode(displayPath(model.path))}\``,
    },
    { tag: "hr" },
  ]

  if (model.entries.length === 0) {
    elements.push({ tag: "markdown", content: "_当前目录为空_" })
  } else {
    elements.push(...model.entries.map(buildEntryRow))
  }

  const navigationButtons = [
    ...(model.path !== "." ? [textButton("上一级", "file_browser_parent", model)] : []),
    textButton("根目录", "file_browser_root", model),
    textButton("刷新", "file_browser_refresh", model),
    ...(model.page > 0
      ? [textButton("上一页", "file_browser_page", model, { direction: "previous" })]
      : []),
    ...(model.page + 1 < model.pageCount
      ? [textButton("下一页", "file_browser_page", model, { direction: "next" })]
      : []),
  ]
  elements.push({ tag: "hr" }, navigationRow(navigationButtons))
  elements.push(note(`第 ${model.page + 1}/${model.pageCount} 页`))

  return card("远程文件浏览器", elements)
}

export function buildFileCard(model: FileCardModel): Record<string, unknown> {
  const language = languageForPath(model.path)
  const safeContent = truncateUtf8(model.content.replaceAll("```", "`\u200b``"), MAX_CODE_BYTES)
  const lineLabel = model.totalLines === 0
    ? "空文件"
    : `第 ${model.startLine}-${model.endLine} 行，共 ${model.totalLines} 行`
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: `**文件**  \`${escapeCode(model.path)}\`\n${lineLabel}` },
    { tag: "markdown", content: `\`\`\`${language}\n${safeContent || " "}\n\`\`\`` },
    navigationRow([
      textButton("返回目录", "file_browser_back", model),
      textButton("刷新", "file_browser_refresh", model),
      ...(model.page > 0
        ? [textButton("上一页", "file_browser_page", model, { direction: "previous" })]
        : []),
      ...(model.page + 1 < model.pageCount
        ? [textButton("下一页", "file_browser_page", model, { direction: "next" })]
        : []),
    ]),
    note(`第 ${model.page + 1}/${model.pageCount} 页`),
  ]
  return card("文件预览", elements)
}

export function buildFileBrowserLoadingCard(
  sessionId: string,
  path: string,
  label: string,
): Record<string, unknown> {
  return card("远程文件浏览器", [
    { tag: "markdown", content: `**会话**  \`${escapeCode(sessionId)}\`\n**路径**  \`${escapeCode(displayPath(path))}\`` },
    {
      tag: "div",
      loading: true,
      text: { tag: "plain_text", content: label },
    },
  ])
}

export function buildFileBrowserErrorCard(
  message: string,
  viewToken: string,
): Record<string, unknown> {
  return card("文件浏览失败", [
    { tag: "markdown", content: escapeMarkdown(message) },
    navigationRow([
      textButton("根目录", "file_browser_root", { viewToken }),
      textButton("重试", "file_browser_refresh", { viewToken }),
    ]),
  ], "red")
}

function buildEntryRow(item: DirectoryCardModel["entries"][number]): Record<string, unknown> {
  const value = callbackValue("file_browser_open_entry", item.viewToken, {
    entryKey: item.key,
  })
  return {
    tag: "column_set",
    flex_mode: "none",
    margin: "0px 0px 2px 0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [{
        tag: "button",
        type: "text",
        size: "medium",
        width: "fill",
        text: {
          tag: "plain_text",
          content: `${item.entry.type === "directory" ? "📁" : "📄"}  ${item.entry.name}`,
        },
        behaviors: [{ type: "callback", value }],
      }],
    }],
  }
}

function card(
  title: string,
  elements: Record<string, unknown>[],
  template = "blue",
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  }
}

function textButton(
  label: string,
  action: string,
  model: { viewToken: string },
  extra: Record<string, string> = {},
): Record<string, unknown> {
  return {
    tag: "button",
    type: "text",
    size: "small",
    text: { tag: "plain_text", content: label },
    behaviors: [{ type: "callback", value: callbackValue(action, model.viewToken, extra) }],
  }
}

function callbackValue(
  action: string,
  viewToken: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    action,
    viewToken,
    actionId: `${viewToken}:${action}:${extra.entryKey ?? extra.direction ?? "default"}`,
    ...extra,
  }
}

function navigationRow(actions: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "4px",
    columns: actions.map((action) => ({
      tag: "column",
      width: "auto",
      elements: [action],
    })),
  }
}

function note(content: string): Record<string, unknown> {
  return { tag: "markdown", content: `<text_tag color='grey'>${content}</text_tag>` }
}

function displayPath(path: string): string {
  return path === "." ? "/" : `/${path}`
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_~])/g, "\\$1")
}

function escapeCode(value: string): string {
  return value.replaceAll("`", "\\`")
}

function languageForPath(path: string): string {
  const extension = extname(path).slice(1).toLowerCase()
  const aliases: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
  }
  return aliases[extension] ?? (extension.replace(/[^a-z0-9_-]/g, "") || "text")
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let result = ""
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes - 30) break
    result += char
  }
  return `${result}\n...（本页内容已截断）`
}
