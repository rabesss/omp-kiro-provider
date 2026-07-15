import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ModelLike } from "./types.ts"

export const DEFAULT_REGION = "us-east-1"

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const MODELS_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "models.json")

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

export interface DiscoveredModel {
  id: string
  name?: string
  supportedInputTypes?: string[]
  maxInputTokens?: number
  maxOutputTokens?: number
  additionalModelRequestFieldsSchema?: Record<string, unknown>
}

export interface DiscoveredModelsPage {
  models: DiscoveredModel[]
  nextToken?: string
}

interface ModelsJson {
  models: KiroModelDef[]
}

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

const modelsData = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8")) as ModelsJson
export const staticKiroModels = validateModelCatalog(modelsData.models)
const staticModelsById = new Map(staticKiroModels.map((model) => [model.id, model]))

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

export function serviceUrl(apiBase: string, path: string): URL {
  const base = `${apiBase.replace(/\/+$/, "")}/`
  return new URL(path.replace(/^\/+/, ""), base)
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
    baseUrl: serviceUrl(apiBase, "generateAssistantResponse").toString(),
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
      if (modality !== "text" && modality !== "image") {
        throw new Error(`${prefix}.input contains invalid modality ${String(modality)}`)
      }
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

export function parseDiscoveredModels(body: unknown): DiscoveredModelsPage {
  if (!isRecord(body) || !Array.isArray(body.models)) return { models: [] }

  const byId = new Map<string, DiscoveredModel>()
  for (const raw of body.models) {
    if (!isRecord(raw)) continue
    const rawId = readString(raw.modelId) ?? readString(raw.id)
    if (!rawId) continue

    const tokenLimits = isRecord(raw.tokenLimits) ? raw.tokenLimits : undefined
    const schema = isRecord(raw.additionalModelRequestFieldsSchema)
      ? raw.additionalModelRequestFieldsSchema
      : undefined
    const supportedInputTypes = Array.isArray(raw.supportedInputTypes)
      ? raw.supportedInputTypes.filter(isNonEmptyString)
      : undefined
    const id = toProviderModelId(rawId)

    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: readString(raw.modelName) ?? readString(raw.displayName) ?? readString(raw.name),
        supportedInputTypes,
        maxInputTokens: readPositiveInteger(tokenLimits?.maxInputTokens),
        maxOutputTokens: readPositiveInteger(tokenLimits?.maxOutputTokens),
        additionalModelRequestFieldsSchema: schema,
      })
    }
  }

  return {
    models: [...byId.values()],
    nextToken: readString(body.nextToken),
  }
}

export function mergeDiscoveredModels(discovered: DiscoveredModel[]): KiroModelDef[] {
  const merged: KiroModelDef[] = []
  const seen = new Set<string>()

  for (const remote of discovered) {
    if (seen.has(remote.id)) continue
    seen.add(remote.id)

    const fallback = staticModelsById.get(remote.id) ?? inferModelDefinition(remote.id)
    const remoteInput = inputModalities(remote.supportedInputTypes)
    merged.push({
      ...fallback,
      name: remote.name ?? fallback.name,
      reasoning: fallback.reasoning || supportsThinking(remote.additionalModelRequestFieldsSchema),
      input: remoteInput ?? [...fallback.input],
      contextWindow: remote.maxInputTokens ?? fallback.contextWindow,
      maxTokens: remote.maxOutputTokens ?? fallback.maxTokens,
      thinkingLevelMap: fallback.thinkingLevelMap ? { ...fallback.thinkingLevelMap } : undefined,
    })
  }

  if (!seen.has("auto")) {
    merged.push(staticModelsById.get("auto") ?? inferModelDefinition("auto"))
  }
  return validateModelCatalog(merged)
}

export function inferModelDefinition(id: string): KiroModelDef {
  const lower = id.toLowerCase()
  const claude = lower.startsWith("claude-")
  const gpt = lower.startsWith("gpt-")
  const auto = lower === "auto"
  const oneMillion = auto
    || lower.includes("1m")
    || lower === "claude-opus-4-8"
    || lower === "claude-opus-4-7"
  const reasoning = auto
    || gpt
    || (claude && !lower.includes("haiku"))
    || ["coder", "deepseek", "glm", "kimi"].some((family) => lower.includes(family))

  return {
    id,
    name: titleizeModelId(id),
    reasoning,
    reasoningHidden: gpt || undefined,
    input: claude || gpt || auto || lower.includes("agi-nova") ? ["text", "image"] : ["text"],
    contextWindow: oneMillion ? 1_000_000 : defaultContextWindow(lower),
    maxTokens: defaultMaxTokens(lower),
    thinkingLevelMap: defaultThinkingLevelMap(lower),
    firstTokenTimeout: gpt ? 180_000 : undefined,
  }
}

export function titleizeModelId(id: string): string {
  if (id === "auto") return "Auto"
  const parts = toKiroApiModelId(id).split("-").filter(Boolean)
  const first = brandName(parts.shift() ?? id)
  if (first === "GPT" && parts[0]) return [`GPT-${parts.shift()}`, ...parts.map(titlePart)].join(" ")
  return [first, ...parts.map(titlePart)].join(" ")
}

function defaultContextWindow(id: string): number {
  if (id.startsWith("gpt-")) return 272_000
  if (id.includes("qwen3-coder-next")) return 256_000
  if (id.includes("minimax")) return 196_000
  if (id.includes("deepseek")) return 164_000
  if (id.includes("glm-4-7") || id.includes("qwen3-coder-480b")) return 128_000
  return 200_000
}

function defaultMaxTokens(id: string): number {
  if (id.startsWith("gpt-") || id.includes("opus-4-8") || id.includes("opus-4-7")) return 128_000
  if (id.startsWith("claude-") || id === "auto" || id.includes("agi-nova")) return 65_536
  return 8_192
}

function defaultThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
  if (!id.startsWith("claude-")) return undefined
  if (/claude-(?:opus|sonnet)-(?:4-6|5(?:-|$))/.test(id)) {
    return { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" }
  }
  if (/claude-opus-4-[78]/.test(id)) {
    return { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }
  }
  return { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null, max: "max" }
}

function inputModalities(inputTypes: string[] | undefined): InputModality[] | undefined {
  if (!inputTypes || inputTypes.length === 0) return undefined
  const values = new Set<InputModality>(["text"])
  for (const value of inputTypes) {
    if (value.toLowerCase().includes("image")) values.add("image")
  }
  return [...values]
}

function supportsThinking(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || !isRecord(schema.properties)) return false
  const properties = schema.properties
  return ["thinking", "reasoning", "output_config"].some((key) => key in properties)
}

function brandName(value: string): string {
  const lower = value.toLowerCase()
  if (lower === "gpt") return "GPT"
  if (lower === "glm") return "GLM"
  if (lower === "agi") return "AGI"
  if (lower === "deepseek") return "DeepSeek"
  if (lower === "minimax") return "MiniMax"
  if (lower === "kimi") return "Kimi"
  if (lower === "claude") return "Claude"
  if (lower.startsWith("qwen")) return `Qwen${value.slice(4)}`
  return titlePart(value)
}

function titlePart(value: string): string {
  if (/^1m$/i.test(value)) return "(1M)"
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function validateThinkingLevelMap(map: unknown, prefix: string): void {
  if (!isRecord(map)) throw new Error(`${prefix}.thinkingLevelMap must be an object`)
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  for (const [key, value] of Object.entries(map)) {
    if (!allowed.has(key)) throw new Error(`${prefix}.thinkingLevelMap has invalid key ${key}`)
    if (value !== null && typeof value !== "string") {
      throw new Error(`${prefix}.thinkingLevelMap.${key} must be string or null`)
    }
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

function readString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined
}

function readPositiveInteger(value: unknown): number | undefined {
  return isPositiveInteger(value) ? value : undefined
}
