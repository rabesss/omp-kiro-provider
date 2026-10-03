import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BUILDER_ID_PROFILE_ARN,
  fetchDynamicKiroModels,
  mergeLiveWithOverlay,
  parseLiveModels,
  resolveKiroProfileArn,
  type OverlayModel,
} from "../src/dynamic-models.ts"

const API_BASE = "https://management.us-east-1.kiro.dev"
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
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
      [{ id: "from-models" }],
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
        { id: "gpt-5-6-sol" },
        { id: "claude-sonnet-4-6-1m" },
        { id: "auto" },
        { id: "qwen3-coder-480b" },
        { id: "claude-sonnet-4-6" },
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
      { id: "r1", reasoning: true },
      { id: "r2", reasoning: false },
      { id: "r3", reasoning: true },
      { id: "r4", reasoning: true },
      { id: "r5" },
      { id: "r6" },
    ])
  })

  it("reads reasoning from an effort setting in the request schema", () => {
    const effort = { type: "object", properties: { effort: { type: "string", enum: ["low", "high"] } } }
    const parsed = parseLiveModels({
      models: [
        { modelId: "gpt-5.6-sol", additionalModelRequestFieldsSchema: { type: "object", properties: { reasoning: effort } } },
        { modelId: "claude-opus-5.5", additionalModelRequestFieldsSchema: { type: "object", properties: { output_config: effort } } },
        { modelId: "plain", additionalModelRequestFieldsSchema: { type: "object", properties: { output_config: { type: "object" } } } },
      ],
    })
    assert.deepEqual(parsed, [
      { id: "gpt-5-6-sol", reasoning: true },
      { id: "claude-opus-5-5", reasoning: true },
      { id: "plain" },
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
      { id: "limited", contextWindow: 200_000, maxTokens: 8192 },
      { id: "bad-limits" },
    ])
  })
})

describe("mergeLiveWithOverlay", () => {
  it("lists only live models, preferring live metadata and filling gaps from the overlay", () => {
    const merged = mergeLiveWithOverlay(OVERLAY, [
      { id: "claude-sonnet-5", name: "Live Sonnet Name", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
      { id: "new-live", name: "New Live" },
      { id: "thinking-live", reasoning: true },
    ])

    assert.deepEqual(merged, [
      {
        id: "claude-sonnet-5",
        name: "Live Sonnet Name",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
        cost: { ...ZERO_COST },
      },
      {
        id: "new-live",
        name: "New Live",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8192,
        cost: { ...ZERO_COST },
      },
      {
        id: "thinking-live",
        name: "thinking-live",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8192,
        cost: { ...ZERO_COST },
      },
    ])
  })

  it("keeps overlay metadata the live catalog leaves out", () => {
    const [sonnet] = mergeLiveWithOverlay(OVERLAY, [{ id: "claude-sonnet-5" }])
    assert.deepEqual(sonnet, OVERLAY[0])
    assert.notEqual(sonnet, OVERLAY[0])
  })

  it("carries hidden reasoning from the overlay", () => {
    const overlay: OverlayModel[] = [{ ...OVERLAY[1], id: "hidden", reasoningHidden: true }]
    assert.equal(mergeLiveWithOverlay(overlay, [{ id: "hidden" }])[0].reasoningHidden, true)
  })

  it("accepts images for every Claude model", () => {
    const merged = mergeLiveWithOverlay([], [
      { id: "claude-new", input: ["text"] },
      { id: "vision-live", input: ["text", "image"] },
      { id: "text-live" },
    ])
    assert.deepEqual(merged.map((model) => model.input), [["text", "image"], ["text", "image"], ["text"]])
  })

  it("does not mutate overlay rows", () => {
    const overlay = structuredClone(OVERLAY)
    const merged = mergeLiveWithOverlay(overlay, [{ id: "claude-sonnet-5" }])
    merged[0].input.push("image")
    merged[0].name = "mutated"
    assert.deepEqual(overlay, OVERLAY)
  })
})

describe("fetchDynamicKiroModels", () => {
  it("fails without fetching when the token is blank or missing", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse(200, { models: [{ modelId: "x" }] })
    }) as typeof fetch

    await assert.rejects(fetchDynamicKiroModels({
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl,
    }), /signed-in account/)
    await assert.rejects(fetchDynamicKiroModels({
      apiKey: "   ",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl,
    }), /signed-in account/)

    assert.equal(calls, 0)
  })

  it("discovers Opus 5.5 through the OAuth account profile on the management API", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (header(init, "Authorization") !== "Bearer token-1") return jsonResponse(403, {})
      if (url.pathname === "/List-Available-Profiles" && init?.method === "POST") {
        return jsonResponse(200, { profiles: [{ arn: PROFILE_ARN }] })
      }
      if (url.pathname === "/List-Available-Models" && url.searchParams.get("origin") === "KIRO_CLI"
        && url.searchParams.get("profileArn") === PROFILE_ARN) {
        return jsonResponse(200, { models: [{
          modelId: "claude-opus-5.5",
          modelName: "Claude Opus 5.5",
          supportedInputTypes: ["TEXT", "IMAGE"],
          additionalModelRequestFieldsSchema: { type: "object", properties: { thinking: { type: "object" } } },
        }] })
      }
      return jsonResponse(403, {})
    }) as typeof fetch
    const models = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      overlay: OVERLAY,
      env: {},
      fetchImpl,
    })
    const opus = models.find((model) => model.id === "claude-opus-5-5")
    assert.equal(opus?.name, "Claude Opus 5.5")
    assert.equal(opus?.reasoning, true)
    assert.deepEqual(opus?.input, ["text", "image"])
    assert.deepEqual(models.map((model) => model.id), ["claude-opus-5-5"])
  })

  it("fails on non-2xx, invalid JSON, oversized body, or thrown fetch", async () => {
    const cases: Array<typeof fetch> = [
      (async () => jsonResponse(503, { models: [{ modelId: "nope" }] })) as typeof fetch,
      (async () => jsonResponse(200, "{")) as typeof fetch,
      (async () => jsonResponse(200, { models: [{ modelId: "huge" }] }, { "content-length": "2000000" })) as typeof fetch,
      (async () => {
        throw new Error("network down")
      }) as typeof fetch,
    ]

    for (const fetchImpl of cases) {
      await assert.rejects(fetchDynamicKiroModels({
        apiKey: "token-1",
        profileArn: PROFILE_ARN,
        apiBase: API_BASE,
        overlay: OVERLAY,
        fetchImpl,
        maxBodyBytes: 64,
      }))
    }
  })

  it("fails when the actual body exceeds maxBodyBytes", async () => {
    await assert.rejects(fetchDynamicKiroModels({
      apiKey: "token-1",
      profileArn: PROFILE_ARN,
      apiBase: API_BASE,
      overlay: OVERLAY,
      maxBodyBytes: 16,
      fetchImpl: (async () => jsonResponse(200, { models: [{ modelId: "too-big", modelName: "Too Big" }] })) as typeof fetch,
    }), /no usable models/)
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
      profileArn: PROFILE_ARN,
      apiBase: API_BASE,
      overlay,
      fetchImpl: (async () => jsonResponse(200, {
        models: [{ modelId: "claude-opus-4.7" }],
      })) as typeof fetch,
    })
    assert.deepEqual(result, overlay)
    assert.notEqual(result[0], overlay[0])
  })

  it("lists the live models only, without the overlay-only ones", async () => {
    const result = await fetchDynamicKiroModels({
      apiKey: "token-1",
      profileArn: PROFILE_ARN,
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl: (async () => jsonResponse(200, {
        models: [
          { modelId: "claude-sonnet-5" },
          { modelId: "brand-new", modelName: "Brand New", tokenLimits: { maxInputTokens: 99_000, maxOutputTokens: 2048 } },
        ],
      })) as typeof fetch,
    })

    assert.deepEqual(result.map((model) => model.id), ["claude-sonnet-5", "brand-new"])
    assert.equal(result[0].name, "Claude Sonnet 5")
    assert.deepEqual(result[0].input, ["text", "image"])
    assert.deepEqual(result[1], {
      id: "brand-new",
      name: "Brand New",
      reasoning: false,
      input: ["text"],
      contextWindow: 99_000,
      maxTokens: 2048,
      cost: { ...ZERO_COST },
    })
  })

  it("cancels a streamed body once maxBodyBytes is exceeded", async () => {
    let cancelled = false
    const chunk = new Uint8Array(12)
    await assert.rejects(fetchDynamicKiroModels({
      apiKey: "token-1",
      profileArn: PROFILE_ARN,
      apiBase: API_BASE,
      overlay: OVERLAY,
      maxBodyBytes: 16,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
      })) as typeof fetch,
    }))
    assert.equal(cancelled, true)
  })

  it("fails when the response body stalls past timeoutMs", async () => {
    await assert.rejects(fetchDynamicKiroModels({
      apiKey: "token-1",
      profileArn: PROFILE_ARN,
      apiBase: API_BASE,
      overlay: OVERLAY,
      timeoutMs: 20,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start() {},
        }),
      })) as typeof fetch,
    }))
  })

  it("fails when the fetch times out", async () => {
    await assert.rejects(fetchDynamicKiroModels({
      apiKey: "token-1",
      profileArn: PROFILE_ARN,
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
    }))
  })

  // OMP would take an empty result as the whole catalog and drop every Kiro model.
  it("fails when the live models array is empty", async () => {
    let calls = 0
    await assert.rejects(fetchDynamicKiroModels({
      apiKey: "token-1",
      profileArn: PROFILE_ARN,
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl: (async () => {
        calls += 1
        return jsonResponse(200, { models: [] })
      }) as typeof fetch,
    }), /no usable models/)
    assert.equal(calls, 1)
  })

  it("uses the API key's own profile rather than a saved OAuth profile", async () => {
    const keyProfile = "arn:aws:codewhisperer:us-east-1:987654321098:profile/api-key"
    const models = await fetchDynamicKiroModels({
      apiKey: "ksk_test",
      apiBase: API_BASE,
      profileArn: PROFILE_ARN,
      overlay: OVERLAY,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === "/" && header(init, "X-Amz-Target") === "AmazonCodeWhispererService.GetProfile") {
          return jsonResponse(200, { profile: { arn: keyProfile } })
        }
        if (url.pathname === "/List-Available-Models" && url.searchParams.get("profileArn") === keyProfile) {
          return jsonResponse(200, { models: [{ modelId: "claude-opus-5.5" }] })
        }
        return jsonResponse(403, {})
      }) as typeof fetch,
    })
    assert.ok(models.some((model) => model.id === "claude-opus-5-5"))
  })

  it("resolves an API key's profile in us-east-1 whatever the configured region", async () => {
    const urls: string[] = []
    await resolveKiroProfileArn({
      apiKey: "ksk_test",
      apiBase: "https://management.eu-central-1.kiro.dev",
      env: {},
      fetchImpl: (async (url: string) => {
        urls.push(url)
        return jsonResponse(200, { profile: { arn: PROFILE_ARN } })
      }) as unknown as typeof fetch,
    })
    assert.deepEqual(urls, ["https://management.us-east-1.kiro.dev/"])
  })

  it("reports an API key that Kiro rejects", async () => {
    await assert.rejects(resolveKiroProfileArn({
      apiKey: "ksk_revoked",
      apiBase: API_BASE,
      env: {},
      fetchImpl: (async () => jsonResponse(403, {
        message: "The bearer token included in the request is invalid.",
      })) as unknown as typeof fetch,
    }), /GetProfile returned HTTP 403: The bearer token included in the request is invalid/)
  })

  it("lists models in the region that owns the profile", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EUPROFILE"
    const urls: string[] = []
    const models = await fetchDynamicKiroModels({
      apiKey: "token-1",
      apiBase: API_BASE,
      profileArn: euArn,
      overlay: OVERLAY,
      env: {},
      fetchImpl: (async (url: string) => {
        urls.push(url)
        return jsonResponse(200, { models: [{ modelId: "claude-opus-5.5" }] })
      }) as unknown as typeof fetch,
    })
    assert.ok(models.some((model) => model.id === "claude-opus-5-5"))
    assert.equal(new URL(urls[0]).origin, "https://management.eu-central-1.kiro.dev")
  })

  it("declares API keys with TokenType: API_KEY on every management request", async () => {
    const seen: Array<string | undefined> = []
    const models = await fetchDynamicKiroModels({
      apiKey: "ksk_example_api_key",
      apiBase: API_BASE,
      overlay: OVERLAY,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(header(init, "TokenType"))
        return new URL(String(input)).pathname === "/"
          ? jsonResponse(200, { profile: { arn: PROFILE_ARN } })
          : jsonResponse(200, { models: [{ modelId: "claude-opus-5.5" }] })
      }) as typeof fetch,
    })
    assert.ok(models.some((model) => model.id === "claude-opus-5-5"))
    assert.deepEqual(seen, ["API_KEY", "API_KEY"])
  })

  it("omits TokenType for OAuth credentials", async () => {
    const seen: Array<string | undefined> = []
    await fetchDynamicKiroModels({
      apiKey: "aoa_example_oauth_token",
      apiBase: API_BASE,
      overlay: OVERLAY,
      env: {},
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(header(init, "TokenType"))
        return new URL(String(input)).pathname === "/List-Available-Profiles"
          ? jsonResponse(200, { profiles: [{ arn: PROFILE_ARN }] })
          : jsonResponse(200, { models: [{ modelId: "claude-opus-5.5" }] })
      }) as typeof fetch,
    })
    assert.deepEqual(seen, [undefined, undefined])
  })

  it("does not publish a live catalog when the account has no accessible profile", async () => {
    for (const payload of [{ profiles: [] }, { profiles: [{}] }, { message: "forbidden" }]) {
      await assert.rejects(fetchDynamicKiroModels({
        apiKey: "token-1",
        apiBase: API_BASE,
        overlay: OVERLAY,
        env: {},
        fetchImpl: (async () => jsonResponse(200, payload)) as typeof fetch,
      }), /No accessible Kiro profile/)
    }
  })
})

describe("resolveKiroProfileArn", () => {
  const request = (fetchImpl: typeof fetch, env: Record<string, string | undefined> = {}) =>
    resolveKiroProfileArn({ apiKey: "token-1", apiBase: API_BASE, fetchImpl, env })

  it("uses the shared Builder ID profile when the token may not list profiles", async () => {
    const arn = await request((async () =>
      jsonResponse(403, { message: "User is not authorized to access this feature." })) as typeof fetch)
    assert.equal(arn, BUILDER_ID_PROFILE_ARN)
  })

  it("does not mistake an invalid token for a Builder ID token", async () => {
    await assert.rejects(
      request((async () => jsonResponse(403, { message: "Invalid token" })) as typeof fetch),
      /HTTP 403: Invalid token/,
    )
  })

  it("reports a failed region instead of guessing the Builder ID profile", async () => {
    await assert.rejects(
      request((async (url: string) =>
        url.includes("eu-central-1")
          ? jsonResponse(503, { message: "Service unavailable" })
          : jsonResponse(403, { message: "User is not authorized to access this feature." })) as unknown as typeof fetch),
      /HTTP 503/,
    )
  })

  it("keeps probing when a region cannot be reached", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EUPROFILE"
    const arn = await request((async (url: string) => {
      if (!url.includes("eu-central-1")) throw new TypeError("fetch failed")
      return jsonResponse(200, { profiles: [{ arn: euArn }] })
    }) as unknown as typeof fetch)
    assert.equal(arn, euArn)
  })

  it("looks for the profile in the other canonical region before calling the token Builder ID", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EUPROFILE"
    const calls: string[] = []
    const arn = await request((async (url: string) => {
      calls.push(url)
      return url.includes("eu-central-1")
        ? jsonResponse(200, { profiles: [{ arn: euArn }] })
        : jsonResponse(403, { message: "User is not authorized to access this feature." })
    }) as unknown as typeof fetch)
    assert.equal(arn, euArn)
    assert.deepEqual(calls, [
      "https://management.us-east-1.kiro.dev/List-Available-Profiles",
      "https://management.eu-central-1.kiro.dev/List-Available-Profiles",
    ])
  })

  it("does not call the token Builder ID when another region lists no profile either", async () => {
    const arn = await request((async (url: string) =>
      url.includes("eu-central-1")
        ? jsonResponse(200, { profiles: [] })
        : jsonResponse(403, { message: "User is not authorized to access this feature." })) as unknown as typeof fetch)
    assert.equal(arn, undefined)
  })

  it("never rewrites a custom management base", async () => {
    const calls: string[] = []
    await resolveKiroProfileArn({
      apiKey: "token-1",
      apiBase: "https://proxy.example.com",
      env: {},
      fetchImpl: (async (url: string) => { calls.push(url); return jsonResponse(200, { profiles: [] }) }) as unknown as typeof fetch,
    })
    assert.deepEqual(calls, ["https://proxy.example.com/List-Available-Profiles"])
  })

  it("prefers KIRO_PROFILE_ARN over any network lookup", async () => {
    let calls = 0
    const arn = await request((async () => { calls++; return jsonResponse(200, { profiles: [] }) }) as typeof fetch,
      { KIRO_PROFILE_ARN: PROFILE_ARN })
    assert.equal(arn, PROFILE_ARN)
    assert.equal(calls, 0)
  })
})
