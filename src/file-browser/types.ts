export interface RemoteFileEntry {
  name: string
  path: string
  type: "file" | "directory"
}

export interface RemoteFileContent {
  path: string
  content: string
}

export interface RemoteFileClient {
  getSessionDirectory(sessionId: string): Promise<string>
  listDirectory(directory: string, relativePath: string): Promise<RemoteFileEntry[]>
  readFile(directory: string, relativePath: string): Promise<RemoteFileContent>
}

export class RemoteFileError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "binary"
      | "too_large"
      | "timeout"
      | "invalid_response"
      | "unavailable",
    message: string,
  ) {
    super(message)
    this.name = "RemoteFileError"
  }
}

export interface FileBrowserEntryAction {
  key: string
  viewToken: string
  entry: RemoteFileEntry
}

export interface DirectoryCardModel {
  sessionId: string
  path: string
  page: number
  pageCount: number
  viewToken: string
  entries: FileBrowserEntryAction[]
}

export interface FileCardModel {
  path: string
  page: number
  pageCount: number
  startLine: number
  endLine: number
  totalLines: number
  content: string
  viewToken: string
}
