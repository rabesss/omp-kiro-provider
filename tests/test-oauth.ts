import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import type { AssistantMessageEvent, AssistantMessageLike, ModelLike, StreamOptions } from "../src/types.ts"

// Isolate the public login/refresh API from the developer's credentials.
const home = mkdtempSync(join(tmpdir(), "omp-kiro-oauth-"))
const previousHome = process.env.HOME
const previousProfile = process.env.USERPROFILE
process.env.HOME = home
process.env.USERPROFILE = home
const { login, refreshToken, getStoredProfileArn } = await import("../src/oauth.ts")
const { createStreamKiro } = await import("../src/core.ts")
after(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  rmSync(home, { recursive: true, force: true })
})

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe("organization login", () => {
  it("authorizes in the SSO region and renews with the persisted OIDC registration", async (t) => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const answers = ["5", "https://example.awsapps.com/start", "eu-west-1", ""]
    let browserUrl: string | undefined
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      if (url.endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "device", userCode: "CODE", verificationUri: "https://example.com/verify",
        verificationUriComplete: "https://example.com/verify?code=CODE", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") return response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 })
      return response({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 })
    })
    const credentials = await login({
      onPrompt: async () => answers.shift() ?? "",
      onAuth: ({ url }) => { browserUrl = url },
    })
    assert.notEqual(typeof credentials, "string")
    if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
    assert.equal(credentials.access, "access")
    assert.equal(credentials.refresh, "refresh")
    assert.equal(browserUrl, "https://example.com/verify?code=CODE")
    assert.equal(requests[0].url, "https://oidc.eu-west-1.amazonaws.com/client/register")
    assert.equal(requests[0].body.issuerUrl, "https://example.awsapps.com/start")
    assert.equal(requests[1].body.startUrl, "https://example.awsapps.com/start")
    const renewed = await refreshToken(credentials)
    assert.equal(renewed.access, "renewed")
    assert.equal(renewed.refresh, "rotated")
    assert.deepEqual(requests[3], {
      url: "https://oidc.eu-west-1.amazonaws.com/token",
      body: { grantType: "refresh_token", clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
    })
  })

  it("uses the default region when blank and propagates denied authorization", async (t) => {
    const answers = ["5", "https://example.awsapps.com/start", "   ", ""]
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      assert.equal(new URL(String(input)).hostname, "oidc.us-east-1.amazonaws.com")
      if (String(input).endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (String(input).endsWith("/device_authorization")) return response({
        deviceCode: "device", userCode: "CODE", verificationUri: "https://example.com/verify", interval: 0, expiresIn: 600,
      })
      return response({ error: "access_denied" }, 400)
    })
    await assert.rejects(login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} }), /Authorization denied/)
  })

  it("rejects a missing organization URL", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request") })
    for (const answers of [["5", ""]]) {
      await assert.rejects(login({
        onPrompt: async () => answers.shift() ?? "",
        onAuth: () => { throw new Error("Unexpected browser login") },
      }), /IAM Identity Center/)
    }
  })

  it("streams a discovered Opus model using the organization profile", async () => {
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
    let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
    const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
    const events: AssistantMessageEvent[] = []
    const streamKiro = createStreamKiro({
      apiBase: "https://runtime.us-east-1.kiro.dev",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.hostname === "management.us-east-1.kiro.dev" && url.pathname === "/List-Available-Profiles") {
          return response({ profiles: [{ arn: profileArn }] })
        }
        const payload = JSON.parse(String(init?.body)) as {
          profileArn?: string
          conversationState?: { currentMessage?: { userInputMessage?: { modelId?: string } } }
        }
        if (url.hostname !== "runtime.us-east-1.kiro.dev" || payload.profileArn !== profileArn
          || payload.conversationState?.currentMessage?.userInputMessage?.modelId !== "claude-opus-5.5") {
          return response({ message: "Invalid model or missing profile" }, 400)
        }
        return new Response('{"content":"OK"}')
      }) as typeof fetch,
      createStream: () => ({
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }),
      cwd: () => home,
      now: () => Date.now(),
      uuid: () => "test-conversation",
      env: { OMP_KIRO_STREAM_GATE: "0" },
      authPaths: [],
      homeDir: home,
      calculateCost: () => {},
    })
    const output = await streamKiro({
      id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
      reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    }, { messages: [{ role: "user", content: "Reply OK" }] }, { apiKey: "organization-token" }).result()
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content, [{ type: "text", text: "OK" }])
  })
})

describe("refresh with several accounts", () => {
  it("renews each credential with its own OIDC registration, not the last login's", async (t) => {
    const tokenRequests: Record<string, unknown>[] = []
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (url.endsWith("/client/register")) return response({ clientId: "client-b", clientSecret: "secret-b" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "d", userCode: "C", verificationUri: "https://example.com/v",
        verificationUriComplete: "https://example.com/v?c=C", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") {
        tokenRequests.push(body)
        return response({ accessToken: `renewed-${String(body.clientId)}`, refreshToken: "rotated", expiresIn: 3600 })
      }
      return response({ accessToken: "access-b", refreshToken: "refresh-b", expiresIn: 3600 })
    })
    // Account A signed in earlier, with its own registration.
    const accountA = {
      access: "access-a", refresh: "refresh-a", expires: 0,
      method: "idc", region: "us-east-1", clientId: "client-a", clientSecret: "secret-a",
    }
    // Account B signs in afterwards and overwrites the shared sidecar.
    const answers = ["4"]
    const accountB = await login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} })
    if (typeof accountB === "string") throw new Error("Expected OAuth credentials")

    const renewedA = await refreshToken(accountA)
    const renewedB = await refreshToken(accountB)

    assert.equal(renewedA.access, "renewed-client-a")
    assert.equal(renewedB.access, "renewed-client-b")
    assert.deepEqual(tokenRequests.map((request) => request.clientId), ["client-a", "client-b"])
    // The renewed credential keeps describing its own registration.
    assert.equal(renewedA.clientId, "client-a")
  })
})

describe("single Kiro identity", () => {
  it("gives every login method and every renewal the same identity so OMP replaces the old credential", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (url.endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "d", userCode: "C", verificationUri: "https://example.com/v", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") return response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 })
      return response({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 })
    })
    const signIn = async (...answers: string[]) => {
      const credentials = await login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} })
      if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
      return credentials
    }
    const builderId = await signIn("4")
    const organization = await signIn("5", "https://example.awsapps.com/start", "")
    const apiKey = await signIn("2", "ksk_example")

    assert.equal(builderId.accountId, organization.accountId)
    assert.equal(organization.accountId, apiKey.accountId)
    assert.ok(builderId.accountId)
    assert.equal((await refreshToken(organization)).accountId, organization.accountId)
  })
})

describe("profile ARN after a social refresh", () => {
  it("exposes the renewed profile ARN even when the credential carries its own metadata", async (t) => {
    const oldArn = "arn:aws:codewhisperer:us-east-1:111111111111:profile/OLD"
    const newArn = "arn:aws:codewhisperer:us-east-1:111111111111:profile/NEW"
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600, profileArn: newArn }))

    const renewed = await refreshToken({
      access: "old", refresh: "refresh", expires: 0,
      accountId: "kiro", method: "social", region: "us-east-1", profileArn: oldArn,
    })

    assert.equal(renewed.profileArn, newArn)
    assert.equal(getStoredProfileArn(), newArn)
  })
})

describe("credentials reused from Kiro CLI", () => {
  const cliDir = join(home, ".local", "share", "kiro-cli")
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0

  it("defer to the live CLI token on refresh, unlike credentials from a direct login", { skip: !hasSqlite }, async (t) => {
    mkdirSync(cliDir, { recursive: true })
    t.after(() => rmSync(cliDir, { recursive: true, force: true }))
    const token = JSON.stringify({
      access_token: "cli-access", refresh_token: "cli-refresh",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), region: "us-east-1",
    })
    execFileSync("sqlite3", [join(cliDir, "data.sqlite3"),
      `CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT);`
      + ` INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${token}');`])
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 }))

    const stored = {
      access: "stale", refresh: "stale", expires: 0,
      method: "idc", region: "us-east-1", clientId: "client", clientSecret: "secret",
    }
    const reused = await refreshToken({ ...stored, reused: true })
    assert.equal(reused.access, "cli-access")
    assert.equal(reused.reused, true)
    assert.equal((await refreshToken(stored)).access, "renewed")
  })
})

describe("credentials reused from Kiro IDE", () => {
  const ssoDir = join(home, ".aws", "sso", "cache")
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0

  it("defer to the live IDE token on refresh when no CLI is installed", async (t) => {
    mkdirSync(ssoDir, { recursive: true })
    t.after(() => rmSync(ssoDir, { recursive: true, force: true }))
    writeFileSync(join(ssoDir, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "ide-access", refreshToken: "ide-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), region: "us-east-1",
    }))
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 }))

    const stored = {
      access: "stale", refresh: "stale", expires: 0,
      method: "social", region: "us-east-1",
    }
    const reused = await refreshToken({ ...stored, reused: true })
    assert.equal(reused.access, "ide-access")
    assert.equal(reused.reused, true)
    assert.equal((await refreshToken(stored)).access, "renewed")
  })

  it("refresh with the credential's own metadata when the live IDE token has expired", async (t) => {
    mkdirSync(ssoDir, { recursive: true })
    t.after(() => rmSync(ssoDir, { recursive: true, force: true }))
    writeFileSync(join(ssoDir, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "ide-access", refreshToken: "ide-refresh",
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(), region: "us-east-1",
    }))
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 }))

    const reused = await refreshToken({
      access: "stale", refresh: "stale", expires: 0,
      method: "social", region: "us-east-1", reused: true,
    })
    assert.equal(reused.access, "renewed")
    assert.equal(reused.reused, true)
  })

  it("defer to the live IDE token when an installed kiro-cli holds an expired one", { skip: !hasSqlite }, async (t) => {
    const cliDir = join(home, ".local", "share", "kiro-cli")
    mkdirSync(cliDir, { recursive: true })
    mkdirSync(ssoDir, { recursive: true })
    t.after(() => {
      rmSync(cliDir, { recursive: true, force: true })
      rmSync(ssoDir, { recursive: true, force: true })
    })
    const expiredCliToken = JSON.stringify({
      access_token: "cli-access", refresh_token: "cli-refresh",
      expires_at: new Date(Date.now() - 3_600_000).toISOString(), region: "us-east-1",
    })
    execFileSync("sqlite3", [join(cliDir, "data.sqlite3"),
      `CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT);`
      + ` INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${expiredCliToken}');`])
    writeFileSync(join(ssoDir, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "ide-access", refreshToken: "ide-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), region: "us-east-1",
    }))

    const reused = await refreshToken({
      access: "stale", refresh: "stale", expires: 0,
      method: "social", region: "us-east-1", reused: true,
    })
    assert.equal(reused.access, "ide-access")
  })
})

describe("API key login", () => {
  it("returns a credential that carries its own refresh method", async () => {
    const answers = ["2", "ksk_example"]
    const credentials = await login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} })
    if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
    assert.equal(credentials.method, "apikey")
    assert.equal((await refreshToken(credentials)).access, "ksk_example")
  })
})

describe("cancelling while the profile is resolved", () => {
  it("reports an abort instead of a missing profile", async () => {
    const controller = new AbortController()
    let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
    const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
    const events: AssistantMessageEvent[] = []
    const streamKiro = createStreamKiro({
      apiBase: "https://runtime.us-east-1.kiro.dev",
      fetchImpl: (async () => {
        controller.abort()
        return response({ profiles: [] })
      }) as typeof fetch,
      createStream: () => ({
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }),
      cwd: () => home,
      now: () => Date.now(),
      uuid: () => "test-conversation",
      env: { OMP_KIRO_STREAM_GATE: "0" },
      authPaths: [],
      homeDir: home,
      calculateCost: () => {},
    })
    const output = await streamKiro({
      id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
      reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    }, { messages: [{ role: "user", content: "Reply OK" }] }, { apiKey: "organization-token", signal: controller.signal }).result()
    assert.equal(output.stopReason, "aborted", output.errorMessage)
    assert.doesNotMatch(output.errorMessage ?? "", /No accessible Kiro profile/)
  })
})

/** Returns a function that streams one "Reply OK" turn through `fetchImpl` per call. */
function kiroTurns(
  fetchImpl: typeof fetch,
  model: Partial<ModelLike> = {},
): (apiKey: string, options?: StreamOptions) => Promise<AssistantMessageLike> {
  const streamKiro = createStreamKiro({
    apiBase: "https://runtime.us-east-1.kiro.dev",
    fetchImpl,
    createStream: () => {
      let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
      const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
      const events: AssistantMessageEvent[] = []
      return {
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }
    },
    cwd: () => home,
    now: () => Date.now(),
    uuid: () => "test-conversation",
    env: { OMP_KIRO_STREAM_GATE: "0" },
    authPaths: [],
    homeDir: home,
    calculateCost: () => {},
  })
  return (apiKey, options = {}) => streamKiro({
    id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
    reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000, ...model,
  }, { messages: [{ role: "user", content: "Reply OK" }] }, { ...options, apiKey }).result()
}

/** Streams one "Reply OK" turn through `fetchImpl` and returns the final message. */
function streamOnce(
  fetchImpl: typeof fetch,
  apiKey: string,
  options: StreamOptions = {},
): Promise<AssistantMessageLike> {
  return kiroTurns(fetchImpl)(apiKey, options)
}

describe("profile region", () => {
  it("sends inference to the region that owns the profile", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EUPROFILE"
    const inferenceHosts: string[] = []
    const output = await streamOnce((async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/List-Available-Profiles") {
        return url.hostname === "management.eu-central-1.kiro.dev"
          ? response({ profiles: [{ arn: euArn }] })
          : response({ message: "User is not authorized to access this feature." }, 403)
      }
      inferenceHosts.push(url.hostname)
      return new Response('{"content":"OK"}')
    }) as typeof fetch, "eu-organization-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inferenceHosts, ["runtime.eu-central-1.kiro.dev"])
  })
})

describe("credential type header", () => {
  it("declares an API key on inference and sends the key's own profile", async () => {
    const keyArn = "arn:aws:codewhisperer:us-east-1:987654321098:profile/api-key"
    let inference: { tokenType: string | null; profileArn?: string } | undefined
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.hostname === "management.us-east-1.kiro.dev") {
        return headers.get("TokenType") === "API_KEY"
          ? response({ profile: { arn: keyArn } })
          : response({ message: "The bearer token included in the request is invalid." }, 403)
      }
      inference = { tokenType: headers.get("TokenType"), profileArn: JSON.parse(String(init?.body)).profileArn }
      return new Response('{"content":"OK"}')
    }) as typeof fetch, "ksk_example_api_key")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inference, { tokenType: "API_KEY", profileArn: keyArn })
  })

  it("recognizes an API key that arrives with surrounding whitespace", async () => {
    let inference: { authorization: string | null; tokenType: string | null } | undefined
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (new URL(String(input)).hostname === "management.us-east-1.kiro.dev") {
        return response({ profile: { arn: "arn:aws:codewhisperer:us-east-1:987654321098:profile/api-key" } })
      }
      inference = { authorization: headers.get("Authorization"), tokenType: headers.get("TokenType") }
      return new Response('{"content":"OK"}')
    }) as typeof fetch, " ksk_example_api_key\n")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inference, { authorization: "Bearer ksk_example_api_key", tokenType: "API_KEY" })
  })

  it("never lets a request header declare an OAuth token as an API key", async () => {
    let tokenTypes: Array<string | null> = []
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/default" }] })
      }
      const headers = new Headers(init?.headers)
      tokenTypes = [headers.get("TokenType")]
      return new Response('{"content":"OK"}')
    }) as typeof fetch, "header-oauth-token", { headers: { tokentype: "API_KEY", Authorization: "Bearer other" } })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(tokenTypes, [null])
  })
})

describe("reasoning stream", () => {
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  }

  /** Answers inference with `bodies` in turn; counts the calls. */
  const kiro = (bodies: string[]) => {
    const calls = { inference: 0 }
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: profileArn }] })
      }
      return new Response(bodies[calls.inference++])
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it("retries an empty turn", async () => {
    const { calls, fetchImpl } = kiro(["", '{"content":"OK"}'])
    const output = await streamOnce(fetchImpl, "empty-turn-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
  })

  it("reports a turn that only reasoned instead of replaying the shown reasoning", async () => {
    const { calls, fetchImpl } = kiro(['{"text":"Thinking"}', '{"text":"Thinking"}{"content":"OK"}'])
    const output = await streamOnce(fetchImpl, "reasoning-only-token", { reasoning: "high" })
    assert.equal(output.stopReason, "error")
    assert.match(output.errorMessage ?? "", /after reasoning, without an answer/)
    assert.equal(calls.inference, 1)
  })

  it("keeps the hidden-reasoning breadcrumb ahead of the answer across a retry", async () => {
    const { calls, fetchImpl } = kiro(["", '{"content":"OK"}'])
    const output = await kiroTurns(fetchImpl, { id: "claude-opus-4-7", reasoning: true, reasoningHidden: true })(
      "hidden-reasoning-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
  })

  it("keeps a hidden-reasoning model's reasoning off screen", async () => {
    const { fetchImpl } = kiro(['{"text":"secret"}{"content":"OK"}'])
    const output = await kiroTurns(fetchImpl, { id: "claude-opus-4-7", reasoning: true, reasoningHidden: true })(
      "hidden-reasoning-text-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
    assert.ok(!JSON.stringify(output.content).includes("secret"))
  })

  it("counts reasoning toward output tokens when Kiro reports no usage", async () => {
    const { fetchImpl } = kiro([`{"text":"${"x".repeat(400)}"}{"content":"OK"}`])
    const output = await streamOnce(fetchImpl, "reasoning-usage-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(output.usage.output, 100)
  })

  it("treats reasoning as stream activity before the first answer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    const encoder = new TextEncoder()
    let send: (chunk: string) => void = () => { throw new Error("Stream not opened") }
    let close = () => {}
    const result = streamOnce((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: profileArn }] })
      }
      return new Response(new ReadableStream({
        start(controller) {
          send = (chunk) => controller.enqueue(encoder.encode(chunk))
          close = () => controller.close()
        },
      }))
    }) as typeof fetch, "long-reasoning-token", { reasoning: "high" })

    // Reason for 200s, past the 180s first-token timeout, before answering.
    await settle()
    send('{"text":"Weighing"}')
    await settle()
    t.mock.timers.tick(100_000)
    send('{"text":" options"}')
    await settle()
    t.mock.timers.tick(100_000)
    await settle()
    send('{"content":"OK"}')
    close()

    const output = await result
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
  })

  it("asks for the largest thinking budget at max effort", async () => {
    let body = ""
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: profileArn }] })
      }
      body = String(init?.body)
      return new Response('{"content":"OK"}')
    }) as typeof fetch, "max-effort-token", { reasoning: "max" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.match(body, /<max_thinking_length>50000<\/max_thinking_length>/)
  })
})

describe("cached profile", () => {
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
  /** Streams two turns, the first rejected with a 403 `firstBody`, and counts profile lookups. */
  const twoTurns = async (firstBody: unknown) => {
    let lookups = 0
    let inferences = 0
    const turn = kiroTurns((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        lookups += 1
        return response({ profiles: [{ arn: profileArn }] })
      }
      inferences += 1
      return inferences === 1 ? response(firstBody, 403) : new Response('{"content":"OK"}')
    }) as typeof fetch)
    assert.equal((await turn("organization-token")).stopReason, "error")
    assert.equal((await turn("organization-token")).stopReason, "stop")
    return lookups
  }

  it("is looked up again after Kiro rejects a request made with it", async () => {
    assert.equal(await twoTurns({ message: "Profile not found" }), 2)
  })

  it("survives a suspension, which says nothing about the profile", async () => {
    assert.equal(await twoTurns({ reason: "TEMPORARILY_SUSPENDED" }), 1)
  })
})

describe("stale token during profile lookup", () => {
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
  const invalidBearer = { message: "The bearer token included in the request is invalid." }

  /** Installs a kiro-cli whose `whoami` renews an expired CLI token to `cli-fresh`. */
  const installKiroCli = (t: { after: (fn: () => void) => void }) => {
    const cliDir = join(home, ".local", "share", "kiro-cli")
    const bin = join(home, "bin")
    const db = join(cliDir, "data.sqlite3")
    const previousPath = process.env.PATH
    mkdirSync(cliDir, { recursive: true })
    mkdirSync(bin, { recursive: true })
    t.after(() => {
      process.env.PATH = previousPath
      rmSync(cliDir, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    })
    const token = (access: string, expiresAt: number) =>
      JSON.stringify({ access_token: access, expires_at: new Date(expiresAt).toISOString() })
    execFileSync("sqlite3", [db, "CREATE TABLE auth_kv (key TEXT, value TEXT);"
      + ` INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${token("cli-expired", Date.now() - 1000)}');`])
    writeFileSync(join(bin, "renew.sql"), `UPDATE auth_kv SET value = '${token("cli-fresh", Date.now() + 3_600_000)}';`)
    writeFileSync(join(bin, "kiro-cli"), `#!/bin/sh\nexec sqlite3 '${db}' < '${join(bin, "renew.sql")}'\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${previousPath}`
  }

  it("resyncs kiro-cli instead of failing the lookup", { skip: !hasSqlite }, async (t) => {
    installKiroCli(t)
    const inferenceTokens: (string | null)[] = []
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization")
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return authorization === "Bearer cli-fresh" ? response({ profiles: [{ arn: profileArn }] }) : response(invalidBearer, 403)
      }
      inferenceTokens.push(authorization)
      return new Response('{"content":"OK"}')
    }) as typeof fetch, "stale-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inferenceTokens, ["Bearer cli-fresh"])
  })

  it("reports a rejected API key instead of switching to the CLI identity", { skip: !hasSqlite }, async (t) => {
    installKiroCli(t)
    for (const rejectedAt of ["GetProfile", "inference"]) {
      const inferenceTokens: (string | null)[] = []
      const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const authorization = headers.get("Authorization")
        if (headers.get("X-Amz-Target") === "AmazonCodeWhispererService.GetProfile") {
          return rejectedAt === "GetProfile" ? response(invalidBearer, 403) : response({ profile: { arn: profileArn } })
        }
        if (new URL(String(input)).pathname === "/List-Available-Profiles") return response({ profiles: [{ arn: profileArn }] })
        inferenceTokens.push(authorization)
        return authorization === "Bearer cli-fresh" ? new Response('{"content":"OK"}') : response(invalidBearer, 403)
      }) as typeof fetch, `ksk_revoked_at_${rejectedAt}`)
      assert.equal(output.stopReason, "error", rejectedAt)
      assert.ok(!inferenceTokens.includes("Bearer cli-fresh"), rejectedAt)
    }
  })
})
