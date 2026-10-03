/**
 * Kiro provider for OMP: registers the `kiro/*` models, Kiro login, and streaming.
 * No external dependencies — pure TypeScript, Node builtins only. See README.md.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

import { createStreamKiro } from "./src/core.ts"
import { fetchDynamicKiroModels } from "./src/dynamic-models.ts"
import { loadModels } from "./src/models.ts"
import { getApiKey, getStoredProfileArn, login, refreshToken } from "./src/oauth.ts"
import { createAssistantMessageEventStream } from "./src/runtime.ts"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_REGION = "us-east-1"
const region = process.env.KIRO_REGION?.trim().toLowerCase() || DEFAULT_REGION
const DEFAULT_API_BASE = `https://runtime.${region}.kiro.dev`
const API_BASE = process.env.KIRO_API_BASE ?? DEFAULT_API_BASE
const MANAGEMENT_BASE = `https://management.${region}.kiro.dev`
const MODELS = loadModels()

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

const streamKiro = createStreamKiro({
  apiBase: API_BASE,
  managementBase: MANAGEMENT_BASE,
  fetchImpl: fetch,
  createStream: createAssistantMessageEventStream,
  now: () => Date.now(),
  env: process.env as Record<string, string | undefined>,
  hiddenReasoningModels: MODELS.filter((model) => model.reasoningHidden).map((model) => model.id),
})

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kiro", {
    baseUrl: API_BASE,
    // With KIRO_API_KEY unset, OMP's model discovery received this literal name as the key
    // instead of the OAuth token (observed on OMP 18.4.9) and cached an empty catalog.
    // Declare it only when the variable is actually set.
    ...(process.env.KIRO_API_KEY ? { apiKey: "KIRO_API_KEY" } : {}),
    authHeader: true,
    api: "kiro-custom" as never,
    streamSimple: streamKiro as never,
    oauth: {
      name: "Kiro",
      login,
      refreshToken,
      getApiKey,
    },
    models: MODELS,
    fetchDynamicModels: (apiKey?: string) => fetchDynamicKiroModels({
      apiKey,
      apiBase: MANAGEMENT_BASE,
      overlay: MODELS,
      profileArn: getStoredProfileArn(),
    }),
  })
}
