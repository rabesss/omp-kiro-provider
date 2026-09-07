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
    const id = toOverlayModelId(nonEmptyString(entry.modelId) ?? nonEmptyString(entry.id))
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
  const apiKey = options.apiKey?.trim() ?? ""
  if (!apiKey) return []

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  try {
    const first = await requestCatalog(
      fetchImpl,
      buildListAvailableModelsUrl(options.apiBase),
      apiKey,
      options.overlay,
      timeoutMs,
      maxBodyBytes,
    )
    if (first.kind === "ok") return first.models ?? []
    if (options.profileArn === undefined || options.profileArn === "") return []

    const retry = await requestCatalog(
      fetchImpl,
      buildListAvailableModelsUrl(options.apiBase, "AI_EDITOR", options.profileArn),
      apiKey,
      options.overlay,
      timeoutMs,
      maxBodyBytes,
    )
    if (retry.kind === "ok") return retry.models ?? []
    return []
  } catch {
    return []
  }
}

function copyOverlay(overlay: readonly OverlayModel[]): OverlayModel[] {
  return overlay.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  }))
}

async function requestCatalog(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  overlay: readonly OverlayModel[],
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<{ kind: "ok"; models: OverlayModel[] | null } | { kind: "http" }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    })
    if (!is2xx(response)) return { kind: "http" }
    return {
      kind: "ok",
      models: await modelsFromResponse(response, overlay, maxBodyBytes, controller.signal),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function modelsFromResponse(
  response: Response,
  overlay: readonly OverlayModel[],
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<OverlayModel[] | null> {
  const payload = await readBoundedJson(response, maxBodyBytes, signal)
  if (payload === undefined) return null
  const live = parseLiveModels(payload)
  if (!live || live.length === 0) return null
  return mergeLiveWithOverlay(overlay, live)
}

async function readBoundedJson(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  if (signal.aborted) return undefined
  const declared = response.headers?.get?.("content-length")
  if (declared) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBodyBytes) return undefined
  }

  const stream = response.body
  const bytes = stream && typeof stream.getReader === "function"
    ? await readBoundedStream(stream, maxBodyBytes, signal)
    : await readBoundedBuffer(response, maxBodyBytes, signal)
  if (!bytes) return undefined

  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", onAbort)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) return undefined
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
  return concatBytes(chunks, total)
}

async function readBoundedBuffer(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (signal.aborted) return undefined
  const bytes = typeof response.arrayBuffer === "function"
    ? new Uint8Array(await response.arrayBuffer())
    : new TextEncoder().encode(await response.text())
  if (signal.aborted || bytes.byteLength > maxBodyBytes) return undefined
  return bytes
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function is2xx(response: Response): boolean {
  if (response.ok === true) return true
  return typeof response.status === "number" && response.status >= 200 && response.status < 300
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toOverlayModelId(id: string | undefined): string | undefined {
  return id?.replace(/(\d)\.(\d)(?!\d)/g, "$1-$2")
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
