/**
 * Kiro stream factory — core streaming logic.
 *
 * Supports:
 * - AWS Event Stream binary response decoding
 * - 429/5xx retry with exponential backoff
 * - INSUFFICIENT_MODEL_CAPACITY inner retry (common on free tier)
 * - First-token timeout (180s) + idle stream timeout (300s)
 * - Empty response detection with retry
 * - Account profile resolution for OAuth and API keys
 * - Ban detection (TEMPORARILY_SUSPENDED) in HTTP errors and stream error frames
 * - Live event emission with retry buffering before the first visible delta
 */

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ContextLike,
  CoreDependencies,
  ErrorReason,
  ModelLike,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  Usage,
} from "./types.ts"
import { buildKiroPayload, resolveToolName } from "./converters.ts"
import { AwsEventStreamParser, type StreamErrorEvent } from "./eventstream.ts"
import { ThinkingTagParser } from "./thinking-parser.ts"
import { parseBracketToolCalls } from "./bracket-tool-parser.ts"
import { kiroBaseForRegion, kiroRegionFromProfileArn, resolveKiroProfileArn } from "./dynamic-models.ts"
import { isKiroApiKey, kiroTokenTypeHeaders } from "./auth/token-type.ts"

export * from "./converters.ts"
export * from "./eventstream.ts"
export * from "./types.ts"


// Retry / timeout configuration
const MAX_HTTP_RETRIES = 1           // transient 5xx retries; 429 is backpressure
const MAX_CAPACITY_RETRIES = 3       // INSUFFICIENT_MODEL_CAPACITY retries
const MAX_EMPTY_RETRIES = 2          // empty response retries
const FIRST_TOKEN_TIMEOUT_MS = 180_000  // 3 minutes to get first content
const IDLE_STREAM_TIMEOUT_MS = 300_000  // Match native kiro-cli's 5-minute operation timeout
const CONNECTION_TIMEOUT_MS = 120_000    // 2 min for initial connection
const MAX_CACHED_PROFILES = 32          // tokens rotate, so old entries are dead weight
const KIRO_STREAM_GATE_POLL_MS = 500
const KIRO_STREAM_GATE_HEARTBEAT_MS = 15_000
const KIRO_STREAM_GATE_STALE_MS = 10 * 60_000
const KIRO_STREAM_GATE_ROOT = join(tmpdir(), "omp-kiro-provider")
const KIRO_STREAM_GATE_DIR = join(KIRO_STREAM_GATE_ROOT, "stream.lock")
const KIRO_STREAM_GATE_OWNER = join(KIRO_STREAM_GATE_DIR, "owner.json")

// Thinking / reasoning configuration
const HIDDEN_REASONING_COUNTDOWN_MS = 2000  // ms before showing "reasoning hidden" marker
const HIDDEN_REASONING_PLACEHOLDER = "Reasoning hidden by provider"

/** Map reasoning level to thinking budget in tokens. */
function thinkingBudget(level: boolean | string | undefined): number {
  if (level === "max" || level === "xhigh") return 50000
  if (level === "high") return 30000
  if (level === "medium") return 20000
  return 10000 // default / "minimal" / "low" / true
}

const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
type ReasoningLevel = boolean | (typeof REASONING_LEVELS)[number]

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "boolean" || (REASONING_LEVELS as readonly unknown[]).includes(value)
}

function readReasoningField(source: unknown, key: string): ReasoningLevel | undefined {
  if (!source || typeof source !== "object") return undefined
  const value = (source as Record<string, unknown>)[key]
  return isReasoningLevel(value) ? value : undefined
}

export function shouldRetryHttpStatus(status: number): boolean {
  if (status === 429) return false
  return status >= 500
}

export function resolveReasoningLevel(model: Pick<ModelLike, "id" | "name">, options?: StreamOptions): ReasoningLevel | undefined {
  // OMP signals "thinking off" by disabling reasoning rather than by name.
  if (options?.disableReasoning === true) return false

  const direct = readReasoningField(options, "reasoning")
  if (direct !== undefined) return direct

  const legacy = readReasoningField(options, "reasoningEffort")
  if (legacy !== undefined) return legacy

  const metadata = options && typeof options === "object" ? (options as Record<string, unknown>).metadata : undefined
  const metadataReasoning = readReasoningField(metadata, "reasoning") ?? readReasoningField(metadata, "reasoningEffort")
  if (metadataReasoning !== undefined) return metadataReasoning

  const selector = `${model.id}:${model.name}`
  const match = selector.match(/:(xhigh|high|medium|low|minimal|max|off)(?:\b|$)/)
  return match ? (match[1] as Exclude<ReasoningLevel, boolean>) : undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function abortError(message = "The operation was aborted"): DOMException {
  return new DOMException(message, "AbortError")
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((v, k) => { out[k] = v })
  return out
}

/** Custom error for retryable stream-level failures. */
class RetryableError extends Error {
  constructor(message: string) { super(message) }
}

/** The error to fail a turn with when Kiro reports `event` mid-stream. */
function streamFailure(event: StreamErrorEvent): Error {
  if (`${event.errorType} ${event.message}`.includes("TEMPORARILY_SUSPENDED")) {
    return new Error(`Kiro account suspended (detected in stream): ${event.message.slice(0, 200)}`)
  }
  const message = `Kiro stream error (${event.errorType}): ${event.message.slice(0, 300)}`
  // Only a server-side failure is worth retrying; throttling is backpressure and a
  // validation error fails the same way again.
  return /unavailable|internal/i.test(event.errorType) ? new RetryableError(message) : new Error(message)
}

/** Read fresh access token from kiro-cli's SQLite database. */
function tryReadCliToken(): string | undefined {
  try {
    const db = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3")
    if (!existsSync(db)) return undefined
    const raw = execSync(
      `sqlite3 ${JSON.stringify(db)} "SELECT value FROM auth_kv WHERE key='kirocli:odic:token' LIMIT 1"`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    if (!raw) return undefined
    const tok = JSON.parse(raw) as { access_token?: string; expires_at?: string | number }
    if (tok.access_token) {
      const expMs = typeof tok.expires_at === "string" ? new Date(tok.expires_at).getTime() : (tok.expires_at ?? 0) * 1000
      if (!tok.expires_at || expMs > Date.now() + 60_000) {
        return tok.access_token
      }
    }
  } catch { /* kiro-cli DB unavailable */ }
  return undefined
}

/** Ask kiro-cli to resync its Builder ID session, then reread its token. */
function resyncCliToken(): string | undefined {
  try {
    execSync("kiro-cli whoami", { stdio: "ignore", timeout: 15_000 })
  } catch {
    return undefined
  }
  return tryReadCliToken()
}

// ---------------------------------------------------------------------------
// Build headers for Kiro API request
// ---------------------------------------------------------------------------

export function buildKiroHeaders(accessToken: string): Record<string, string> {
  // Impersonate Kiro CLI (rust SDK) — matches mikeyobrien, hongyilyu, MasuRii
  const mid = randomUUID().replace(/-/g, "")
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    "Accept": "application/json",
    "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "User-Agent": ua,
    "x-amz-user-agent": ua,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-invocation-id": randomUUID(),
    "amz-sdk-request": "attempt=1; max=1",
    ...kiroTokenTypeHeaders(accessToken),
  }
}
// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

export function createStreamKiro(deps: CoreDependencies) {
  const apiBase = deps.apiBase
  const managementBase = deps.managementBase ?? apiBase.replace(/^(https?:\/\/)runtime\./, "$1management.")
  const profileArnCache = new Map<string, string>()
  // Models whose reasoning stays server-side, as listed in models.json.
  const hiddenReasoningModels = new Set(deps.hiddenReasoningModels ?? [])
  const fetchImpl = deps.fetchImpl ?? fetch
  const cwd = deps.cwd ?? (() => process.cwd())
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? (() => randomUUID())

  function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError())
      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  }

  /** Sleep that respects abort signal and cleans up timer on abort. */
  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(abortError())
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        if (settled) return
        clearTimeout(timer)
        reject(abortError())
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  async function acquireKiroStreamGate(signal: AbortSignal): Promise<() => void> {
    const env = deps.env ?? process.env
    if (env.OMP_KIRO_STREAM_GATE === "0" || env.KIRO_STREAM_GATE === "0") {
      return () => {}
    }

    const token = `${process.pid}:${randomUUID()}`
    const owner = {
      token,
      pid: process.pid,
      cwd: cwd(),
      startedAt: new Date().toISOString(),
    }

    for (;;) {
      if (signal.aborted) throw abortError()
      try {
        mkdirSync(KIRO_STREAM_GATE_ROOT, { recursive: true })
        mkdirSync(KIRO_STREAM_GATE_DIR)
        const heartbeat = () => {
          writeFileSync(KIRO_STREAM_GATE_OWNER, JSON.stringify({ ...owner, heartbeatAt: new Date().toISOString() }))
        }
        heartbeat()
        const heartbeatTimer = setInterval(heartbeat, KIRO_STREAM_GATE_HEARTBEAT_MS)
        return () => {
          clearInterval(heartbeatTimer)
          try {
            const currentOwner = JSON.parse(readFileSync(KIRO_STREAM_GATE_OWNER, "utf-8")) as { token?: string }
            if (currentOwner.token === token) {
              rmSync(KIRO_STREAM_GATE_DIR, { recursive: true, force: true })
            }
          } catch { /* already released or replaced */ }
        }
      } catch (error: unknown) {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
        if (code !== "EEXIST") throw error

        let stale = false
        try {
          const stat = statSync(KIRO_STREAM_GATE_OWNER)
          stale = Date.now() - stat.mtimeMs > KIRO_STREAM_GATE_STALE_MS
        } catch {
          stale = true
        }
        if (stale) {
          rmSync(KIRO_STREAM_GATE_DIR, { recursive: true, force: true })
          continue
        }

        await sleep(KIRO_STREAM_GATE_POLL_MS + Math.floor(Math.random() * 250), signal)
      }
    }
  }

  return function streamKiro(
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike {
    const stream = deps.createStream()

    async function run() {
      // Credential resolution strategy:
      // 1. kiro-cli SQLite DB (always fresh — kiro-cli manages its own token refresh)
      // 2. options.apiKey from OMP (may be stale if OMP's refresh didn't fire)
      //    - Could be a raw access token string (OMP called getApiKey first)
      //    - Or the full JSON credential blob (OMP passed raw data)
      // 3. KIRO_API_KEY env var
      let apiKey: string | undefined

      // Always try kiro-cli DB first — it has the freshest Builder ID token
      const cliToken = tryReadCliToken()
      if (cliToken) {
        apiKey = cliToken
      } else if (options?.apiKey) {
        apiKey = options.apiKey
        // Extract access token from JSON blob if OMP passed raw credentials
        if (apiKey.startsWith("{")) {
          try {
            const parsed = JSON.parse(apiKey) as Record<string, unknown>
            if (typeof parsed.access === "string") apiKey = parsed.access
          } catch { /* not JSON — use as-is */ }
        }
      }

      // Environment variable fallback
      if (!apiKey) apiKey = deps.env?.KIRO_API_KEY
      // Discovery trims the key too; a stray space would hide the ksk_ prefix.
      apiKey = apiKey?.trim()



      if (!apiKey) {
        const msg: AssistantMessageLike = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: defaultUsage(),
          stopReason: "error",
          errorMessage:
            "No Kiro access token. Run /login and select Kiro, or set KIRO_API_KEY.",
          timestamp: now(),
        }
        stream.push({ type: "error", reason: "error", error: msg })
        stream.end()
        return
      }

      const output: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "stop",
        timestamp: now(),
      }

      const controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let releaseKiroStreamGate: (() => void) | undefined

      // Read auth metadata to route profileArn correctly
      const metaRaw = (() => {
        try {
          const p = join(homedir(), ".omp", "agent", "kiro-auth-meta.json")
          if (!existsSync(p)) return null
          return JSON.parse(readFileSync(p, "utf-8")) as { method?: string; profileArn?: string; region?: string }
        } catch { return null }
      })()

      const abortUpstream = () => {
        if (!controller.signal.aborted) controller.abort()
        try { reader?.cancel().catch(() => undefined) } catch { /* best effort */ }
      }

      if (options?.signal?.aborted) {
        abortUpstream()
      } else {
        options?.signal?.addEventListener("abort", abortUpstream, { once: true })
      }

      // Per-attempt output state — separate from `output` so we can discard on retry
      let textBlock: TextContent | undefined
      let currentTextIdx = -1
      let reasoningBlock: ThinkingContent | undefined
      let currentReasoningIdx = -1
      // Assigned once per request (before the retry loops); read by handleEvent.
      let thinkingEnabled = false
      let reasoningHidden = false
      let currentToolCall: { id: string; name: string; inputChunks: string[] } | undefined
      let thinkingParser: ThinkingTagParser | null = null

      // Per-attempt staging buffer. Drain it as parsed events arrive so OMP
      // renders live progress, but only retry while nothing visible has escaped.
      let eventBuffer: AssistantMessageEvent[] = []
      let attemptEventsFlushed = false
      let emittedToolCalls = 0
      let sawAnyToolCalls = false
      let totalContentLength = 0
      let usageInputTokens: number | undefined
      let usageOutputTokens: number | undefined
      let usageCacheReadTokens: number | undefined
      let usageCacheCreationTokens: number | undefined
      let usageReasoningTokens: number | undefined
      let contextUsagePercentage = 0

      // Hidden reasoning state (hoisted for cleanup in error paths)
      let hiddenThinkingIndex: number | null = null
      let hiddenThinkingBlock: ThinkingContent | undefined
      let hiddenMarkerTimer: ReturnType<typeof setTimeout> | null = null
      let hiddenMarkerEmitted = false
      // Index of a breadcrumb this attempt closed or took over, until those events flush.
      let releasedBreadcrumbIndex: number | null = null

      // --- Helper: buffer a text_end event ---
      const endTextBlock = () => {
        if (!textBlock) return
        eventBuffer.push({
          type: "text_end",
          contentIndex: currentTextIdx,
          content: textBlock.text,
          partial: output,
        })
        textBlock = undefined
        currentTextIdx = -1
      }

      // --- Helper: close an open reasoning block ---
      const endReasoningBlock = () => {
        if (!reasoningBlock) return
        eventBuffer.push({
          type: "thinking_end",
          contentIndex: currentReasoningIdx,
          content: reasoningBlock.thinking,
          partial: output,
        })
        reasoningBlock = undefined
        currentReasoningIdx = -1
      }

      // --- Helper: finalize tool call into buffer ---
      const finalizeToolCall = () => {
        if (!currentToolCall) return

        const rawArgs = currentToolCall.inputChunks.join("")
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(rawArgs || "{}")
        } catch {
          parsedArgs = {}
        }

        const toolCall: ToolCallContent = {
          type: "toolCall",
          id: currentToolCall.id,
          name: currentToolCall.name,
          arguments: parsedArgs,
        }
        output.content.push(toolCall)
        const idx = output.content.length - 1
        eventBuffer.push({ type: "toolcall_start", contentIndex: idx, partial: output })
        eventBuffer.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output })
        emittedToolCalls++
        currentToolCall = undefined
      }

      // --- Helper: handle a parsed Kiro event (writes to buffer) ---
      const handleEvent = (event: ReturnType<AwsEventStreamParser["feed"]>[number]) => {
        switch (event.type) {
          case "reasoning": {
            // Kiro 5.x models stream reasoning on a dedicated channel
            // (reasoningContentEvent) instead of <thinking> tags in content.
            if (!thinkingEnabled) break
            if (!reasoningBlock && hiddenThinkingIndex !== null && hiddenThinkingBlock) {
              // The reasoning is readable after all, so it takes over the breadcrumb,
              // replacing any "hidden" placeholder already shown in it.
              cancelHiddenMarkerTimer()
              hiddenThinkingBlock.thinking = ""
              delete hiddenThinkingBlock.redacted
              reasoningBlock = hiddenThinkingBlock
              currentReasoningIdx = hiddenThinkingIndex
              releasedBreadcrumbIndex = hiddenThinkingIndex
              hiddenThinkingIndex = null
            }
            if (!reasoningBlock) {
              reasoningBlock = { type: "thinking", thinking: "" }
              output.content.push(reasoningBlock)
              currentReasoningIdx = output.content.length - 1
              eventBuffer.push({ type: "thinking_start", contentIndex: currentReasoningIdx, partial: output })
            }
            const delta = event.text
            reasoningBlock.thinking += delta
            totalContentLength += delta.length
            eventBuffer.push({ type: "thinking_delta", contentIndex: currentReasoningIdx, delta, partial: output })
            break
          }

          case "reasoning_redacted":
            // Kiro withholds this reasoning; its opaque blob is never shown.
            break

          case "content": {
            // Close hidden reasoning breadcrumb on first real content
            closeHiddenBreadcrumb()
            endReasoningBlock()

            if (thinkingParser) {
              thinkingParser.processChunk(event.content)
            } else {
              if (!textBlock) {
                textBlock = { type: "text", text: "" }
                output.content.push(textBlock)
                currentTextIdx = output.content.length - 1
                eventBuffer.push({ type: "text_start", contentIndex: currentTextIdx, partial: output })
              }
              const delta = event.content
              textBlock.text += delta
              eventBuffer.push({ type: "text_delta", contentIndex: currentTextIdx, delta, partial: output })
            }
            totalContentLength += event.content.length
            break
          }

          case "tool_start": {
            sawAnyToolCalls = true
            closeHiddenBreadcrumb()
            endTextBlock()
            endReasoningBlock()
            finalizeToolCall()
            currentToolCall = {
              id: event.toolUseId || `call_${randomUUID().slice(0, 8)}`,
              name: resolveToolName(event.name),
              inputChunks: event.input ? [event.input] : [],
            }
            if (event.stop) finalizeToolCall()
            break
          }

          case "tool_input": {
            if (currentToolCall) {
              currentToolCall.inputChunks.push(event.input)
            }
            break
          }

          case "tool_stop": {
            if (event.stop) finalizeToolCall()
            break
          }

          case "usage": {
            if (event.inputTokens !== undefined) usageInputTokens = event.inputTokens
            if (event.outputTokens !== undefined) usageOutputTokens = event.outputTokens
            if (event.cacheReadTokens !== undefined) usageCacheReadTokens = event.cacheReadTokens
            if (event.cacheCreationTokens !== undefined) usageCacheCreationTokens = event.cacheCreationTokens
            if (event.reasoningTokens !== undefined) usageReasoningTokens = event.reasoningTokens
            break
          }
          case "context_usage": {
            contextUsagePercentage = event.percentage
            break
          }
        }
      }

      // --- Helper: reset per-attempt state and discard buffer ---
      const resetAttemptState = () => {
        // A retry drops the events that closed or took over the breadcrumb before they
        // reached the screen, so the screen still shows the breadcrumb there.
        if (releasedBreadcrumbIndex !== null && hiddenThinkingBlock) {
          hiddenThinkingBlock.thinking = hiddenMarkerEmitted ? HIDDEN_REASONING_PLACEHOLDER : ""
          hiddenThinkingBlock.redacted = true
          hiddenThinkingIndex = releasedBreadcrumbIndex
          releasedBreadcrumbIndex = null
        }
        // An open hidden-reasoning breadcrumb is already on screen; keep it at its index.
        output.content = hiddenThinkingIndex !== null && hiddenThinkingBlock ? [hiddenThinkingBlock] : []
        output.stopReason = "stop"
        output.errorMessage = undefined
        textBlock = undefined
        currentTextIdx = -1
        reasoningBlock = undefined
        currentReasoningIdx = -1
        currentToolCall = undefined
        thinkingParser = null
        eventBuffer = []
        attemptEventsFlushed = false
        emittedToolCalls = 0
        sawAnyToolCalls = false
        totalContentLength = 0
        usageInputTokens = undefined
        usageOutputTokens = undefined
        usageCacheReadTokens = undefined
        usageCacheCreationTokens = undefined
        usageReasoningTokens = undefined
        contextUsagePercentage = 0
      }

      // --- Hidden reasoning helpers ---
      const cancelHiddenMarkerTimer = () => {
        if (hiddenMarkerTimer) {
          clearTimeout(hiddenMarkerTimer)
          hiddenMarkerTimer = null
        }
      }

      // Within an attempt the close is buffered with the events that caused it, so a
      // retry that drops them leaves the breadcrumb open. `now` closes it on screen at once.
      const closeHiddenBreadcrumb = (now = false) => {
        cancelHiddenMarkerTimer()
        if (hiddenThinkingIndex === null) return
        const event: AssistantMessageEvent = {
          type: "thinking_end",
          contentIndex: hiddenThinkingIndex,
          content: "",
          partial: output,
        }
        if (now) {
          stream.push(event)
        } else {
          eventBuffer.push(event)
          releasedBreadcrumbIndex = hiddenThinkingIndex
        }
        hiddenThinkingIndex = null
      }

      // --- Helper: flush buffered events to stream ---
      const flushBuffer = () => {
        if (eventBuffer.length === 0) return
        for (const evt of eventBuffer) {
          stream.push(evt)
        }
        eventBuffer = []
        attemptEventsFlushed = true
        releasedBreadcrumbIndex = null
      }

      try {
        let profileArn = profileArnCache.get(apiKey)
        if (!profileArn) {
          const lookupProfile = (token: string) => resolveKiroProfileArn({
            apiKey: token,
            apiBase: managementBase,
            fetchImpl,
            profileArn: metaRaw?.profileArn,
            env: deps.env,
            signal: options?.signal,
          })
          try {
            try {
              profileArn = await lookupProfile(apiKey)
            } catch (lookupError: unknown) {
              // A stale token fails here before inference could resync it, so resync now.
              // A rejected API key fails as itself instead of switching to the CLI identity.
              if (options?.signal?.aborted || isKiroApiKey(apiKey)
                || !String(lookupError).includes("bearer token included in the request is invalid")) {
                throw lookupError
              }
              const refreshedCliToken = resyncCliToken()
              if (!refreshedCliToken) throw lookupError
              apiKey = refreshedCliToken
              profileArn = await lookupProfile(apiKey)
            }
          } catch (resolveError: unknown) {
            if (options?.signal?.aborted) throw resolveError
            const reason = resolveError instanceof Error ? resolveError.message : String(resolveError)
            throw new Error(`Kiro profile lookup failed (${managementBase}): ${reason}`)
          }
          if (options?.signal?.aborted) throw abortError()
          if (!profileArn) throw new Error("No accessible Kiro profile found for this account.")
          profileArnCache.set(apiKey, profileArn)
          if (profileArnCache.size > MAX_CACHED_PROFILES) {
            profileArnCache.delete(profileArnCache.keys().next().value as string)
          }
        }
        // The runtime rejects a profile from another region, so inference follows the profile.
        const runtimeBase = kiroBaseForRegion(apiBase, kiroRegionFromProfileArn(profileArn))

        // --- Thinking / reasoning mode ---
        // Inject <thinking_mode> into system prompt so the model produces <thinking> tags.
        // Skip for reasoningHidden models (server-side reasoning, no tags emitted).
        const reasoningLevel = resolveReasoningLevel(model, options)
        thinkingEnabled = reasoningLevel === false || reasoningLevel === "off" ? false : !!reasoningLevel || !!model.reasoning
        reasoningHidden = !!model.reasoningHidden || hiddenReasoningModels.has(model.id)

        let systemPromptOverride = context.systemPrompt
        if (thinkingEnabled && !reasoningHidden) {
          const budget = thinkingBudget(reasoningLevel)
          const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
          systemPromptOverride = `${prefix}${systemPromptOverride ? `\n${systemPromptOverride}` : ""}`
        }

        // Create a context wrapper with the (possibly modified) system prompt
        const contextForPayload: ContextLike = {
          ...context,
          systemPrompt: systemPromptOverride,
        }
        const body = buildKiroPayload(model.id, contextForPayload, profileArn, undefined, model.contextWindow)

        // Build headers — the credential headers come only from the credential, never from
        // user-supplied headers, so neither the token nor its declared type can be overridden.
        const userHeaders = Object.fromEntries(
          Object.entries(options?.headers ?? {}).filter(([name]) => !/^(authorization|tokentype)$/i.test(name)),
        )

        const reqHeaders: Record<string, string> = {
          ...buildKiroHeaders(apiKey),
          ...userHeaders,
        }

        releaseKiroStreamGate = await acquireKiroStreamGate(controller.signal)

        // ---- Outer retry loop: handles capacity + empty response + timeout retries ----
        const maxAttempts = 1 + MAX_CAPACITY_RETRIES + MAX_EMPTY_RETRIES
        for (let outerAttempt = 0; outerAttempt < maxAttempts; outerAttempt++) {
          resetAttemptState()

          // Create ThinkingTagParser for this attempt if thinking is enabled
          // Disabled for reasoningHidden models since no <thinking> tags will appear
          if (thinkingEnabled && !reasoningHidden) {
            thinkingParser = new ThinkingTagParser(output, (evt) => eventBuffer.push(evt))
          }

          // Push start event to stream (visible to consumer — marks a new attempt)
          stream.push({ type: "start", partial: output })

          // Hidden reasoning indicator: emit before fetch so the live indicator
          // covers the server-side deliberation window (where the 25-30s wait
          // actually happens on Claude 4.7 Opus). Only on first attempt.
          if (reasoningHidden && thinkingEnabled && hiddenThinkingIndex === null && outerAttempt === 0) {
            hiddenThinkingIndex = output.content.length
            const block: ThinkingContent = {
              type: "thinking",
              thinking: "",
              redacted: true,
            }
            hiddenThinkingBlock = block
            output.content.push(block)
            stream.push({ type: "thinking_start", contentIndex: hiddenThinkingIndex, partial: output })
            hiddenMarkerEmitted = false
            const idx = hiddenThinkingIndex
            hiddenMarkerTimer = setTimeout(() => {
              hiddenMarkerTimer = null
              if (hiddenThinkingIndex === idx && !hiddenMarkerEmitted) {
                block.thinking = HIDDEN_REASONING_PLACEHOLDER
                stream.push({
                  type: "thinking_delta",
                  contentIndex: idx,
                  delta: HIDDEN_REASONING_PLACEHOLDER,
                  partial: output,
                })
                hiddenMarkerEmitted = true
              }
            }, HIDDEN_REASONING_COUNTDOWN_MS)
          }

          // ---- Inner retry loop: handles HTTP-level errors (429/5xx) ----
          let response: Response | undefined
          let cliIdentityResynced = false
          for (let httpAttempt = 0; httpAttempt <= MAX_HTTP_RETRIES; httpAttempt++) {
            if (httpAttempt > 0) {
              const delay = Math.min(1000 * Math.pow(2, httpAttempt - 1), 10_000)
              await sleep(delay, controller.signal)
            }
            reqHeaders["amz-sdk-invocation-id"] = randomUUID()
            reqHeaders["amz-sdk-request"] = `attempt=${httpAttempt + 1}; max=${MAX_HTTP_RETRIES + 1}`

            const timeoutController = new AbortController()
            const timeoutId = setTimeout(() => timeoutController.abort(), CONNECTION_TIMEOUT_MS)
            const combinedSignal = options?.signal
              ? AbortSignal.any([options.signal, timeoutController.signal])
              : timeoutController.signal
            try {
              response = await raceAbort(
                fetchImpl(`${runtimeBase}/generateAssistantResponse`, {
                  method: "POST",
                  headers: reqHeaders,
                  body: JSON.stringify(body),
                  signal: combinedSignal,
                }),
                controller.signal,
              )
            } finally {
              clearTimeout(timeoutId)
            }
            // Don't retry on ban detection. Any other 403 can mean the cached profile is gone.
            if (response.status === 403) {
              const peekBody = await response.clone().text().catch(() => "")
              if (peekBody.includes("TEMPORARILY_SUSPENDED")) break
              profileArnCache.delete(apiKey)
              if (!isKiroApiKey(apiKey) && !cliIdentityResynced && peekBody.includes("bearer token included in the request is invalid")) {
                const refreshedCliToken = resyncCliToken()
                if (refreshedCliToken) {
                  apiKey = refreshedCliToken
                  reqHeaders.Authorization = `Bearer ${apiKey}`
                  // The type declared for the previous credential must not carry over.
                  delete reqHeaders.TokenType
                  Object.assign(reqHeaders, kiroTokenTypeHeaders(apiKey))
                  cliIdentityResynced = true
                  continue
                }
              }
            }

            // Retry only transient server errors. 429 means Kiro is applying
            // account-level backpressure, so local immediate retries amplify it.
            if (shouldRetryHttpStatus(response.status)) continue
            break
          }
          if (!response) throw new Error("No response from Kiro API after retries")

          await raceAbort(
            Promise.resolve(
              options?.onResponse?.(
                { status: response.status, headers: headersToRecord(response.headers) },
                model,
              ),
            ),
            controller.signal,
          )

          if (!response.ok) {
            const errBody = await raceAbort(
              response.text().catch(() => ""),
              controller.signal,
            )
            if (errBody.includes("TEMPORARILY_SUSPENDED") || errBody.includes("ThrottlingException")) {
              throw new Error(`Kiro account suspended or throttled. Response: ${errBody.slice(0, 300)}`)
            }
            throw new Error(`Kiro API error ${response.status}: ${errBody.slice(0, 500)}`)
          }

          // ---- Stream reading + post-loop retry checks (wrapped for RetryableError) ----
          try {
            reader = response.body?.getReader()
            if (!reader) throw new Error("No response body from Kiro API")

            const parser = new AwsEventStreamParser()
            let gotFirstContent = false
            let lastContentTime = Date.now()
            let capacityRetryable = false

            readLoop: for (;;) {
              if (controller.signal.aborted) throw abortError("Aborted")

              // Compute per-read timeout based on whether we've seen content yet
              const readTimeoutMs = gotFirstContent ? IDLE_STREAM_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS
              const elapsed = Date.now() - lastContentTime
              if (elapsed >= readTimeoutMs) {
                if (!gotFirstContent) {
                  throw new RetryableError(`First token timeout after ${readTimeoutMs / 1000}s — retrying`)
                } else {
                  throw new RetryableError(`Idle stream timeout after ${readTimeoutMs / 1000}s — retrying`)
                }
              }

              // Race reader.read() against idle timeout
              const readDeadline = readTimeoutMs - elapsed
              const readAbort = new AbortController()
              const readTimeoutTimer = setTimeout(() => readAbort.abort(), Math.max(readDeadline, 1000))

              try {
                const { done, value } = await raceAbort(reader.read(), readAbort.signal)
                clearTimeout(readTimeoutTimer)

                if (done) break

                if (controller.signal.aborted) throw abortError("Aborted")

                const events = parser.feed(value)
                for (const event of events) {
                  if (controller.signal.aborted) throw abortError("Aborted")

                  if (event.type === "error") {
                    // Out of capacity: Kiro sends a ThrottlingException whose reason says so.
                    if (`${event.errorType} ${event.message}`.includes("INSUFFICIENT_MODEL_CAPACITY")) {
                      capacityRetryable = true
                      continue
                    }
                    throw streamFailure(event)
                  }

                  // Any decoded frame shows the stream is alive; a model can reason or
                  // stream tool input for minutes before its first answer text.
                  gotFirstContent = true
                  lastContentTime = Date.now()

                  if (!capacityRetryable) {
                    handleEvent(event)
                  }
                }
                // Out of capacity: keep what this chunk produced off screen so the attempt can retry.
                if (!capacityRetryable) flushBuffer()
              } catch (err) {
                clearTimeout(readTimeoutTimer)
                if (err instanceof DOMException && err.name === "AbortError" && !controller.signal.aborted) {
                  if (!gotFirstContent) {
                    throw new RetryableError(`First token timeout after ${readTimeoutMs / 1000}s — retrying`)
                  } else {
                    throw new RetryableError(`Idle stream timeout after ${readTimeoutMs / 1000}s — retrying`)
                  }
                }
                throw err
              }
            }

            // If capacity was insufficient, retry (outer loop) unless part of the
            // answer is already on screen, where a retry would show it twice.
            if (capacityRetryable && attemptEventsFlushed) {
              throw new Error("Kiro ran out of model capacity mid-response (INSUFFICIENT_MODEL_CAPACITY)")
            }
            if (capacityRetryable && outerAttempt < maxAttempts - 1) {
              try { await reader?.cancel() } catch { /* ok */ }
              try { reader?.releaseLock() } catch { /* ok */ }
              reader = undefined
              const delay = Math.min(2000 * Math.pow(2, outerAttempt), 30_000)
              await sleep(delay, controller.signal)
              continue // discard buffer, reset state, retry
            }

            // Capacity error on last attempt — error, not silent success
            if (capacityRetryable) {
              throw new Error("INSUFFICIENT_MODEL_CAPACITY after all retries")
            }

            // Empty response detection: got 200 but no answer text or tool call.
            // Reasoning alone is not an answer, but once it is on screen a retry
            // would show it twice, so report the turn instead.
            const hasAnswer = sawAnyToolCalls || output.content.some((block) => block.type !== "thinking")
            if (!hasAnswer && !attemptEventsFlushed && outerAttempt < maxAttempts - 1) {
              try { await reader?.cancel() } catch { /* ok */ }
              try { reader?.releaseLock() } catch { /* ok */ }
              reader = undefined
              await sleep(1000, controller.signal)
              continue // discard buffer, retry
            }

            // Last attempt returned empty — error instead of silent empty response
            if (!hasAnswer) {
              throw new Error(attemptEventsFlushed
                ? "Kiro ended the turn after reasoning, without an answer"
                : "Kiro returned an empty response after all retries")
            }

            // Success — finalize blocks and flush buffered events

            // 1. Finalize ThinkingTagParser (handles thinking_end + text_end)
            let textBlockIdx: number | null = null
            if (thinkingParser) {
              thinkingParser.finalize()
              textBlockIdx = thinkingParser.getTextBlockIndex()
            } else {
              endTextBlock()
            }

            // 2. Finalize any pending tool call
            finalizeToolCall()

            // 3. Bracket-style tool call fallback: extract [Called func with args: {...}]
            //    from text content when no native tool events were emitted.
            if (!sawAnyToolCalls && textBlockIdx !== null) {
              const textContent = output.content[textBlockIdx] as TextContent | undefined
              if (textContent && textContent.type === "text") {
                const bracketResult = parseBracketToolCalls(textContent.text)
                if (bracketResult.toolCalls.length > 0) {
                  sawAnyToolCalls = true
                  textContent.text = bracketResult.cleanedText
                  for (const btc of bracketResult.toolCalls) {
                    const toolCall: ToolCallContent = {
                      type: "toolCall",
                      id: btc.toolUseId,
                      name: btc.name,
                      arguments: btc.arguments,
                    }
                    output.content.push(toolCall)
                    const idx = output.content.length - 1
                    eventBuffer.push({ type: "toolcall_start", contentIndex: idx, partial: output })
                    eventBuffer.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output })
                    emittedToolCalls++
                  }
                }
              }
            }

            // 4. Strip echo noise: when tool calls are present and the text
            //    content is just "." or "continue", remove it to prevent
            //    accumulation in history that reinforces the pattern.
            if (emittedToolCalls > 0 && textBlockIdx !== null) {
              const textContent = output.content[textBlockIdx] as TextContent | undefined
              if (textContent && /^\s*(\.+|continue)\s*$/i.test(textContent.text)) {
                textContent.text = ""
              }
            }

            // 5. Close hidden reasoning if still open (defensive)
            closeHiddenBreadcrumb()
            endReasoningBlock()

            // 6. Emit text_end for the final text block
            if (textBlockIdx !== null) {
              const textContent = output.content[textBlockIdx] as TextContent | undefined
              if (textContent) {
                eventBuffer.push({
                  type: "text_end",
                  contentIndex: textBlockIdx,
                  content: textContent.text,
                  partial: output,
                })
              }
            }

            flushBuffer()
            break
          } catch (err) {
            // Retry only before live deltas have escaped. Retrying after a
            // visible partial response would duplicate content in the UI.
            if (err instanceof RetryableError && !attemptEventsFlushed && outerAttempt < maxAttempts - 1) {
              try { await reader?.cancel() } catch { /* ok */ }
              try { reader?.releaseLock() } catch { /* ok */ }
              reader = undefined
              const delay = Math.min(2000 * Math.pow(2, outerAttempt), 30_000)
              await sleep(delay, controller.signal)
              continue // discard buffer, reset state, retry
            }
            throw err // propagate non-retryable or exhausted retries
          }
        }

        // Apply usage data to output (per mikeyobrien/hongyilyu convention):
        // 1. contextUsagePercentage → estimate input tokens from context window
        // 2. usage event tokens override the estimate when available
        // 3. output tokens: usage event, or char-count fallback
        if (contextUsagePercentage > 0) {
          output.usage.input = Math.round((contextUsagePercentage / 100) * model.contextWindow)
        }
        if (usageInputTokens !== undefined) {
          output.usage.input = usageInputTokens
        }
        output.usage.output = usageOutputTokens ?? (totalContentLength > 0 ? Math.max(1, Math.floor(totalContentLength / 4)) : 0)
        if (usageCacheReadTokens !== undefined) {
          output.usage.cacheRead = usageCacheReadTokens
        }
        if (usageCacheCreationTokens !== undefined) {
          output.usage.cacheWrite = usageCacheCreationTokens
        }
        if (usageReasoningTokens !== undefined) {
          output.usage.reasoning = usageReasoningTokens
        }
        output.usage.totalTokens =
          output.usage.input +
          output.usage.output +
          output.usage.cacheRead +
          output.usage.cacheWrite +
          (output.usage.reasoning ?? 0)
        output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop"
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output })
        stream.end()
      } catch (error: unknown) {
        // Non-retryable error or exhausted retries
        cancelHiddenMarkerTimer()
        // Nothing will retry now, so show what this attempt held back; the failed
        // message then matches the screen.
        flushBuffer()
        closeHiddenBreadcrumb(true)
        const reason: ErrorReason = controller.signal.aborted ? "aborted" : "error"
        output.stopReason = reason
        output.errorMessage =
          reason === "aborted"
            ? "Request aborted"
            : error instanceof Error
              ? error.message
              : String(error)
        stream.push({ type: "error", reason, error: output })
        stream.end()
      } finally {
        cancelHiddenMarkerTimer()
        options?.signal?.removeEventListener("abort", abortUpstream)
        try { await reader?.cancel() } catch { /* may already be closed */ }
        try { reader?.releaseLock() } catch { /* may already be released */ }
        releaseKiroStreamGate?.()
      }
    }

    run().catch((error: unknown) => {
      const msg: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: now(),
      }
      stream.push({ type: "error", reason: "error", error: msg })
      stream.end()
    })

    return stream
  }
}
