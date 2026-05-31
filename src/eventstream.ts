/**
 * AWS Event Stream binary decoder for Kiro API responses.
 *
 * Parses binary event-stream frames into typed Kiro events.
 * Uses a persistent TextDecoder with { stream: true } for safe
 * multi-byte UTF-8 handling at chunk boundaries.
 * Includes buffer size cap to prevent OOM on garbage input.
 */

// ---------------------------------------------------------------------------
// Parsed event types
// ---------------------------------------------------------------------------

export interface ContentEvent {
  type: "content"
  content: string
}

export interface ToolStartEvent {
  type: "tool_start"
  toolUseId: string
  name: string
  input: string
  stop: boolean
}

export interface ToolInputEvent {
  type: "tool_input"
  input: string
}

export interface ToolStopEvent {
  type: "tool_stop"
  stop: boolean
}

export interface UsageEvent {
  type: "usage"
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
}

export interface ContextUsageEvent {
  type: "context_usage"
  percentage: number
}

export type KiroEvent =
  | ContentEvent
  | ToolStartEvent
  | ToolInputEvent
  | ToolStopEvent
  | UsageEvent
  | ContextUsageEvent

// ---------------------------------------------------------------------------
// JSON brace matching
// ---------------------------------------------------------------------------

/**
 * Find the matching closing brace for an opening brace at `start`.
 * Handles nested braces and escaped characters within strings.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === "\\") {
      if (inString) escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

// ---------------------------------------------------------------------------
// Event patterns to scan for (in priority order)
// ---------------------------------------------------------------------------

const EVENT_PATTERNS: ReadonlyArray<{ prefix: string; eventType: string }> = [
  { prefix: '{"name":', eventType: "tool_start" },
  { prefix: '{"toolUseId":', eventType: "tool_start" },
  { prefix: '{"toolUseId": ', eventType: "tool_start" },
  { prefix: '{"type":"tool_use"', eventType: "tool_start" },
  { prefix: '{"input":', eventType: "tool_input" },
  { prefix: '{"stop":', eventType: "tool_stop" },
  { prefix: '{"content":', eventType: "content" },
  { prefix: '{"content": ', eventType: "content" },
  { prefix: '{"usage":', eventType: "usage" },
  { prefix: '{"metricsEvent":', eventType: "usage" },
  { prefix: '{"metrics":', eventType: "usage" },
  { prefix: '{"usageEvent":', eventType: "usage" },
  { prefix: '{"contextUsagePercentage":', eventType: "context_usage" },
  { prefix: '{"contextUsageEvent":', eventType: "context_usage" },
]

// Maximum buffer size before discarding (10 MB)
const MAX_BUFFER_SIZE = 10 * 1024 * 1024

// ---------------------------------------------------------------------------
// Parser class
// ---------------------------------------------------------------------------

export class AwsEventStreamParser {
  private buffer = ""
  private lastContent: string | undefined
  private lastContentType: string | undefined
  private decoder = new TextDecoder("utf-8", { fatal: false })

  /** Feed a binary chunk. Returns parsed events. */
  feed(chunk: Uint8Array | string): KiroEvent[] {
    try {
      const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })
      this.buffer += text
    } catch {
      return []
    }

    // Cap buffer growth to prevent OOM on garbage input
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      // Keep only the tail — most likely to contain the start of a valid event
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER_SIZE / 2)
    }

    const events: KiroEvent[] = []

    while (true) {
      // Find earliest pattern match
      let earliestPos = -1
      let earliestType: string | undefined

      for (const { prefix, eventType } of EVENT_PATTERNS) {
        const pos = this.buffer.indexOf(prefix)
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos
          earliestType = eventType
        }
      }

      if (earliestPos === -1 || !earliestType) break

      // Find matching closing brace
      const jsonEnd = findMatchingBrace(this.buffer, earliestPos)
      if (jsonEnd === -1) break // incomplete JSON — wait for more data

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1)
      this.buffer = this.buffer.slice(jsonEnd + 1)

      try {
        const data = JSON.parse(jsonStr)
        const event = this.processEvent(data, earliestType)
        if (event) events.push(event)
      } catch {
        // Malformed JSON — skip
      }
    }

    return events
  }

  private processEvent(
    data: Record<string, unknown>,
    eventType: string,
  ): KiroEvent | null {
    switch (eventType) {
      case "content": {
        const content = String(data.content ?? "")
        if (content === "") return null  // skip empty content deltas
        // Deduplicate consecutive identical content deltas only.
        // Reset on non-content events so repeated tokens across boundaries work.
        if (content === this.lastContent && this.lastContentType === "content") return null
        this.lastContent = content
        this.lastContentType = "content"
        return { type: "content", content }
      }

      case "tool_start": {
        // Reset dedup state at tool boundary
        this.lastContent = undefined
        this.lastContentType = undefined

        // Streamed tool calls end with { name, toolUseId, stop: true }.
        // Treat that closing frame as a stop, not a second empty tool call.
        if (data.stop === true && !("input" in data)) {
          return { type: "tool_stop", stop: true }
        }

        const input = data.input
        let inputStr: string
        if (typeof input === "object" && input !== null && !Array.isArray(input)) {
          inputStr = Object.keys(input).length > 0 ? JSON.stringify(input) : ""
        } else {
          inputStr = input ? String(input) : ""
        }

        return {
          type: "tool_start",
          toolUseId: String(data.toolUseId ?? ""),
          name: String(data.name ?? ""),
          input: inputStr,
          stop: data.stop === true,
        }
      }

      case "tool_input": {
        this.lastContent = undefined
        this.lastContentType = undefined

        const input = data.input
        let inputStr: string
        if (typeof input === "object" && input !== null && !Array.isArray(input)) {
          inputStr = Object.keys(input).length > 0 ? JSON.stringify(input) : ""
        } else {
          inputStr = input ? String(input) : ""
        }
        return { type: "tool_input", input: inputStr }
      }

      case "tool_stop": {
        this.lastContent = undefined
        this.lastContentType = undefined
        return { type: "tool_stop", stop: data.stop === true }
      }
      case "usage": {
        const u =
          asRecord(data.usage) ??
          asRecord(data.metricsEvent) ??
          asRecord(data.metrics) ??
          asRecord(data.usageEvent) ??
          data
        return {
          type: "usage",
          inputTokens: finiteNumber(u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens),
          outputTokens: finiteNumber(u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens),
          cacheReadTokens: finiteNumber(u.cacheReadTokens ?? u.cache_read_tokens ?? u.cacheReadInputTokens ?? u.cachedTokens),
          cacheCreationTokens: finiteNumber(u.cacheCreationTokens ?? u.cache_write_tokens ?? u.cacheWriteTokens ?? u.cacheCreationInputTokens),
          reasoningTokens: finiteNumber(u.reasoningTokens ?? u.reasoning_tokens ?? u.reasoningOutputTokens),
        }
      }

      case "context_usage": {
        const nested = asRecord(data.contextUsageEvent)
        return {
          type: "context_usage",
          percentage: Number(data.contextUsagePercentage ?? nested?.contextUsagePercentage ?? 0),
        }
      }

      default:
        return null
    }
  }

  /** Reset parser state for reuse. */
  reset(): void {
    this.buffer = ""
    this.lastContent = undefined
    this.lastContentType = undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
