/**
 * Shared types for the Kiro OMP provider.
 *
 * These types match the OMP provider contract exactly — identical to
 * omp-commandcode-provider/src/types.ts — so OMP can use any provider
 * interchangeably.
 */

// ---------------------------------------------------------------------------
// Stop / error reasons
// ---------------------------------------------------------------------------

export type StopReason = "stop" | "length" | "toolUse"
export type ErrorReason = "error" | "aborted"
export type TerminalReason = StopReason | ErrorReason

// ---------------------------------------------------------------------------
// Cost & usage
// ---------------------------------------------------------------------------

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: UsageCost
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text"
  text: string
}

export interface ThinkingContent {
  type: "thinking"
  thinking: string
  redacted?: boolean
}

export interface ToolCallContent {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

// ---------------------------------------------------------------------------
// Message shapes (OMP contract)
// ---------------------------------------------------------------------------

export interface AssistantMessageLike {
  role: "assistant"
  content: AssistantContent[]
  api: string
  provider: string
  model: string
  usage: Usage
  stopReason: TerminalReason
  errorMessage?: string
  timestamp: number
}

export interface ModelLike {
  id: string
  name: string
  reasoning: boolean
  reasoningHidden?: boolean
  input: ("text" | "image")[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  api: string
  provider: string
}

export interface MessageLike {
  role: "user" | "assistant"
  content: string
  toolCalls?: ToolCallContent[]
  toolResults?: Array<{ toolCallId: string; content: string }>
}

export interface ToolLike {
  name: string
  description: string
  parameters?: unknown
  input_schema?: Record<string, unknown>
}

export interface ContextLike {
  systemPrompt?: string
  messages: MessageLike[]
  tools?: ToolLike[]
}

// ---------------------------------------------------------------------------
// Provider response info
// ---------------------------------------------------------------------------

export interface ProviderResponseInfo {
  status: number
  headers: Record<string, string>
}

// ---------------------------------------------------------------------------
// Stream options
// ---------------------------------------------------------------------------

export interface StreamOptions {
  apiKey?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  maxTokens?: number
  reasoning?: boolean | "low" | "medium" | "high" | "xhigh"
  toolChoice?: "auto" | "none" | string
  onPayload?: (body: unknown, model: ModelLike) => unknown | Promise<unknown>
  onResponse?: (info: ProviderResponseInfo, model: ModelLike) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessageLike }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessageLike }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessageLike }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessageLike }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessageLike }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessageLike }
  | { type: "done"; reason: StopReason; message: AssistantMessageLike }
  | { type: "error"; reason: ErrorReason; error: AssistantMessageLike }

export interface AssistantMessageEventStreamLike extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void
  end(result?: AssistantMessageLike): void
  result(): Promise<AssistantMessageLike>
}

// ---------------------------------------------------------------------------
// Core dependencies (injectable for testing)
// ---------------------------------------------------------------------------

export interface CoreDependencies {
  apiBase: string
  fetchImpl: typeof fetch
  createStream: () => AssistantMessageEventStreamLike
  cwd: () => string
  now: () => number
  uuid: () => string
  env: Record<string, string | undefined>
  authPaths: string[]
  homeDir: string
  calculateCost: (model: ModelLike, usage: Usage) => void
}
// ---------------------------------------------------------------------------
// Kiro-specific auth metadata (stored separately from OMP credentials)
// ---------------------------------------------------------------------------
export interface OAuthAuthInfo { url: string; instructions?: string }
export interface OAuthPrompt { message: string; placeholder?: string; allowEmpty?: boolean }
export interface OAuthLoginCallbacks {
  onAuth(info: OAuthAuthInfo): void | Promise<void>
  onPrompt(prompt: OAuthPrompt): Promise<string>
}
// ---------------------------------------------------------------------------
// Kiro-specific auth metadata (stored separately from OMP credentials)
// ---------------------------------------------------------------------------

export interface KiroAuthMeta {
  /** Auth method: "social" | "idc" | "apikey" */
  method: string
  /** OIDC client registration (needed for IDC refresh) */
  clientId?: string
  clientSecret?: string
  /** AWS region for token endpoint routing */
  region?: string
  /** profileArn from Kiro auth (sent in API requests) */
  profileArn?: string
}
