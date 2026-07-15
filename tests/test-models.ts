import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveReasoningLevel } from "../src/core.ts"
import {
  filterModelsByRegion,
  loadRegisteredModels,
  MODEL_DISCOVERY_TIMEOUT_MS,
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
    const page = parseDiscoveredModels({
      models: [
        { modelId: "claude-opus-4.5" },
        { modelId: "qwen3-coder-480b" },
        { id: "glm-4.7-flash" },
        { modelId: "claude-opus-4.5" },
        {
          modelId: "gpt-5.7-nova",
          supportedInputTypes: ["TEXT", "IMAGE"],
          tokenLimits: { maxInputTokens: 300_000, maxOutputTokens: 100_000 },
          additionalModelRequestFieldsSchema: { properties: { reasoning: {} } },
        },
      ],
      nextToken: "next-page",
    })

    assert.deepEqual(page.models.map((model) => model.id), [
      "claude-opus-4-5",
      "qwen3-coder-480b",
      "glm-4-7-flash",
      "gpt-5-7-nova",
    ])
    assert.equal(page.nextToken, "next-page")

    const merged = mergeDiscoveredModels(page.models)
    assert.ok(merged.some((model) => model.id === "auto"))
    assert.ok(merged.some((model) => model.id === "claude-opus-4-5"))
    assert.ok(merged.some((model) => model.id === "glm-4-7-flash"))

    const futureGpt = merged.find((model) => model.id === "gpt-5-7-nova")
    assert.ok(futureGpt)
    assert.equal(futureGpt.name, "GPT-5.7 Nova")
    assert.equal(futureGpt.reasoning, true)
    assert.equal(futureGpt.reasoningHidden, true)
    assert.deepEqual(futureGpt.input, ["text", "image"])
    assert.equal(futureGpt.contextWindow, 300_000)
    assert.equal(futureGpt.maxTokens, 100_000)
    assert.equal(futureGpt.firstTokenTimeout, 180_000)
  })

  it("refreshes and reloads the dynamic model cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-kiro-model-cache-"))
    const cachePath = join(dir, "models.json")
    const now = Date.now()

    try {
      let fetches = 0
      await refreshKiroModelsCache({
        accessToken: "access-token",
        apiBase: "https://q.us-east-1.amazonaws.com/",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
        cachePath,
        now,
        fetchImpl: async (url, init) => {
          fetches += 1
          assert.equal(new URL(String(url)).pathname, "/ListAvailableModels")
          assert.ok(String(url).includes("profileArn="))
          assert.ok(String(url).includes("maxResults=50"))
          assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access-token")
          assert.ok(init?.signal)
          if (String(url).includes("nextToken=")) {
            return {
              ok: true,
              json: async () => ({ models: [{ modelId: "glm-4.7" }] }),
            } as Response
          }
          return {
            ok: true,
            json: async () => ({
              models: [{ modelId: "claude-opus-4.5" }],
              nextToken: "page-2",
            }),
          } as Response
        },
      })
      assert.equal(fetches, 2)

      const cache = JSON.parse(readFileSync(cachePath, "utf-8"))
      assert.ok(cache.regions["us-east-1"])
      assert.equal(readdirSync(dir).some((file) => file.endsWith(".tmp")), false)

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

  it("deduplicates concurrent refreshes and bounds hung requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-kiro-model-cache-timeout-"))
    const cachePath = join(dir, "models.json")
    let fetches = 0

    try {
      const options = {
        accessToken: "access-token",
        apiBase: "https://q.us-east-1.amazonaws.com///",
        region: "us-east-1",
        cachePath,
        now: Date.now(),
        timeoutMs: 5,
        fetchImpl: (url: string | URL | Request, init?: RequestInit) => {
          fetches += 1
          assert.equal(new URL(String(url)).pathname, "/ListAvailableModels")
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
          })
        },
      }

      await Promise.all([
        refreshKiroModelsCache(options),
        refreshKiroModelsCache(options),
      ])
      assert.equal(fetches, 1)
      assert.equal(MODEL_DISCOVERY_TIMEOUT_MS, 10_000)
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
