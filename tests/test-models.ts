import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveReasoningLevel } from "../src/core.ts"
import {
  filterModelsByRegion,
  loadRegisteredModels,
  MODEL_CACHE_TTL_MS,
  mergeDiscoveredModels,
  parseDiscoveredModels,
  refreshKiroModelsCache,
  staticKiroModels,
  toKiroApiModelId,
  toProviderModelId,
  validateModelCatalog,
} from "../src/models.ts"

describe("Kiro model catalog", () => {
  it("validates the committed model catalog", () => {
    const models = validateModelCatalog(staticKiroModels)
    assert.ok(models.length >= 20)
    assert.equal(new Set(models.map((model) => model.id)).size, models.length)
    assert.ok(models.some((model) => model.id === "claude-opus-4-5"))
    assert.ok(models.some((model) => model.id === "claude-opus-4-8"))
    assert.ok(models.some((model) => model.id === "claude-sonnet-5"))
    assert.ok(models.some((model) => model.id === "agi-nova-beta-1m"))
    assert.ok(models.some((model) => model.id === "gpt-5-6-sol"))
    assert.ok(models.some((model) => model.id === "gpt-5-6-terra"))
    assert.ok(models.some((model) => model.id === "gpt-5-6-luna"))
  })

  it("rejects malformed or duplicate model descriptors", () => {
    assert.throws(() => validateModelCatalog([{ name: "missing id" }]), /id/)
    assert.throws(
      () => validateModelCatalog([
        validModel("duplicate"),
        validModel("duplicate"),
      ]),
      /duplicates/,
    )
    assert.throws(() => validateModelCatalog([{ ...validModel("bad-input"), input: ["audio"] }]), /invalid modality/)
    assert.throws(() => validateModelCatalog([{ ...validModel("bad-window"), contextWindow: 0 }]), /contextWindow/)
  })

  it("converts provider model IDs to Kiro API IDs and back", () => {
    assert.equal(toKiroApiModelId("claude-sonnet-4-6"), "claude-sonnet-4.6")
    assert.equal(toKiroApiModelId("claude-sonnet-4-6-1m"), "claude-sonnet-4.6-1m")
    assert.equal(toKiroApiModelId("kimi-k2-5"), "kimi-k2.5")
    assert.equal(toKiroApiModelId("gpt-5-6-sol"), "gpt-5.6-sol")
    assert.equal(toProviderModelId("glm-4.7-flash"), "glm-4-7-flash")
    assert.equal(toProviderModelId("gpt-5.6-terra"), "gpt-5-6-terra")
  })

  it("filters static fallback models by API region", () => {
    const us = filterModelsByRegion(staticKiroModels, "us-east-1")
    const eu = filterModelsByRegion(staticKiroModels, "eu-west-1")

    assert.ok(us.some((model) => model.id === "glm-5"))
    assert.ok(us.some((model) => model.id === "gpt-5-6-sol"))
    assert.equal(eu.some((model) => model.id === "glm-5"), false)
    assert.ok(eu.some((model) => model.id === "claude-sonnet-4-6"))
    assert.ok(eu.some((model) => model.id === "claude-sonnet-5"))
    assert.ok(eu.some((model) => model.id === "gpt-5-6-luna"))
  })

  it("loads registered provider models from static fallback", () => {
    const models = loadRegisteredModels({
      region: "us-east-1",
      apiBase: "https://q.us-east-1.amazonaws.com",
      cachePath: join(tmpdir(), `missing-kiro-cache-${Date.now()}.json`),
    })

    const opus = models.find((model) => model.id === "claude-opus-4-8")
    assert.ok(opus)
    assert.equal(opus.provider, "kiro")
    assert.equal(opus.api, "kiro-custom")
    assert.equal(opus.cost?.input, 0)
    assert.equal(opus.thinkingLevelMap?.xhigh, "xhigh")

    const gpt = models.find((model) => model.id === "gpt-5-6-sol")
    assert.ok(gpt)
    assert.equal(gpt.reasoningHidden, true)
    assert.equal(gpt.contextWindow, 272_000)
    assert.equal(gpt.maxTokens, 128_000)
  })

  it("parses and merges ListAvailableModels output", () => {
    const ids = parseDiscoveredModels({
      models: [
        { modelId: "claude-opus-4.5" },
        { modelId: "qwen3-coder-480b" },
        { id: "glm-4.7-flash" },
        { modelId: "claude-opus-4.5" },
      ],
    })

    assert.deepEqual(ids, ["claude-opus-4-5", "qwen3-coder-480b", "glm-4-7-flash"])

    const merged = mergeDiscoveredModels(ids, "us-east-1")
    assert.ok(merged.some((model) => model.id === "auto"))
    assert.ok(merged.some((model) => model.id === "claude-opus-4-5"))
    assert.ok(merged.some((model) => model.id === "glm-4-7-flash"))
  })

  it("refreshes and reloads the dynamic model cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-kiro-model-cache-"))
    const cachePath = join(dir, "models.json")
    const now = Date.now()

    try {
      await refreshKiroModelsCache({
        accessToken: "access-token",
        apiBase: "https://q.us-east-1.amazonaws.com",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
        cachePath,
        now,
        fetchImpl: async (url, init) => {
          assert.ok(String(url).includes("/ListAvailableModels"))
          assert.ok(String(url).includes("profileArn="))
          assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access-token")
          return {
            ok: true,
            json: async () => ({
              models: [
                { modelId: "claude-opus-4.5" },
                { modelId: "glm-4.7" },
              ],
            }),
          } as Response
        },
      })

      const cache = JSON.parse(readFileSync(cachePath, "utf-8"))
      assert.ok(cache.regions["us-east-1"])

      let skippedFetches = 0
      await refreshKiroModelsCache({
        accessToken: "access-token",
        apiBase: "https://q.us-east-1.amazonaws.com",
        region: "us-east-1",
        cachePath,
        now: now + 1,
        fetchImpl: async () => {
          skippedFetches += 1
          throw new Error("fresh cache should skip discovery")
        },
      })
      assert.equal(skippedFetches, 0)

      const models = loadRegisteredModels({
        region: "us-east-1",
        apiBase: "https://q.us-east-1.amazonaws.com",
        cachePath,
        now,
      })
      assert.deepEqual(models.map((model) => model.id), ["claude-opus-4-5", "glm-4-7", "auto"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throttles failed dynamic model discovery attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-kiro-model-cache-failed-"))
    const cachePath = join(dir, "models.json")
    const now = Date.now()
    let fetches = 0

    try {
      const options = {
        accessToken: "access-token",
        apiBase: "https://q.us-east-1.amazonaws.com",
        region: "us-east-1",
        cachePath,
        fetchImpl: async () => {
          fetches += 1
          return { ok: false } as Response
        },
      }

      await refreshKiroModelsCache({ ...options, now })
      await refreshKiroModelsCache({ ...options, now: now + MODEL_CACHE_TTL_MS - 1 })

      assert.equal(fetches, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Kiro reasoning levels", () => {
  it("supports minimal and max levels", () => {
    assert.equal(resolveReasoningLevel({ id: "m", name: "M" }, { reasoning: "minimal" }), "minimal")
    assert.equal(resolveReasoningLevel({ id: "m", name: "M" }, { reasoning: "max" }), "max")
  })

  it("applies per-model thinking level maps", () => {
    assert.equal(
      resolveReasoningLevel(
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", thinkingLevelMap: { xhigh: "max" } },
        { reasoning: "xhigh" },
      ),
      "max",
    )
  })
})

function validModel(id: string) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 1000,
  }
}
