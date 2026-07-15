import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ModelLike } from "./types.ts"

export const DEFAULT_REGION = "us-east-1"
export const MODEL_CACHE_PATH = join(homedir(), ".cache", "omp-kiro-provider", "models.json")
export const MODEL_CACHE_TTL_MS = 60 * 60_000

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const MODELS_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "models.json")
const refreshAttemptTimes = new Map<string, number>()

export type InputModality = "text" | "image"
export type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
export type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, string | null>>

export interface KiroModelDef {
  id: string
  name: string
  reasoning: boolean
  reasoningHidden?: boolean
  input: InputModality[]
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: ThinkingLevelMap
  firstTokenTimeout?: number
}

interface ModelsJson {
  models: KiroModelDef[]
}

interface CachedModelFile {
  version: 1
  regions: Record<string, {
    updatedAt: number
    models: KiroModelDef[]
  }>
}

const modelsData = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8")) as ModelsJson

const REGION_ALIASES: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
}

const MODELS_BY_REGION: Record<string, Set<string>> = {
  "us-east-1": new Set([
    "auto",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-6-1m",
    "claude-opus-4-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-1m",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-1m",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "deepseek-3-2",
    "kimi-k2-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-5",
    "glm-4-7",
    "glm-4-7-flash",
    "qwen3-coder-next",
    "qwen3-coder-480b",
    "agi-nova-beta-1m",
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-6-luna",
  ]),
  "eu-central-1": new Set([
    "auto",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "qwen3-coder-next",
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-6-luna",
  ]),
}

export const staticKiroModels = validateModelCatalog(modelsData.models)

export function defaultApiBase(region: string): string {
  return `https://q.${resolveApiRegion(region)}.amazonaws.com`
}

export function resolveApiRegion(region: string | undefined): string {
  if (!region) return DEFAULT_REGION
  return REGION_ALIASES[region] ?? region
}

export function apiRegionFromBase(apiBase: string): string | undefined {
  try {
    const host = new URL(apiBase).hostname
    const match = host.match(/^q\.([a-z0-9-]+)\.amazonaws\.com$/)
    return match?.[1]
  } catch {
    return undefined
  }
}

export function toKiroApiModelId(modelId: string): string {
  return modelId.replace(/(\d)-(\d)(?!\d)/g, "$1.$2")
}

export function toProviderModelId(modelId: string): string {
  return modelId.replace(/(\d)\.(\d)/g, "$1-$2")
}

export function filterModelsByRegion<T extends { id: string }>(models: T[], region: string): T[] {
  const allowed = MODELS_BY_REGION[resolveApiRegion(region)]
  if (!allowed) return models
  return models.filter((model) => allowed.has(model.id))
}

export function loadRegisteredModels(options: {
  region: string
  apiBase: string
  now?: number
  cachePath?: string
}): ModelLike[] {
  const now = options.now ?? Date.now()
  const cached = readCachedModels(options.region, now, options.cachePath)
  const source = cached ?? filterModelsByRegion(staticKiroModels, options.region)
  return validateModelCatalog(source).map((model) => toProviderModel(model, options.apiBase))
}

export function toProviderModel(model: KiroModelDef, apiBase: string): ModelLike {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    reasoningHidden: model.reasoningHidden,
    input: [...model.input],
    cost: { ...ZERO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    api: "kiro-custom",
    provider: "kiro",
    baseUrl: `${apiBase}/generateAssistantResponse`,
    thinkingLevelMap: model.thinkingLevelMap,
    firstTokenTimeout: model.firstTokenTimeout,
  }
}

export function validateModelCatalog(models: unknown): KiroModelDef[] {
  if (!Array.isArray(models)) throw new Error("models.json must contain a models array")

  const seen = new Set<string>()
  return models.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`models[${index}] must be an object`)
    const model = raw as Partial<KiroModelDef>
    const prefix = `models[${index}]`

    if (!isNonEmptyString(model.id)) throw new Error(`${prefix}.id must be a non-empty string`)
    if (seen.has(model.id)) throw new Error(`${prefix}.id duplicates ${model.id}`)
    seen.add(model.id)

    if (!isNonEmptyString(model.name)) throw new Error(`${prefix}.name must be a non-empty string`)
    if (typeof model.reasoning !== "boolean") throw new Error(`${prefix}.reasoning must be boolean`)
    if (model.reasoningHidden !== undefined && typeof model.reasoningHidden !== "boolean") {
      throw new Error(`${prefix}.reasoningHidden must be boolean when present`)
    }
    if (!Array.isArray(model.input) || model.input.length === 0) {
      throw new Error(`${prefix}.input must be a non-empty array`)
    }
    for (const modality of model.input) {
      if (modality !== "text" && modality !== "image") throw new Error(`${prefix}.input contains invalid modality ${String(modality)}`)
    }
    if (!isPositiveInteger(model.contextWindow)) throw new Error(`${prefix}.contextWindow must be a positive integer`)
    if (!isPositiveInteger(model.maxTokens)) throw new Error(`${prefix}.maxTokens must be a positive integer`)
    if (model.thinkingLevelMap !== undefined) validateThinkingLevelMap(model.thinkingLevelMap, prefix)
    if (model.firstTokenTimeout !== undefined && !isPositiveInteger(model.firstTokenTimeout)) {
      throw new Error(`${prefix}.firstTokenTimeout must be a positive integer when present`)
    }

    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      reasoningHidden: model.reasoningHidden,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
      firstTokenTimeout: model.firstTokenTimeout,
    }
  })
}

export async function refreshKiroModelsCache(options: {
  accessToken: string
  apiBase: string
  region: string
  profileArn?: string
  fetchImpl: typeof fetch
  cachePath?: string
  now?: number
}): Promise<void> {
  if (!options.accessToken || options.accessToken.startsWith("ksk_")) return

  const now = options.now ?? Date.now()
  const region = resolveApiRegion(options.region)
  const cachePath = options.cachePath ?? MODEL_CACHE_PATH
  if (readCachedModels(region, now, cachePath)) return

  const refreshKey = `${region}\0${cachePath}`
  const lastAttempt = refreshAttemptTimes.get(refreshKey)
  if (lastAttempt !== undefined && now - lastAttempt < MODEL_CACHE_TTL_MS) return
  refreshAttemptTimes.set(refreshKey, now)

  const url = new URL(`${options.apiBase}/ListAvailableModels`)
  url.searchParams.set("origin", "AI_EDITOR")
  if (options.profileArn) url.searchParams.set("profileArn", options.profileArn)

  const response = await options.fetchImpl(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${options.accessToken}` },
  })
  if (!response.ok) return

  const body = await response.json() as unknown
  const discovered = parseDiscoveredModels(body)
  if (discovered.length === 0) return

  const models = validateModelCatalog(mergeDiscoveredModels(discovered, region))
  writeCachedModels(region, models, now, cachePath)
}

export function parseDiscoveredModels(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.models)) return []
  const ids: string[] = []
  for (const entry of body.models) {
    if (!isRecord(entry)) continue
    const id = typeof entry.modelId === "string"
      ? entry.modelId
      : typeof entry.id === "string"
        ? entry.id
        : undefined
    if (!id) continue
    ids.push(toProviderModelId(id))
  }
  return [...new Set(ids)]
}

export function mergeDiscoveredModels(modelIds: string[], region: string): KiroModelDef[] {
  const byId = new Map(staticKiroModels.map((model) => [model.id, model]))
  const merged = modelIds.map((id) => byId.get(id) ?? inferModelDefinition(id))
  if (!merged.some((model) => model.id === "auto")) {
    merged.push(byId.get("auto") ?? inferModelDefinition("auto"))
  }
  return filterModelsByRegion(merged, region)
}

function readCachedModels(region: string, now: number, cachePath = MODEL_CACHE_PATH): KiroModelDef[] | undefined {
  if (!existsSync(cachePath)) return undefined
  try {
    const stat = statSync(cachePath)
    if (now - stat.mtimeMs > MODEL_CACHE_TTL_MS) return undefined
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as CachedModelFile
    const entry = parsed.regions?.[resolveApiRegion(region)]
    if (!entry || now - entry.updatedAt > MODEL_CACHE_TTL_MS) return undefined
    return validateModelCatalog(entry.models)
  } catch {
    return undefined
  }
}

function writeCachedModels(region: string, models: KiroModelDef[], updatedAt: number, cachePath = MODEL_CACHE_PATH): void {
  let cache: CachedModelFile = { version: 1, regions: {} }
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as CachedModelFile
      if (parsed.version === 1 && isRecord(parsed.regions)) cache = parsed
    } catch {
      // Overwrite malformed cache below.
    }
  }
  cache.regions[resolveApiRegion(region)] = { updatedAt, models }
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf-8")
}

function inferModelDefinition(id: string): KiroModelDef {
  const name = titleizeModelId(id)
  const claude = id.startsWith("claude-")
  const reasoning = id === "auto" || claude || id.includes("coder") || id.includes("deepseek") || id.includes("glm") || id.includes("kimi")
  const oneMillion = id === "auto" || id.includes("1m") || id === "claude-opus-4-8" || id.endsWith("-4-7")
  return {
    id,
    name,
    reasoning,
    input: claude || id === "auto" || id.includes("agi-nova") ? ["text", "image"] : ["text"],
    contextWindow: oneMillion ? 1_000_000 : defaultContextWindow(id),
    maxTokens: defaultMaxTokens(id),
    thinkingLevelMap: defaultThinkingLevelMap(id),
  }
}

function defaultContextWindow(id: string): number {
  if (id.includes("qwen3-coder-next")) return 256_000
  if (id.includes("minimax")) return 196_000
  if (id.includes("deepseek")) return 164_000
  if (id.includes("glm-4-7")) return 128_000
  if (id.includes("qwen3-coder-480b")) return 128_000
  return 200_000
}

function defaultMaxTokens(id: string): number {
  if (id.includes("opus-4-8") || id.includes("opus-4-7")) return 128_000
  if (id.startsWith("claude-") || id === "auto" || id.includes("agi-nova")) return 65_536
  return 8_192
}

function defaultThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
  if (!id.startsWith("claude-")) return undefined
  if (/claude-(?:opus|sonnet)-4-6/.test(id)) {
    return { off: "disabled", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" }
  }
  if (/claude-opus-4-[78]/.test(id)) {
    return { off: "disabled", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }
  }
  return { off: "disabled", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null, max: "max" }
}

function titleizeModelId(id: string): string {
  if (id === "auto") return "Auto"
  return id
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\b1m\b/i, "(1M)")
    .replace(/\bGlm\b/g, "GLM")
    .replace(/\bQwen\b/g, "Qwen")
    .replace(/\bKimi\b/g, "Kimi")
    .replace(/\bAgi\b/g, "AGI")
}

function validateThinkingLevelMap(map: unknown, prefix: string): void {
  if (!isRecord(map)) throw new Error(`${prefix}.thinkingLevelMap must be an object`)
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  for (const [key, value] of Object.entries(map)) {
    if (!allowed.has(key)) throw new Error(`${prefix}.thinkingLevelMap has invalid key ${key}`)
    if (value !== null && typeof value !== "string") throw new Error(`${prefix}.thinkingLevelMap.${key} must be string or null`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}
