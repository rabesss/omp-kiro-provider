import { readCachedModelsSync } from "./model-cache.ts"
import {
  filterModelsByRegion,
  staticKiroModels,
  toProviderModel,
  type KiroModelDef,
} from "./model-catalog.ts"
import type { ModelLike } from "./types.ts"

export {
  MODEL_CACHE_PATH,
  MODEL_CACHE_TTL_MS,
  MODEL_DISCOVERY_TIMEOUT_MS,
  refreshKiroModelsCache,
  type RefreshKiroModelsOptions,
} from "./model-cache.ts"

export {
  DEFAULT_REGION,
  apiRegionFromBase,
  defaultApiBase,
  filterModelsByRegion,
  inferModelDefinition,
  mergeDiscoveredModels,
  parseDiscoveredModels,
  resolveApiRegion,
  serviceUrl,
  staticKiroModels,
  titleizeModelId,
  toKiroApiModelId,
  toProviderModel,
  toProviderModelId,
  validateModelCatalog,
  type DiscoveredModel,
  type DiscoveredModelsPage,
  type InputModality,
  type KiroModelDef,
  type ThinkingLevelKey,
  type ThinkingLevelMap,
} from "./model-catalog.ts"

export function loadRegisteredModels(options: {
  region: string
  apiBase: string
  now?: number
  cachePath?: string
}): ModelLike[] {
  const now = options.now ?? Date.now()
  const cached = readCachedModelsSync(options.region, now, options.cachePath)
  const source: KiroModelDef[] = cached ?? filterModelsByRegion(staticKiroModels, options.region)
  return source.map((model) => toProviderModel(model, options.apiBase))
}
