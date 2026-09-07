import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildListAvailableModelsUrl,
  fetchDynamicKiroModels,
  mergeLiveWithOverlay,
  parseLiveModels,
  type OverlayModel,
} from "../src/dynamic-models.ts"

const API_BASE = "https://q.us-east-1.amazonaws.com"
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const OVERLAY: OverlayModel[] = [
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { ...ZERO_COST },
  },
  {
    id: "overlay-only",
    name: "Overlay Only",
    reasoning: false,
    input: ["text"],
    contextWindow: 50_000,
    maxTokens: 4096,
    cost: { ...ZERO_COST },
  },
]

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const bytes = new TextEncoder().encode(text)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text,
    arrayBuffer: async () => bytes.slice().buffer,
  } as Response
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined
  return (headers as Record<string, string>)[name]
}

describe("buildListAvailableModelsUrl", () => {
  it("strips trailing slashes and always sets origin", () => {
    const url = new URL(buildListAvailableModelsUrl(`${API_BASE}///`))
    assert.equal(url.origin + url.pathname, `${API_BASE}/ListAvailableModels`)
    assert.equal(url.searchParams.get("origin"), "AI_EDITOR")
    assert.equal(url.searchParams.get("profileArn"), null)
  })

  it("encodes profileArn only when provided", () => {
    const arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
    const url = new URL(buildListAvailableModelsUrl(API_BASE, "AI_EDITOR", arn))
    assert.equal(url.searchParams.get("profileArn"), arn)
    assert.match(url.search, /profileArn=arn%3Aaws%3A/)
  })
})

describe("parseLiveModels", () => {
  it("parses models and availableModels", () => {
    assert.deepEqual(
      parseLiveModels({
        models: [{ modelId: "a", modelName: "A" }],
      }),
      [{ id: "a", name: "A" }],
    )
    assert.deepEqual(
      parseLiveModels({
        availableModels: [{ id: "b", name: "B" }],
      }),
      [{ id: "b", name: "B" }],
    )
  })

  it("prefers models when both arrays exist", () => {
    assert.deepEqual(
      parseLiveModels({
        models: [{ modelId: "from-models" }],
        availableModels: [{ modelId: "from-available" }],
      }),
      [{ id: "from-models", name: "from-models" }],
    )
  })

  it("returns null when the payload is not an object or neither list is an array", () => {
    assert.equal(parseLiveModels(null), null)
    assert.equal(parseLiveModels([]), null)
    assert.equal(parseLiveModels("models"), null)
    assert.equal(parseLiveModels({ models: { modelId: "a" } }), null)
    assert.equal(parseLiveModels({ availableModels: "nope" }), null)
  })

  it("returns an empty array when the list is present but yields no models", () => {
    assert.deepEqual(parseLiveModels({ models: [] }), [])
    assert.deepEqual(parseLiveModels({ availableModels: [{ modelId: "" }, { id: 1 }, null] }), [])
  })

  it("normalizes dotted Kiro ids to overlay dash form", () => {
    assert.deepEqual(
      parseLiveModels({
        models: [
          { modelId: "claude-opus-4.7", modelName: "Claude Opus 4.7" },
          { modelId: "gpt-5.6-sol" },
          { modelId: "claude-sonnet-4.6-1m" },
          { modelId: "auto" },
          { modelId: "qwen3-coder-480b" },
          { modelId: "claude-sonnet-4-6" },
        ],
      }),
      [
        { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
        { id: "gpt-5-6-sol", name: "gpt-5-6-sol" },
        { id: "claude-sonnet-4-6-1m", name: "claude-sonnet-4-6-1m" },
        { id: "auto", name: "auto" },
        { id: "qwen3-coder-480b", name: "qwen3-coder-480b" },
        { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      ],
    )
  })

  it("skips invalid and duplicate ids", () => {
    assert.deepEqual(
      parseLiveModels({
        models: [
          { modelId: "keep", modelName: "First" },
          { modelId: "keep", modelName: "Dup" },
          { modelName: "no-id" },
          { modelId: "", name: "empty" },
          { id: "other", name: "Other" },
          "skip",
        ],
      }),
      [
        { id: "keep", name: "First" },
        { id: "other", name: "Other" },
      ],
    )
  })

  it("sets reasoning only from a clear boolean field", () => {
    const parsed = parseLiveModels({
      models: [
        { modelId: "claude-sonnet-5", modelName: "Looks reasoning-capable" },
        { modelId: "r1", reasoning: true },
        { modelId: "r2", thinking: false },
        { modelId: "r3", supportsThinking: true },
        { modelId: "r4", capabilities: { thinking: true } },
        { modelId: "r5", capabilities: { thinking: { enabled: true } } },
        { modelId: "r6", reasoning: "yes" },
      ],
    })
    assert.deepEqual(parsed, [
      { id: "claude-sonnet-5", name: "Looks reasoning-capable" },
      { id: "r1", name: "r1", reasoning: true },
      { id: "r2", name: "r2", reasoning: false },
      { id: "r3", name: "r3", reasoning: true },
      { id: "r4", name: "r4", reasoning: true },
      { id: "r5", name: "r5" },
      { id: "r6", name: "r6" },
    ])
  })

  it("reads tokenLimits only when they are positive finite integers", () => {
    const parsed = parseLiveModels({
      models: [
        {
          modelId: "limited",
          tokenLimits: { maxInputTokens: 200_000, maxOutputTokens: 8192 },
        },
        {
          modelId: "bad-limits",
          tokenLimits: { maxInputTokens: 0, maxOutputTokens: 3.5 },
        },
      ],
    })
    assert.deepEqual(parsed, [
      { id: "limited", name: "limited", contextWindow: 200_000, maxTokens: 8192 },
      { id: "bad-limits", name: "bad-limits" },
    ])
  })
})

describe("mergeLiveWithOverlay", () => {
  it("keeps overlay metadata for known ids and conservative defaults for unknown live ids", () => {
    const liveName = "Live Sonnet Name"
    const merged = mergeLiveWithOverlay(OVERLAY, [
      {
        id: "claude-sonnet-5",
        name: liveName,
        reasoning: false,
        contextWindow: 12,
        maxTokens: 34,
      },
      { id: "new-live", name: "New Live" },
      { id: "thinking-live", name: "Thinking Live", reasoning: true },
    ])

    assert.equal(merged[0].name, "Claude Sonnet 5")
    assert.equal(merged[0].reasoning, true)
    assert.deepEqual(merged[0].input, ["text", "image"])
    assert.equal(merged[0].contextWindow, 1_000_000)
    assert.equal(merged[0].maxTokens, 128_000)
    assert.equal(merged[1].id, "overlay-only")
    assert.deepEqual(merged[2], {
      id: "new-live",
      name: "New Live",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8192,
      cost: { ...ZERO_COST },
    })
    assert.equal(merged[3].reasoning, true)
    assert.equal("reasoningHidden" in merged[3], false)
    assert.deepEqual(merged[3].input, ["text"])
  })

  it("applies tokenLimits.maxInputTokens as contextWindow on unknowns", () => {
    const merged = mergeLiveWithOverlay(OVERLAY, [
      { id: "wide", name: "Wide", contextWindow: 256_000, maxTokens: 16_384 },
    ])
    const unknown = merged.find((model) => model.id === "wide")
    assert.equal(unknown?.contextWindow, 256_000)
    assert.equal(unknown?.maxTokens, 16_384)
  })

  it("does not mutate overlay rows", () => {
    const overlay = structuredClone(OVERLAY)
    const merged = mergeLiveWithOverlay(overlay, [{ id: "new-live", name: "New Live" }])
    merged[0].input.push("image")
    merged[0].name = "mutated"
    assert.deepEqual(overlay, OVERLAY)
  })
})

describe("fetchDynamicKiroModels", () => {
  it("returns an overlay copy and does not fetch when the token is blank or missing", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse(200, { models: [{ modelId: "x" }] })
    }) as typeof fetch

    const missing = await fetchDynamicKiroModels({
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl,
    })
    const blank = await fetchDynamicKiroModels({
      apiKey: "   ",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl,
    })

    assert.equal(calls, 0)
    assert.deepEqual(missing, OVERLAY)
    assert.deepEqual(blank, OVERLAY)
    assert.notEqual(missing[0].cost, OVERLAY[0].cost)
  })

  it("sends Authorization Bearer and origin=AI_EDITOR", async () => {
    let url = ""
    let init: RequestInit | undefined
    const fetchImpl = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      url = String(input)
      init = requestInit
      return jsonResponse(200, { models: [{ modelId: "new-live", modelName: "New Live" }] })
    }) as typeof fetch

    await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl,
    })

    const parsed = new URL(url)
    assert.equal(parsed.pathname, "/ListAvailableModels")
    assert.equal(parsed.searchParams.get("origin"), "AI_EDITOR")
    assert.equal(header(init, "Authorization"), "Bearer token-1")
    assert.equal(header(init, "Accept"), "application/json")
    assert.equal(header(init, "X-Amz-Target"), undefined)
    assert.equal(init?.method, "GET")
  })

  it("omits profileArn on the first request and sends it only on retry after non-2xx", async () => {
    const arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
    const urls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (urls.length === 1) return jsonResponse(403, { message: "forbidden" })
      return jsonResponse(200, { models: [{ modelId: "retried", modelName: "Retried" }] })
    }) as typeof fetch

    const models = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl,
      profileArn: arn,
    })

    assert.equal(urls.length, 2)
    assert.equal(new URL(urls[0]).searchParams.get("profileArn"), null)
    assert.equal(new URL(urls[1]).searchParams.get("profileArn"), arn)
    assert.ok(models.some((model) => model.id === "retried"))
    assert.ok(models.some((model) => model.id === "overlay-only"))
  })

  it("falls back to an overlay copy on non-2xx, invalid JSON, oversized body, or thrown fetch", async () => {
    const cases: Array<typeof fetch> = [
      (async () => jsonResponse(503, { models: [{ modelId: "nope" }] })) as typeof fetch,
      (async () => jsonResponse(200, "{")) as typeof fetch,
      (async () => jsonResponse(200, { models: [{ modelId: "huge" }] }, { "content-length": "2000000" })) as typeof fetch,
      (async () => {
        throw new Error("network down")
      }) as typeof fetch,
    ]

    for (const fetchImpl of cases) {
      const result = await fetchDynamicKiroModels({
        apiKey: "token-1",
        apiBase: API_BASE,
        overlay: OVERLAY,
        fetchImpl,
        maxBodyBytes: 64,
      })
      assert.deepEqual(result.map((model) => model.id), ["claude-sonnet-5", "overlay-only"])
      assert.notEqual(result[0], OVERLAY[0])
    }
  })

  it("falls back when the actual body exceeds maxBodyBytes", async () => {
    const result = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      maxBodyBytes: 16,
      fetchImpl: (async () => jsonResponse(200, { models: [{ modelId: "too-big", modelName: "Too Big" }] })) as typeof fetch,
    })
    assert.deepEqual(result.map((model) => model.id), ["claude-sonnet-5", "overlay-only"])
  })

  it("applies overlay metadata when the live catalog uses dotted ids", async () => {
    const overlay: OverlayModel[] = [
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        reasoning: true,
        reasoningHidden: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { ...ZERO_COST },
      },
    ]
    const result = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay,
      fetchImpl: (async () => jsonResponse(200, {
        models: [{ modelId: "claude-opus-4.7", modelName: "Ignored Live Name" }],
      })) as typeof fetch,
    })
    assert.deepEqual(result, overlay)
    assert.notEqual(result[0], overlay[0])
  })

  it("merges overlay-only ids with new live ids on success", async () => {
    const result = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl: (async () => jsonResponse(200, {
        models: [
          { modelId: "claude-sonnet-5", modelName: "Ignored Live Name" },
          { modelId: "brand-new", modelName: "Brand New", tokenLimits: { maxInputTokens: 99_000, maxOutputTokens: 2048 } },
        ],
      })) as typeof fetch,
    })

    assert.deepEqual(result.map((model) => model.id), ["claude-sonnet-5", "overlay-only", "brand-new"])
    assert.equal(result[0].name, "Claude Sonnet 5")
    assert.deepEqual(result[0].input, ["text", "image"])
    assert.deepEqual(result[2], {
      id: "brand-new",
      name: "Brand New",
      reasoning: false,
      input: ["text"],
      contextWindow: 99_000,
      maxTokens: 2048,
      cost: { ...ZERO_COST },
    })
  })

  it("falls back to overlay when the fetch times out", async () => {
    const result = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      timeoutMs: 20,
      fetchImpl: (async (_input, init) => {
        await new Promise((_, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error("missing abort signal"))
            return
          }
          if (signal.aborted) {
            reject(signal.reason ?? new Error("aborted"))
            return
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("aborted"))
          })
        })
        return jsonResponse(200, { models: [{ modelId: "late" }] })
      }) as typeof fetch,
    })
    assert.deepEqual(result.map((model) => model.id), ["claude-sonnet-5", "overlay-only"])
  })

  it("falls back to overlay when the live models array is empty", async () => {
    let calls = 0
    const result = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl: (async () => {
        calls += 1
        return jsonResponse(200, { models: [] })
      }) as typeof fetch,
    })
    assert.equal(calls, 1)
    assert.deepEqual(result.map((model) => model.id), ["claude-sonnet-5", "overlay-only"])
  })
})
