import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { loadModels } from "../src/models.ts"

describe("Kiro model catalog", () => {
  it("loads a unique, valid static catalog", () => {
    const models = loadModels()

    assert.ok(models.length > 0)
    assert.equal(new Set(models.map((model) => model.id)).size, models.length)
    assert.ok(models.every((model) => model.contextWindow > 0 && model.maxTokens > 0))
    assert.ok(models.every((model) => model.cost.input === 0 && model.cost.output === 0))
    assert.notEqual(models[0].cost, models[1].cost)
    // Every models.json field reaches OMP, including the reasoningHidden that index.ts reads.
    const { models: listed } = JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf-8"))
    assert.deepEqual(models.map(({ cost: _cost, ...model }) => model), listed)
  })
})
