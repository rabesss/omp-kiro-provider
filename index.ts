/**
 * Kiro provider for OMP.
 *
 * Native OMP local plugin that integrates Kiro (kiro.dev) as a provider,
 * following the exact same contract as omp-commandcode-provider.
 *
 * Supports:
 * - API Key login (ksk_xxx)
 * - Social OAuth token reuse (Google/GitHub)
 * - AWS Builder ID device code flow (browser login)
 * - Automatic token refresh (social + OIDC)
 *
 * Anti-detection: mimics real Kiro IDE headers exactly.
 * No external dependencies — pure TypeScript, Node builtins only.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

import modelsJsonData from "./models.json" with { type: "json" }
import { createStreamKiro } from "./src/core.ts"
import { getApiKey, login, refreshToken } from "./src/oauth.ts"
import { calculateCost, createAssistantMessageEventStream } from "./src/runtime.ts"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_REGION = "us-east-1"
const region = process.env.KIRO_REGION ?? DEFAULT_REGION
const DEFAULT_API_BASE = `https://q.${region}.amazonaws.com`
const API_BASE = process.env.KIRO_API_BASE ?? DEFAULT_API_BASE

// ---------------------------------------------------------------------------
// Load model definitions
// ---------------------------------------------------------------------------

interface ModelDef {
  id: string
  name: string
  reasoning: boolean
  reasoningHidden?: boolean
  input: ("text" | "image")[]
  contextWindow: number
  maxTokens: number
}

const modelsData = modelsJsonData as { models: ModelDef[] }

const MODELS = modelsData.models.map((m) => ({
  id: m.id,
  name: m.name,
  reasoning: m.reasoning,
  reasoningHidden: m.reasoningHidden,
  input: m.input,
  // Kiro is free during trial; after trial, subscription covers usage.
  // Cost is required by OMP's ProviderConfigInput — set all to 0.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
}))

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

const streamKiro = createStreamKiro({
  apiBase: API_BASE,
  fetchImpl: fetch,
  createStream: createAssistantMessageEventStream,
  cwd: () => process.cwd(),
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  env: process.env as Record<string, string | undefined>,
  authPaths: [],
  homeDir: "",
  calculateCost,
})

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kiro", {
    name: "Kiro",
    baseUrl: API_BASE,
    apiKey: "KIRO_API_KEY",
    authHeader: true,
    api: "kiro-custom" as never, // custom API type — OMP doesn't validate this
    streamSimple: streamKiro as never, // types diverge between internal/OMP; runtime contract matches
    oauth: {
      name: "Kiro",
      login,
      refreshToken,
      getApiKey,
    },
    models: MODELS,
  })
}
