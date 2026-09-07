export type OverlayModel = {
  id: string
  name: string
  reasoning: boolean
  reasoningHidden?: boolean
  input: ("text" | "image")[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export type LiveModel = {
  id: string
  name: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
}

export type FetchDynamicKiroModelsOptions = {
  apiKey?: string
  apiBase: string
  overlay: readonly OverlayModel[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
  profileArn?: string
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8192

export function buildListAvailableModelsUrl(
  apiBase: string,
  origin = "AI_EDITOR",
  profileArn?: string,
): string {
  const url = new URL(`${apiBase.replace(/\/+$/, "")}/ListAvailableModels`)
  url.searchParams.set("origin", origin)
  if (profileArn !== undefined && profileArn !== "") {
    url.searchParams.set("profileArn", profileArn)
  }
  return url.toString()
}

export function parseLiveModels(payload: unknown): LiveModel[] | null {
  if (!isRecord(payload)) return null
  const raw = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.availableModels)
      ? payload.availableModels
      : null
  if (!raw) return null

  const models: LiveModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = nonEmptyString(entry.modelId) ?? nonEmptyString(entry.id)
    if (!id || seen.has(id)) continue
    seen.add(id)

    const live: LiveModel = {
      id,
      name: nonEmptyString(entry.modelName) ?? nonEmptyString(entry.name) ?? id,
    }
    const reasoning = readLiveReasoning(entry)
    if (reasoning !== undefined) live.reasoning = reasoning
    const limits = isRecord(entry.tokenLimits) ? entry.tokenLimits : undefined
    if (limits) {
      const contextWindow = positiveInt(limits.maxInputTokens)
      const maxTokens = positiveInt(limits.maxOutputTokens)
      if (contextWindow !== undefined) live.contextWindow = contextWindow
      if (maxTokens !== undefined) live.maxTokens = maxTokens
    }
    models.push(live)
  }
  return models
}

export function mergeLiveWithOverlay(
  overlay: readonly OverlayModel[],
  live: readonly LiveModel[],
): OverlayModel[] {
  const overlayById = new Map(overlay.map((model) => [model.id, model]))
  const result = copyOverlay(overlay)
  for (const item of live) {
    if (overlayById.has(item.id)) continue
    const unknown: OverlayModel = {
      id: item.id,
      name: item.name || item.id,
      reasoning: item.reasoning === true,
      input: ["text"],
      contextWindow: item.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: item.maxTokens ?? DEFAULT_MAX_TOKENS,
      cost: { ...ZERO_COST },
    }
    overlayById.set(item.id, unknown)
    result.push(unknown)
  }
  return result
}

export async function fetchDynamicKiroModels(
  options: FetchDynamicKiroModelsOptions,
): Promise<OverlayModel[]> {
  const fallback = () => copyOverlay(options.overlay)
  const apiKey = options.apiKey?.trim() ?? ""
  if (!apiKey) return fallback()

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  try {
    const first = await getListAvailableModels(
      fetchImpl,
      buildListAvailableModelsUrl(options.apiBase),
      apiKey,
      timeoutMs,
    )
    if (is2xx(first)) return (await modelsFromResponse(first, options.overlay, maxBodyBytes)) ?? fallback()
    if (options.profileArn === undefined || options.profileArn === "") return fallback()

    const retry = await getListAvailableModels(
      fetchImpl,
      buildListAvailableModelsUrl(options.apiBase, "AI_EDITOR", options.profileArn),
      apiKey,
      timeoutMs,
    )
    if (is2xx(retry)) return (await modelsFromResponse(retry, options.overlay, maxBodyBytes)) ?? fallback()
    return fallback()
  } catch {
    return fallback()
  }
}

function copyOverlay(overlay: readonly OverlayModel[]): OverlayModel[] {
  return overlay.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  }))
}

async function getListAvailableModels(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function modelsFromResponse(
  response: Response,
  overlay: readonly OverlayModel[],
  maxBodyBytes: number,
): Promise<OverlayModel[] | null> {
  const payload = await readBoundedJson(response, maxBodyBytes)
  if (payload === undefined) return null
  const live = parseLiveModels(payload)
  if (!live || live.length === 0) return null
  return mergeLiveWithOverlay(overlay, live)
}

async function readBoundedJson(response: Response, maxBodyBytes: number): Promise<unknown | undefined> {
  const declared = response.headers?.get?.("content-length")
  if (declared) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBodyBytes) return undefined
  }

  const bytes = typeof response.arrayBuffer === "function"
    ? new Uint8Array(await response.arrayBuffer())
    : new TextEncoder().encode(await response.text())
  if (bytes.byteLength > maxBodyBytes) return undefined

  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

function is2xx(response: Response): boolean {
  if (response.ok === true) return true
  return typeof response.status === "number" && response.status >= 200 && response.status < 300
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function readLiveReasoning(item: Record<string, unknown>): boolean | undefined {
  if (typeof item.reasoning === "boolean") return item.reasoning
  if (typeof item.thinking === "boolean") return item.thinking
  if (typeof item.supportsThinking === "boolean") return item.supportsThinking
  const capabilities = item.capabilities
  if (isRecord(capabilities) && typeof capabilities.thinking === "boolean") return capabilities.thinking
  return undefined
}
