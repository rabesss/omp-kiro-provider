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

import { createStreamKiro } from "./src/core.ts"
import { DEFAULT_REGION, defaultApiBase, loadRegisteredModels, resolveApiRegion } from "./src/models.ts"
import { getApiKey, login, refreshToken } from "./src/oauth.ts"
import { calculateCost, createAssistantMessageEventStream } from "./src/runtime.ts"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const region = resolveApiRegion(process.env.KIRO_REGION ?? DEFAULT_REGION)
const DEFAULT_API_BASE = defaultApiBase(region)
const API_BASE = process.env.KIRO_API_BASE ?? DEFAULT_API_BASE
const MODELS = loadRegisteredModels({ region, apiBase: API_BASE })

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
