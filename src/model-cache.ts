import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  mergeDiscoveredModels,
  parseDiscoveredModels,
  resolveApiRegion,
  serviceUrl,
  validateModelCatalog,
  type DiscoveredModel,
  type KiroModelDef,
} from "./model-catalog.ts"

export const MODEL_CACHE_PATH = join(homedir(), ".cache", "omp-kiro-provider", "models.json")
export const MODEL_CACHE_TTL_MS = 60 * 60_000
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000

interface CachedModelFile {
  version: 1
  regions: Record<string, {
    updatedAt: number
    models: KiroModelDef[]
  }>
}

export interface RefreshKiroModelsOptions {
  accessToken: string
  apiBase: string
  region: string
  profileArn?: string
  fetchImpl: typeof fetch
  cachePath?: string
  now?: number
  timeoutMs?: number
}

const cacheFiles = new Map<string, CachedModelFile>()
const cacheLoads = new Map<string, Promise<CachedModelFile>>()
const refreshAttemptTimes = new Map<string, number>()
const refreshes = new Map<string, Promise<void>>()
const writeQueues = new Map<string, Promise<void>>()

export function readCachedModelsSync(
  region: string,
  now: number,
  cachePath = MODEL_CACHE_PATH,
): KiroModelDef[] | undefined {
  const cached = loadCacheFileSync(cachePath)
  return freshRegionModels(cached, region, now)
}

export function refreshKiroModelsCache(options: RefreshKiroModelsOptions): Promise<void> {
  if (!options.accessToken || options.accessToken.startsWith("ksk_")) return Promise.resolve()

  const region = resolveApiRegion(options.region)
  const cachePath = options.cachePath ?? MODEL_CACHE_PATH
  const key = cacheKey(region, cachePath)
  const existing = refreshes.get(key)
  if (existing) return existing

  let task: Promise<void>
  task = refreshOnce({ ...options, region, cachePath }).finally(() => {
    if (refreshes.get(key) === task) refreshes.delete(key)
  })
  refreshes.set(key, task)
  return task
}

async function refreshOnce(options: RefreshKiroModelsOptions & { region: string; cachePath: string }): Promise<void> {
  const now = options.now ?? Date.now()
  const cached = await loadCacheFile(options.cachePath)
  if (freshRegionModels(cached, options.region, now)) return

  const key = cacheKey(options.region, options.cachePath)
  const lastAttempt = refreshAttemptTimes.get(key)
  if (lastAttempt !== undefined && now - lastAttempt < MODEL_CACHE_TTL_MS) return
  refreshAttemptTimes.set(key, now)

  let discovered: DiscoveredModel[]
  try {
    discovered = await fetchAvailableModels(options)
  } catch {
    return
  }
  if (discovered.length === 0) return

  const models = mergeDiscoveredModels(discovered)
  await writeCacheEntry(options.cachePath, options.region, models, now)
}

async function fetchAvailableModels(options: RefreshKiroModelsOptions): Promise<DiscoveredModel[]> {
  const byId = new Map<string, DiscoveredModel>()
  const seenTokens = new Set<string>()
  let nextToken: string | undefined

  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const url = serviceUrl(options.apiBase, "ListAvailableModels")
    url.searchParams.set("origin", "AI_EDITOR")
    url.searchParams.set("maxResults", "50")
    if (options.profileArn) url.searchParams.set("profileArn", options.profileArn)
    if (nextToken) url.searchParams.set("nextToken", nextToken)

    const body = await fetchJsonWithTimeout(
      options.fetchImpl,
      url,
      options.accessToken,
      options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS,
    )
    const page = parseDiscoveredModels(body)
    for (const model of page.models) {
      if (!byId.has(model.id)) byId.set(model.id, model)
    }

    if (!page.nextToken) return [...byId.values()]
    if (seenTokens.has(page.nextToken)) throw new Error("ListAvailableModels returned a repeated nextToken")
    seenTokens.add(page.nextToken)
    nextToken = page.nextToken
  }

  throw new Error("ListAvailableModels exceeded the 20-page safety limit")
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  accessToken: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`ListAvailableModels returned HTTP ${response.status ?? "unknown"}`)
    return await response.json() as unknown
  } finally {
    clearTimeout(timer)
  }
}

function loadCacheFileSync(cachePath: string): CachedModelFile {
  const memory = cacheFiles.get(cachePath)
  if (memory) return memory

  const loaded = existsSync(cachePath)
    ? parseCacheFile(readFileSync(cachePath, "utf-8"))
    : emptyCache()
  cacheFiles.set(cachePath, loaded)
  return loaded
}

async function loadCacheFile(cachePath: string): Promise<CachedModelFile> {
  const memory = cacheFiles.get(cachePath)
  if (memory) return memory

  const pending = cacheLoads.get(cachePath)
  if (pending) return pending

  let task: Promise<CachedModelFile>
  task = readFile(cachePath, "utf-8")
    .then(parseCacheFile)
    .catch(() => emptyCache())
    .then((cache) => {
      cacheFiles.set(cachePath, cache)
      return cache
    })
    .finally(() => {
      if (cacheLoads.get(cachePath) === task) cacheLoads.delete(cachePath)
    })
  cacheLoads.set(cachePath, task)
  return task
}

function freshRegionModels(cache: CachedModelFile, region: string, now: number): KiroModelDef[] | undefined {
  const entry = cache.regions[resolveApiRegion(region)]
  if (!entry || now - entry.updatedAt >= MODEL_CACHE_TTL_MS) return undefined
  try {
    return validateModelCatalog(entry.models)
  } catch {
    return undefined
  }
}

async function writeCacheEntry(
  cachePath: string,
  region: string,
  models: KiroModelDef[],
  updatedAt: number,
): Promise<void> {
  const previous = writeQueues.get(cachePath) ?? Promise.resolve()
  let task: Promise<void>
  task = previous.catch(() => undefined).then(async () => {
    const current = await loadCacheFile(cachePath)
    const next: CachedModelFile = {
      version: 1,
      regions: {
        ...current.regions,
        [resolveApiRegion(region)]: { updatedAt, models: validateModelCatalog(models) },
      },
    }

    await mkdir(dirname(cachePath), { recursive: true })
    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
      await rename(temporaryPath, cachePath)
      cacheFiles.set(cachePath, next)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }).finally(() => {
    if (writeQueues.get(cachePath) === task) writeQueues.delete(cachePath)
  })
  writeQueues.set(cachePath, task)
  return task
}

function parseCacheFile(raw: string): CachedModelFile {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.regions)) return emptyCache()

    const regions: CachedModelFile["regions"] = {}
    for (const [region, rawEntry] of Object.entries(parsed.regions)) {
      if (!isRecord(rawEntry) || typeof rawEntry.updatedAt !== "number" || !Array.isArray(rawEntry.models)) continue
      regions[region] = {
        updatedAt: rawEntry.updatedAt,
        models: rawEntry.models as KiroModelDef[],
      }
    }
    return { version: 1, regions }
  } catch {
    return emptyCache()
  }
}

function emptyCache(): CachedModelFile {
  return { version: 1, regions: {} }
}

function cacheKey(region: string, cachePath: string): string {
  return `${region}\0${cachePath}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
