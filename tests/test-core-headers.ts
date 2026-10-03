import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildKiroHeaders } from "../src/core.ts"

const API_KEY = "ksk_example_api_key"
const OAUTH_TOKEN = "aoa_example_oauth_token"

describe("buildKiroHeaders", () => {
  it("marks ksk_ credentials with TokenType: API_KEY", () => {
    const headers = buildKiroHeaders(API_KEY)

    assert.equal(headers["TokenType"], "API_KEY")
    assert.equal(headers.Authorization, `Bearer ${API_KEY}`)
    assert.equal(headers["Content-Type"], "application/x-amz-json-1.0")
    assert.equal(
      headers["X-Amz-Target"],
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    )
  })

  it("omits TokenType for OAuth credentials", () => {
    const headers = buildKiroHeaders(OAUTH_TOKEN)

    assert.equal("TokenType" in headers, false)
    assert.equal(headers.Authorization, `Bearer ${OAUTH_TOKEN}`)
  })
})
