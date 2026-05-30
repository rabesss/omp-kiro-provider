/**
 * Convert OMP's internal message format to Kiro's conversationState format.
 *
 * Kiro API expects:
 *   {
 *     conversationState: {
 *       conversationId: "uuid",
 *       chatTriggerType: "MANUAL",
 *       currentMessage: { userInputMessage: { content, modelId, origin, userInputMessageContext? } },
 *       history: [ { userInputMessage: {...} }, { assistantResponseMessage: {...} } ]
 *     },
 *     profileArn?: "arn:..."
 *   }
 *
 * Key constraints (from kiro-gateway converters_core.py):
 * - History must alternate user/assistant
 * - First message in history must be user
 * - Empty content must use placeholder "(empty placeholder)"
 * - Tool names must be ≤ 64 chars (truncated with reverse-map for response dispatch)
 * - Tool results go in userInputMessageContext.toolResults
 * - System prompt is prepended to first user message content
 */

import { randomUUID } from "node:crypto"
import type { ContextLike, MessageLike, ToolLike, ToolCallContent } from "./types.ts"

// ---------------------------------------------------------------------------
// Tool name truncation with reverse mapping
// ---------------------------------------------------------------------------

const KIRO_MAX_TOOL_NAME = 64

/** Map from truncated name back to original name (populated per request). */
const truncationMap = new Map<string, string>()

/** Truncate tool name to Kiro's max length. Records mapping for reversal. */
function truncateToolName(name: string): string {
  if (name.length <= KIRO_MAX_TOOL_NAME) return name
  // Keep as much of the original as possible, append a short hash suffix
  // for uniqueness (last 4 hex chars of a simple hash)
  const hash = simpleHash(name)
  const suffix = `_t${hash}`
  const truncated = name.slice(0, KIRO_MAX_TOOL_NAME - suffix.length) + suffix
  truncationMap.set(truncated, name)
  return truncated
}

/** Reverse-map a (possibly truncated) tool name back to the original. */
export function resolveToolName(name: string): string {
  return truncationMap.get(name) ?? name
}

/** Clear the truncation map (call at start of each request). */
function clearTruncationMap(): void {
  truncationMap.clear()
}

/** Simple deterministic hash for short suffix generation. */
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).slice(0, 4).padStart(4, "0")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .filter((c) => c.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("")
  }
  return String(content ?? "")
}

function systemPromptText(prompt: ContextLike["systemPrompt"]): string {
  return prompt ?? ""
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

function toolsToKiroFormat(tools?: readonly ToolLike[]): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => ({
    name: truncateToolName(tool.name),
    description: tool.description ?? "",
    inputSchema: tool.input_schema,
  }))
}

// ---------------------------------------------------------------------------
// Tool result conversion
// ---------------------------------------------------------------------------

function toolResultsToKiroFormat(
  results?: Array<{ toolCallId: string; content: string }>,
): unknown[] | undefined {
  if (!results || results.length === 0) return undefined

  return results.map((r) => ({
    toolUseId: r.toolCallId,
    content: r.content,
  }))
}

// ---------------------------------------------------------------------------
// Tool uses from assistant message
// ---------------------------------------------------------------------------

function toolCallsToKiroToolUses(
  toolCalls?: ToolCallContent[],
): unknown[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => ({
    toolUseId: tc.id,
    name: truncateToolName(tc.name),
    input: tc.arguments,
  }))
}

// ---------------------------------------------------------------------------
// History builder (with alternation enforcement)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// History management (adapted from mikeyobrien/pi-provider-kiro)
// ---------------------------------------------------------------------------

/** Max history size in characters, calibrated for 200K-token context models. */
const HISTORY_LIMIT = 850000
/** The context window size that HISTORY_LIMIT was calibrated for. */
const HISTORY_LIMIT_CONTEXT_WINDOW = 200000

/**
 * Sanitize history: strip leading entries that would make history invalid.
 * Removes leading non-user messages and orphaned tool results.
 */
function sanitizeHistory(history: unknown[]): unknown[] {
  // Strip leading entries that aren't valid starts
  while (
    history.length > 0 &&
    hasAssistantMessage(history[0]) &&
    !hasToolUses(history[0])
  ) {
    history = history.slice(1)
  }

  const result: unknown[] = []
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    // Skip assistant messages with no content and no tool uses (from API errors)
    if (hasAssistantMessage(entry) && !hasToolUses(entry) && !hasContent(entry)) continue

    // Keep entries where tool results follow tool uses correctly
    if (hasToolUses(entry)) {
      const next = history[i + 1]
      if (next && hasToolResults(next)) result.push(entry)
    } else if (hasToolResults(entry)) {
      const prev = result[result.length - 1]
      if (prev && hasToolUses(prev)) result.push(entry)
    } else {
      result.push(entry)
    }
  }
  return result
}

/**
 * Inject synthetic tool calls for orphaned tool results (results with no
 * matching tool use ID in history). Prevents API errors.
 */
function injectSyntheticToolCalls(history: unknown[]): unknown[] {
  const validIds = new Set<string>()
  for (const entry of history) {
    const uses = getToolUses(entry)
    for (const tu of uses) {
      const id = (tu as Record<string, unknown>).toolUseId as string | undefined
      if (id) validIds.add(id)
    }
  }

  const result: unknown[] = []
  for (const entry of history) {
    const toolResults = getToolResults(entry)
    if (toolResults.length > 0) {
      const orphaned = toolResults.filter((tr) => !validIds.has((tr as Record<string, unknown>).toolUseId as string))
      if (orphaned.length > 0) {
        result.push({
          assistantResponseMessage: {
            content: "Tool calls were made.",
            toolUses: orphaned.map((tr) => ({
              name: "unknown_tool",
              toolUseId: (tr as Record<string, unknown>).toolUseId,
              input: {},
            })),
          },
        })
        for (const tr of orphaned) validIds.add((tr as Record<string, unknown>).toolUseId as string)
      }
    }
    result.push(entry)
  }
  return result
}

/**
 * Truncate history to fit within a character limit, removing oldest entries first.
 * Limit is dynamically scaled to the model's context window.
 */
function truncateHistory(history: unknown[], charLimit: number): unknown[] {
  let sanitized = sanitizeHistory(history)
  let size = JSON.stringify(sanitized).length
  while (size > charLimit && sanitized.length > 2) {
    sanitized.shift()
    // Re-sanitize after removal to maintain alternation
    while (sanitized.length > 0 && !hasUserMessage(sanitized[0])) sanitized.shift()
    sanitized = sanitizeHistory(sanitized)
    size = JSON.stringify(sanitized).length
  }
  return injectSyntheticToolCalls(sanitized)
}

// --- History helper predicates ---

function hasAssistantMessage(entry: unknown): boolean {
  return isRecord(entry) && "assistantResponseMessage" in entry
}

function hasUserMessage(entry: unknown): boolean {
  return isRecord(entry) && "userInputMessage" in entry
}

function hasToolUses(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  const arm = entry.assistantResponseMessage as Record<string, unknown> | undefined
  return Array.isArray(arm?.toolUses) && (arm!.toolUses as unknown[]).length > 0
}

function hasContent(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  const arm = entry.assistantResponseMessage as Record<string, unknown> | undefined
  return !!arm?.content && String(arm.content).length > 0
}

function hasToolResults(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  const uim = entry.userInputMessage as Record<string, unknown> | undefined
  const ctx = uim?.userInputMessageContext as Record<string, unknown> | undefined
  return Array.isArray(ctx?.toolResults) && (ctx!.toolResults as unknown[]).length > 0
}

function getToolUses(entry: unknown): unknown[] {
  if (!isRecord(entry)) return []
  const arm = entry.assistantResponseMessage as Record<string, unknown> | undefined
  return Array.isArray(arm?.toolUses) ? (arm!.toolUses as unknown[]) : []
}

function getToolResults(entry: unknown): unknown[] {
  if (!isRecord(entry)) return []
  const uim = entry.userInputMessage as Record<string, unknown> | undefined
  const ctx = uim?.userInputMessageContext as Record<string, unknown> | undefined
  return Array.isArray(ctx?.toolResults) ? (ctx!.toolResults as unknown[]) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function buildHistory(
  messages: MessageLike[],
  modelId: string,
  systemPrompt: string,
): { history: unknown[]; currentContent: string; currentToolResults?: unknown[] } {
  if (messages.length === 0) {
    return { history: [], currentContent: systemPrompt || "(empty placeholder)" }
  }

  // All messages except the last go into history
  const historyMessages = messages.slice(0, -1)
  const lastMessage = messages[messages.length - 1]

  const history: unknown[] = []

  // Prepend system prompt to first user message in history
  let systemInjected = false

  for (const msg of historyMessages) {
    let content = textContent(msg.content)

    // Inject system prompt into first user message
    if (msg.role === "user" && !systemInjected && systemPrompt) {
      content = `${systemPrompt}\n\n${content}`
      systemInjected = true
    }

    if (!content) content = "(empty placeholder)"

    if (msg.role === "user") {
      const userMsg: Record<string, unknown> = {
        content,
        modelId,
        origin: "AI_EDITOR",
      }

      // Tool results go into userInputMessageContext
      const toolResults = toolResultsToKiroFormat(msg.toolResults)
      if (toolResults) {
        userMsg.userInputMessageContext = { toolResults }
      }

      history.push({ userInputMessage: userMsg })
    } else {
      // Assistant message
      const assistantMsg: Record<string, unknown> = { content }

      const toolUses = toolCallsToKiroToolUses(msg.toolCalls)
      if (toolUses) {
        assistantMsg.toolUses = toolUses
      }

      history.push({ assistantResponseMessage: assistantMsg })
    }
  }

  // Enforce alternation: Kiro requires user/assistant/user/... pattern.
  // Merge consecutive same-role messages and handle leading assistant messages.
  const normalized = enforceAlternation(history)

  // Current message content (the last message)
  let currentContent = textContent(lastMessage.content)

  // If system prompt wasn't injected into history, prepend to current
  if (!systemInjected && systemPrompt) {
    currentContent = `${systemPrompt}\n\n${currentContent}`
  }

  if (!currentContent) currentContent = "(empty placeholder)"

  const currentToolResults = lastMessage.role === "user"
    ? toolResultsToKiroFormat(lastMessage.toolResults)
    : undefined

  return { history: normalized, currentContent, currentToolResults }
}

/**
 * Enforce Kiro's history alternation constraint:
 * - History must alternate user/assistant
 * - First message must be user
 *
 * Strategy:
 * - If history starts with assistant, prepend a synthetic user message
 * - Merge consecutive same-role messages by concatenating content
 */
function enforceAlternation(history: unknown[]): unknown[] {
  if (history.length === 0) return history

  const result: unknown[] = []
  const syntheticUser = { userInputMessage: { content: "(continued)", modelId: "", origin: "AI_EDITOR" } }

  // If first message is assistant, prepend synthetic user
  if (history.length > 0 && "assistantResponseMessage" in (history[0] as Record<string, unknown>)) {
    result.push(syntheticUser)
  }

  for (const entry of history) {
    const last = result[result.length - 1] as Record<string, unknown> | undefined
    const entryIsUser = "userInputMessage" in (entry as Record<string, unknown>)

    if (last) {
      const lastIsUser = "userInputMessage" in last
      // Same role — merge content into the last entry
      if (lastIsUser === entryIsUser) {
        const lastMsgKey = lastIsUser ? "userInputMessage" : "assistantResponseMessage"
        const curMsgKey = entryIsUser ? "userInputMessage" : "assistantResponseMessage"
        const lastMsg = last[lastMsgKey] as Record<string, unknown>
        const curMsg = (entry as Record<string, unknown>)[curMsgKey] as Record<string, unknown>
        if (lastMsg && curMsg) {
          lastMsg.content = `${lastMsg.content ?? ""}\n${curMsg.content ?? ""}`
          // Merge toolUses if present (assistant) or toolResults if present (user)
          if (curMsg.toolUses) {
            const existing = (lastMsg.toolUses as unknown[]) ?? []
            lastMsg.toolUses = [...existing, ...(curMsg.toolUses as unknown[])]
          }
          if (curMsg.userInputMessageContext) {
            const existingCtx = (lastMsg.userInputMessageContext as Record<string, unknown>) ?? {}
            const curCtx = curMsg.userInputMessageContext as Record<string, unknown>
            const existingTR = (existingCtx.toolResults as unknown[]) ?? []
            const curTR = (curCtx.toolResults as unknown[]) ?? []
            if (curTR.length > 0) {
              lastMsg.userInputMessageContext = { ...existingCtx, toolResults: [...existingTR, ...curTR] }
            }
          }
        }
        continue
      }
    }

    result.push(entry)
  }

  return result
}

// ---------------------------------------------------------------------------
// Public: build Kiro request payload
// ---------------------------------------------------------------------------

export interface KiroPayload {
  conversationState: {
    conversationId: string
    chatTriggerType: "MANUAL"
    agentTaskType: "vibe"
    currentMessage: {
      userInputMessage: Record<string, unknown>
    }
    history?: unknown[]
  }
  profileArn?: string
  agentMode?: string
}

export function buildKiroPayload(
  modelId: string,
  context: ContextLike,
  profileArn?: string,
  conversationId?: string,
  contextWindow?: number,
): KiroPayload {
  // Clear truncation map for each new request
  clearTruncationMap()

  const sysPrompt = systemPromptText(context.systemPrompt)
  // Convert pi dash-form (claude-sonnet-4-5) to Kiro dot-form (claude-sonnet-4.5)
  // Regex: only matches digit-dash-digit (version numbers), not general dashes.
  // Anchored to avoid false positives on things like "model-3-20250101".
  const kiroModelId = modelId.replace(/(\d)-(\d)(?!\d)/g, "$1.$2")
  let { history, currentContent, currentToolResults } = buildHistory(
    context.messages,
    kiroModelId,
    sysPrompt,
  )

  // Truncate history to fit context window (scaled dynamically)
  if (history.length > 0 && contextWindow) {
    const dynamicLimit = Math.floor((contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT)
    history = truncateHistory(history, dynamicLimit)
  }

  // Build userInputMessage
  const userInputMessage: Record<string, unknown> = {
    content: currentContent,
    modelId: kiroModelId,
    origin: "KIRO_CLI",
  }

  // Add tools and tool results to userInputMessageContext
  const userCtx: Record<string, unknown> = {}
  const kiroTools = toolsToKiroFormat(context.tools)
  if (kiroTools) userCtx.tools = kiroTools
  if (currentToolResults) userCtx.toolResults = currentToolResults
  if (Object.keys(userCtx).length > 0) {
    userInputMessage.userInputMessageContext = userCtx
  }

  const payload: KiroPayload = {
    conversationState: {
      conversationId: conversationId ?? randomUUID(),
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      currentMessage: { userInputMessage },
    },
    agentMode: "vibe",
  }

  if (history.length > 0) {
    payload.conversationState.history = history
  }

  if (profileArn) {
    payload.profileArn = profileArn
  }

  return payload
}
