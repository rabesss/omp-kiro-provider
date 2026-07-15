import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { loadModels } from "../src/models.ts"

const REQUIRED_MODELS = [
  "claude-opus-4-5",
  "claude-opus-4-6-1m",
  "claude-sonnet-4-5-1m",
  "claude-sonnet-4-6-1m",
  "claude-sonnet-5",
  "kimi-k2-5",
  "qwen3-coder-480b",
  "glm-4-7",
  "glm-4-7-flash",
  "agi-nova-beta-1m",
  "gpt-5-6-sol",
  "gpt-5-6-terra",
  "gpt-5-6-luna",
]

describe("Kiro model catalog", () => {
  it("loads a unique, valid static catalog", () => {
    const models = loadModels()

    assert.equal(models.length, 26)
    assert.equal(new Set(models.map((model) => model.id)).size, models.length)
    assert.deepEqual(
      REQUIRED_MODELS.filter((id) => !models.some((model) => model.id === id)),
      [],
    )
    assert.ok(models.every((model) => model.contextWindow > 0 && model.maxTokens > 0))
    assert.ok(models.every((model) => model.cost.input === 0 && model.cost.output === 0))
    assert.notEqual(models[0].cost, models[1].cost)
  })

  it("keeps the new flagship model metadata explicit", () => {
    const byId = new Map(loadModels().map((model) => [model.id, model]))

    assert.deepEqual(byId.get("claude-sonnet-5"), {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })

    for (const id of ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-5-6-luna"]) {
      const model = byId.get(id)
      assert.ok(model)
      assert.equal(model.reasoningHidden, true)
      assert.deepEqual(model.input, ["text", "image"])
      assert.equal(model.contextWindow, 272_000)
      assert.equal(model.maxTokens, 128_000)
    }
  })
})
