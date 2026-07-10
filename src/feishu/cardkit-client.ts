export interface CardKitSchema {
  schema: "2.0"
  header?: {
    title: { tag: "plain_text" | "lark_md"; content: string }
    subtitle?: { tag: "plain_text" | "lark_md"; content: string }
    template?: string
  }
  config: {
    streaming_mode: boolean
    summary: { content: string }
    width_mode?: "default" | "compact" | "fill"
    streaming_config?: {
      print_frequency_ms: { default: number; android?: number; ios?: number; pc?: number }
      print_step: { default: number; android?: number; ios?: number; pc?: number }
      print_strategy?: "fast" | "delay"
    }
  }
  body: {
    elements: CardElement[]
  }
}

export interface CardElement {
  tag: string
  content?: string
  element_id?: string
  [key: string]: unknown
}

export type CardKitStreamingConfig = NonNullable<CardKitSchema["config"]["streaming_config"]>

export class CardKitError extends Error {
  code: number
  status?: number

  constructor(code: number, message: string, status?: number) {
    super(message)
    this.name = "CardKitError"
    this.code = code
    this.status = status
  }
}

const DEFAULT_API_BASE = "https://open.feishu.cn/open-apis"
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 2_000] as const
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504])
const RETRYABLE_API_CODES = new Set([200810])

interface TokenState {
  token: string
  expiresAt: number
}

interface ApiResponse {
  code: number
  msg: string
  data?: Record<string, unknown>
}

export class CardKitClient {
  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBase: string
  private readonly requestTimeoutMs: number
  private readonly retryDelaysMs: readonly number[]
  private tokenState: TokenState | null = null
  private refreshPromise: Promise<string> | null = null

  constructor(options: {
    appId: string
    appSecret: string
    apiBase?: string
    requestTimeoutMs?: number
    retryDelaysMs?: readonly number[]
  }) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  }

  async createCard(cardJson: CardKitSchema): Promise<string> {
    const res = await this.apiRequest("POST", "/cardkit/v1/cards", {
      type: "card_json",
      data: JSON.stringify(cardJson),
    })

    const cardId = res.data?.card_id
    if (typeof cardId !== "string") {
      throw new CardKitError(res.code, "Missing card_id in response")
    }
    return cardId
  }

  async updateElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.apiRequest(
      "PUT",
      `/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
      { content, sequence, uuid: `s_${cardId}_${sequence}` },
    )
  }

  async closeStreaming(
    cardId: string,
    summary: string,
    sequence: number,
  ): Promise<void> {
    await this.apiRequest("PATCH", `/cardkit/v1/cards/${cardId}/settings`, {
      settings: JSON.stringify({
        config: { streaming_mode: false, summary: { content: summary } },
      }),
      sequence,
      uuid: `c_${cardId}_${sequence}`,
    })
  }

  async pauseStreaming(
    cardId: string,
    summary: string,
    sequence: number,
  ): Promise<void> {
    await this.apiRequest("PATCH", `/cardkit/v1/cards/${cardId}/settings`, {
      settings: JSON.stringify({
        config: { streaming_mode: false, summary: { content: summary } },
      }),
      sequence,
      uuid: `p_${cardId}_${sequence}`,
    })
  }

  async insertElements(
    cardId: string,
    elements: CardElement[],
    sequence: number,
    targetElementId?: string,
  ): Promise<void> {
    await this.apiRequest("POST", `/cardkit/v1/cards/${cardId}/elements`, {
      type: targetElementId ? "insert_after" : "append",
      ...(targetElementId ? { target_element_id: targetElementId } : {}),
      elements: JSON.stringify(elements),
      sequence,
      uuid: `i_${cardId}_${sequence}`,
    })
  }

  async deleteElement(
    cardId: string,
    elementId: string,
    sequence: number,
  ): Promise<void> {
    await this.apiRequest("DELETE", `/cardkit/v1/cards/${cardId}/elements/${elementId}`, {
      sequence,
      uuid: `d_${cardId}_${sequence}`,
    })
  }

  async renewStreaming(
    cardId: string,
    sequence: number,
    streamingConfig: CardKitStreamingConfig,
  ): Promise<void> {
    await this.apiRequest("PATCH", `/cardkit/v1/cards/${cardId}/settings`, {
      settings: JSON.stringify({
        config: { streaming_mode: true, streaming_config: streamingConfig },
      }),
      sequence,
      uuid: `r_${cardId}_${sequence}`,
    })
  }

  private async getToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenState && this.tokenState.expiresAt - now > 300_000) {
      return this.tokenState.token
    }

    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refreshToken()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async refreshToken(): Promise<string> {
    const res = await this.fetchWithTimeout(
      `${this.apiBase}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      },
    )

    const data = await parseJsonResponse<{
      code: number
      msg: string
      tenant_access_token?: string
      expire?: number
    }>(res)

    if (res.ok === false || data.code !== 0 || !data.tenant_access_token) {
      throw new CardKitError(data.code, `Token error: ${data.msg}`, res.status)
    }

    this.tokenState = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
    }
    return this.tokenState.token
  }

  private async apiRequest(
    method: string,
    urlPath: string,
    body: Record<string, unknown>,
    tokenRetryCount = 0,
    transientRetryCount = 0,
  ): Promise<ApiResponse> {
    const token = await this.getToken()

    let res: Response
    try {
      res = await this.fetchWithTimeout(`${this.apiBase}${urlPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      if (transientRetryCount < this.retryDelaysMs.length) {
        await delay(this.retryDelaysMs[transientRetryCount]!)
        return this.apiRequest(method, urlPath, body, tokenRetryCount, transientRetryCount + 1)
      }
      throw err
    }

    if (RETRYABLE_HTTP_STATUSES.has(res.status) && transientRetryCount < this.retryDelaysMs.length) {
      await delay(resolveRetryDelay(res, this.retryDelaysMs[transientRetryCount]!))
      return this.apiRequest(method, urlPath, body, tokenRetryCount, transientRetryCount + 1)
    }

    const data = await parseJsonResponse<ApiResponse>(res)

    if (RETRYABLE_API_CODES.has(data.code) && transientRetryCount < this.retryDelaysMs.length) {
      await delay(this.retryDelaysMs[transientRetryCount]!)
      return this.apiRequest(method, urlPath, body, tokenRetryCount, transientRetryCount + 1)
    }

    if (data.code === 99991663 && tokenRetryCount < 1) {
      this.tokenState = null
      return this.apiRequest(method, urlPath, body, tokenRetryCount + 1, transientRetryCount)
    }

    if (res.ok === false || data.code !== 0) {
      throw new CardKitError(data.code, data.msg, res.status)
    }

    return data
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timer.unref?.()
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

async function parseJsonResponse<T extends { code: number; msg: string }>(res: Response): Promise<T> {
  try {
    return await res.json() as T
  } catch {
    throw new CardKitError(-1, `CardKit returned a non-JSON response (HTTP ${res.status})`, res.status)
  }
}

function resolveRetryDelay(res: Response, fallbackMs: number): number {
  const retryAfter = res.headers?.get?.("retry-after")
  if (!retryAfter) return fallbackMs
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : fallbackMs
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
