/**
 * Kiro stream factory — core streaming logic.
 *
 * Supports:
 * - AWS Event Stream binary response decoding
 * - 429/5xx retry with exponential backoff
 * - INSUFFICIENT_MODEL_CAPACITY inner retry (common on free tier)
 * - First-token timeout (180s) + idle stream timeout (90s)
 * - Empty response detection with retry
 * - profileArn conditional omission for Builder ID
 * - Ban detection (TEMPORARILY_SUSPENDED) in HTTP errors AND stream content
 * - Live event emission with retry buffering before the first visible delta
 */

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, readFileSync } from "node:fs"
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
import { AwsEventStreamParser } from "./eventstream.ts"
import { ThinkingTagParser } from "./thinking-parser.ts"
import { parseBracketToolCalls } from "./bracket-tool-parser.ts"

export * from "./converters.ts"
export * from "./eventstream.ts"
export * from "./types.ts"


// Retry / timeout configuration
const MAX_HTTP_RETRIES = 3           // 429 / 5xx retries
const MAX_CAPACITY_RETRIES = 3       // INSUFFICIENT_MODEL_CAPACITY retries
const MAX_EMPTY_RETRIES = 2          // empty response retries
const FIRST_TOKEN_TIMEOUT_MS = 180_000  // 3 minutes to get first content
const IDLE_STREAM_TIMEOUT_MS = 90_000   // 90s between content events
const CONNECTION_TIMEOUT_MS = 120_000    // 2 min for initial connection

// Thinking / reasoning configuration
const HIDDEN_REASONING_COUNTDOWN_MS = 2000  // ms before showing "reasoning hidden" marker
const HIDDEN_REASONING_PLACEHOLDER = "Reasoning hidden by provider"

/** Map reasoning level to thinking budget in tokens. */
function thinkingBudget(level: boolean | string | undefined): number {
  if (level === "xhigh") return 50000
  if (level === "high") return 30000
  if (level === "medium") return 20000
  return 10000 // default / "low" / true
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
// Dynamic profileArn resolution via ListAvailableProfiles (mikeyobrien/hongyilyu pattern)
// ---------------------------------------------------------------------------
const profileArnCache = new Map<string, string>()
async function resolveProfileArn(
  accessToken: string,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const cached = profileArnCache.get(endpoint)
  if (cached !== undefined) return cached
  try {
    const ep = new URL(endpoint)
    ep.pathname = ep.pathname.replace(/\/generateAssistantResponse\/?$/, "/")
    ep.search = ""
    ep.hash = ""
    const r = await fetchImpl(ep.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
      },
      body: "{}",
    })
    if (!r.ok) return undefined
    const j = (await r.json()) as { profiles?: Array<{ arn?: string }> }
    const arn = j.profiles?.find((p) => p.arn)?.arn
    if (arn) profileArnCache.set(endpoint, arn)
    return arn
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Build headers for Kiro API request
// ---------------------------------------------------------------------------

function buildKiroHeaders(
  accessToken: string,
  _isApiKey: boolean,
  _isIdc: boolean,
): Record<string, string> {
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
  }
}
// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

export function createStreamKiro(deps: CoreDependencies) {
  const apiBase = deps.apiBase
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

      // Detect auth method for header selection
      const isApiKey = apiKey.startsWith("ksk_")
      const isIdc = !isApiKey

      // Read auth metadata to route profileArn correctly
      const metaRaw = (() => {
        try {
          const p = join(homedir(), ".omp", "agent", "kiro-auth-meta.json")
          if (!existsSync(p)) return null
          return JSON.parse(readFileSync(p, "utf-8")) as { method?: string; profileArn?: string; region?: string }
        } catch { return null }
      })()
      const authMethod = metaRaw?.method ?? "social"

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
      let contextUsagePercentage = 0

      // Hidden reasoning state (hoisted for cleanup in error paths)
      let hiddenThinkingIndex: number | null = null
      let hiddenMarkerTimer: ReturnType<typeof setTimeout> | null = null
      let hiddenMarkerEmitted = false

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
          case "content": {
            // Close hidden reasoning breadcrumb on first real content
            closeHiddenBreadcrumb()

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
        output.content = []
        output.stopReason = "stop"
        output.errorMessage = undefined
        textBlock = undefined
        currentTextIdx = -1
        currentToolCall = undefined
        thinkingParser = null
        eventBuffer = []
        attemptEventsFlushed = false
        emittedToolCalls = 0
        sawAnyToolCalls = false
        totalContentLength = 0
        usageInputTokens = undefined
        usageOutputTokens = undefined
        contextUsagePercentage = 0
      }

      // --- Hidden reasoning helpers ---
      const cancelHiddenMarkerTimer = () => {
        if (hiddenMarkerTimer) {
          clearTimeout(hiddenMarkerTimer)
          hiddenMarkerTimer = null
        }
      }

      const closeHiddenBreadcrumb = () => {
        cancelHiddenMarkerTimer()
        if (hiddenThinkingIndex !== null) {
          stream.push({
            type: "thinking_end",
            contentIndex: hiddenThinkingIndex,
            content: "",
            partial: output,
          })
          hiddenThinkingIndex = null
        }
      }

      // --- Helper: flush buffered events to stream ---
      const flushBuffer = () => {
        if (eventBuffer.length === 0) return
        for (const evt of eventBuffer) {
          stream.push(evt)
        }
        eventBuffer = []
        attemptEventsFlushed = true
      }

      try {
        // Resolve profileArn: only needed for Kiro social/OIDC sessions.
        // Builder ID (device code flow) doesn't support profileArn or ListAvailableProfiles —
        // including either causes a 403. Skip entirely when no profileArn in metadata.
        let profileArn: string | undefined
        if (metaRaw?.profileArn) {
          profileArn = metaRaw.profileArn
        } else if (authMethod === "social") {
          // Only resolve profileArn for social (Google/GitHub) auth.
          // Builder ID / IDC tokens get 403 from ListAvailableProfiles.
          profileArn = await resolveProfileArn(apiKey, `${apiBase}/generateAssistantResponse`, fetchImpl)
        }

        // --- Thinking / reasoning mode ---
        // Inject <thinking_mode> into system prompt so the model produces <thinking> tags.
        // Skip for reasoningHidden models (server-side reasoning, no tags emitted).
        const reasoningLevel = options?.reasoning
        const thinkingEnabled = !!reasoningLevel || model.reasoning
        const reasoningHidden = !!model.reasoningHidden

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

        // Build headers — strip Authorization from user-supplied headers to prevent OAuth bypass
        const userHeaders = { ...options?.headers }
        delete userHeaders["Authorization"]
        delete userHeaders["authorization"]

        const reqHeaders: Record<string, string> = {
          ...buildKiroHeaders(apiKey, isApiKey, isIdc),
          ...userHeaders,
        }

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
                fetchImpl(`${apiBase}/generateAssistantResponse`, {
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
            // Don't retry on ban detection; bust profileArn cache on 403
            if (response.status === 403) {
              profileArnCache.delete(`${apiBase}/generateAssistantResponse`)
              const peekBody = await response.clone().text().catch(() => "")
              if (peekBody.includes("TEMPORARILY_SUSPENDED")) break
              if (!cliIdentityResynced && peekBody.includes("bearer token included in the request is invalid")) {
                const refreshedCliToken = resyncCliToken()
                if (refreshedCliToken) {
                  apiKey = refreshedCliToken
                  reqHeaders.Authorization = `Bearer ${apiKey}`
                  cliIdentityResynced = true
                  continue
                }
              }
            }

            // Retry on 429 and 5xx
            if (response.status === 429 || response.status >= 500) continue
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

                  // Check for INSUFFICIENT_MODEL_CAPACITY in content
                  if (event.type === "content" && event.content.includes("INSUFFICIENT_MODEL_CAPACITY")) {
                    capacityRetryable = true
                    continue // skip — don't buffer capacity error
                  }

                  // Check for TEMPORARILY_SUSPENDED in stream content (200 OK with ban message)
                  if (event.type === "content" && event.content.includes("TEMPORARILY_SUSPENDED")) {
                    throw new Error(`Kiro account suspended (detected in stream). Content: ${event.content.slice(0, 200)}`)
                  }

                  if (event.type === "content") {
                    gotFirstContent = true
                    lastContentTime = Date.now()
                  }

                  if (!capacityRetryable) {
                    handleEvent(event)
                  }
                }
                flushBuffer()
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

            // If capacity was insufficient, retry (outer loop)
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

            // Empty response detection: got 200 but zero content events
            const hasContent = output.content.length > 0
            if (!hasContent && outerAttempt < maxAttempts - 1) {
              try { await reader?.cancel() } catch { /* ok */ }
              try { reader?.releaseLock() } catch { /* ok */ }
              reader = undefined
              await sleep(1000, controller.signal)
              continue // discard buffer, retry
            }

            // Last attempt returned empty — error instead of silent empty response
            if (!hasContent) {
              throw new Error("Kiro returned an empty response after all retries")
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
        output.usage.totalTokens = output.usage.input + output.usage.output
        output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop"
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output })
        stream.end()
      } catch (error: unknown) {
        // Non-retryable error or exhausted retries
        cancelHiddenMarkerTimer()
        closeHiddenBreadcrumb()
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
