/**
 * Tests for the Kiro message converter and event stream decoder.
 *
 * These are pure functions — no network, no mocks needed.
 * Uses Node.js built-in test runner.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { buildKiroPayload } from "../src/converters.ts"
import { AwsEventStreamParser } from "../src/eventstream.ts"
import type { ContextLike, KiroEvent } from "../src/types.ts"

// ============================================================================
// Converter tests
// ============================================================================

describe("buildKiroPayload", () => {
  it("builds minimal single-message payload", () => {
    const ctx: ContextLike = {
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    }

    const payload = buildKiroPayload("claude-sonnet-4-5", ctx)

    assert.ok(payload.conversationState)
    assert.ok(payload.conversationState.currentMessage)
    assert.ok(payload.conversationState.currentMessage.userInputMessage)
    assert.equal(payload.conversationState.chatTriggerType, "MANUAL")

    const userInput = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    // System prompt should be prepended to the only message (which is current)
    assert.ok(String(userInput.content).includes("You are helpful."))
    assert.ok(String(userInput.content).includes("Hello"))
    assert.equal(userInput.modelId, "claude-sonnet-4.5")
    assert.equal(userInput.origin, "KIRO_CLI")
  })

  it("builds multi-turn payload with history", () => {
    const ctx: ContextLike = {
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Second message" },
      ],
      tools: [],
    }

    const payload = buildKiroPayload("claude_sonnet_4_5", ctx)

    // First two messages go into history, last is current
    assert.ok(payload.conversationState.history)
    const history = payload.conversationState.history as unknown[]

    assert.equal(history.length, 2)

    // First history entry: user with system prompt
    const firstHist = history[0] as Record<string, unknown>
    assert.ok(firstHist.userInputMessage)
    const firstUser = firstHist.userInputMessage as Record<string, unknown>
    assert.ok(String(firstUser.content).includes("System prompt"))
    assert.ok(String(firstUser.content).includes("First message"))

    // Second history entry: assistant
    const secondHist = history[1] as Record<string, unknown>
    assert.ok(secondHist.assistantResponseMessage)

    // Current message: last user message
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    assert.equal(current.content, "Second message")
  })

  it("includes tools in userInputMessageContext", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "Use a tool" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    }

    const payload = buildKiroPayload("claude_sonnet_4_5", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>

    assert.ok(current.userInputMessageContext)
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    assert.ok(userCtx.tools)
    const tools = userCtx.tools as unknown[]
    assert.equal(tools.length, 1)
    assert.equal((tools[0] as Record<string, unknown>).name, "read_file")
  })

  it("truncates tool names > 64 chars", () => {
    const longName = "a".repeat(100)
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: longName, description: "desc", input_schema: {} }],
    }

    const payload = buildKiroPayload("claude_sonnet_4_5", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as Array<Record<string, unknown>>

    assert.equal(tools[0].name.length, 64)
  })

  it("includes profileArn when provided", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    }

    const payload = buildKiroPayload("model", ctx, "arn:aws:codewhisperer:us-east-1:123")
    assert.equal(payload.profileArn, "arn:aws:codewhisperer:us-east-1:123")
  })

  it("includes tool results in history user messages", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "/foo" } }],
        },
        {
          role: "user",
          content: "",
          toolResults: [{ toolCallId: "tc1", content: "file contents" }],
        },
      ],
      tools: [{ name: "read_file", description: "read", input_schema: {} }],
    }

    const payload = buildKiroPayload("model", ctx)
    const history = payload.conversationState.history as Array<Record<string, unknown>>

    // First: user, Second: assistant with toolUses, Third: user with toolResults → current
    assert.equal(history.length, 2)

    // Second history entry should have toolUses in assistant
    const assistantEntry = history[1] as Record<string, unknown>
    const assistantMsg = assistantEntry.assistantResponseMessage as Record<string, unknown>
    assert.ok(assistantMsg.toolUses)
  })

  it("uses (empty placeholder) for empty content", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "" }],
      tools: [],
    }

    const payload = buildKiroPayload("model", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    assert.equal(current.content, "(empty placeholder)")
  })
})

// ============================================================================
// Event stream decoder tests
// ============================================================================

describe("AwsEventStreamParser", () => {
  it("parses content events", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(Buffer.from('some:binary:prefix:headers {"content":"Hello world"}'))

    assert.equal(events.length, 1)
    assert.equal(events[0].type, "content")
    if (events[0].type === "content") {
      assert.equal(events[0].content, "Hello world")
    }
  })

  it("deduplicates repeated content", () => {
    const parser = new AwsEventStreamParser()
    const events1 = parser.feed(Buffer.from('{"content":"Hello"}'))
    const events2 = parser.feed(Buffer.from('{"content":"Hello"}')) // same

    assert.equal(events1.length, 1)
    assert.equal(events2.length, 0) // deduplicated
  })

  it("parses tool start events", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(
      Buffer.from('{"name":"read_file","toolUseId":"tu1","input":{"path":"/foo"}}'),
    )

    assert.equal(events.length, 1)
    if (events[0].type === "tool_start") {
      assert.equal(events[0].name, "read_file")
      assert.equal(events[0].toolUseId, "tu1")
      assert.equal(events[0].input, '{"path":"/foo"}')
    }
  })

  it("parses tool start with stop=true (single-shot tool)", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(
      Buffer.from('{"name":"get_time","toolUseId":"tu2","input":"","stop":true}'),
    )

    assert.equal(events.length, 1)
    if (events[0].type === "tool_start") {
      assert.equal(events[0].stop, true)
    }
  })

  it("parses tool input continuation", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(Buffer.from('{"input":"more data"}'))

    assert.equal(events.length, 1)
    if (events[0].type === "tool_input") {
      assert.equal(events[0].input, "more data")
    }
  })

  it("parses tool stop", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(Buffer.from('{"stop":true}'))

    assert.equal(events.length, 1)
    if (events[0].type === "tool_stop") {
      assert.equal(events[0].stop, true)
    }
  })

  it("handles incremental chunks (incomplete JSON)", () => {
    const parser = new AwsEventStreamParser()

    // Feed first half
    const events1 = parser.feed(Buffer.from('{"content":'))
    assert.equal(events1.length, 0) // incomplete

    // Feed second half
    const events2 = parser.feed(Buffer.from('"complete text"}'))
    assert.equal(events2.length, 1)
    if (events2[0].type === "content") {
      assert.equal(events2[0].content, "complete text")
    }
  })

  it("parses usage events", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(Buffer.from('{"usage":{"inputTokens":100,"outputTokens":42}}'))
    assert.equal(events.length, 1)
    if (events[0].type === "usage") {
      assert.equal(events[0].inputTokens, 100)
      assert.equal(events[0].outputTokens, 42)
    }
  })
  it("parses usage events with only inputTokens", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(Buffer.from('{"usage":{"inputTokens":200}}'))
    assert.equal(events.length, 1)
    if (events[0].type === "usage") {
      assert.equal(events[0].inputTokens, 200)
      assert.equal(events[0].outputTokens, undefined)
    }
  })

  it("parses context_usage events", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(Buffer.from('{"contextUsagePercentage":75.5}'))

    assert.equal(events.length, 1)
    if (events[0].type === "context_usage") {
      assert.equal(events[0].percentage, 75.5)
    }
  })

  it("handles multiple events in one chunk", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(
      Buffer.from('garbage{"content":"hello"}more garbage{"content":"world"}'),
    )

    assert.equal(events.length, 2)
    if (events[0].type === "content" && events[1].type === "content") {
      assert.equal(events[0].content, "hello")
      assert.equal(events[1].content, "world")
    }
  })

  it("resets state correctly", () => {
    const parser = new AwsEventStreamParser()
    parser.feed(Buffer.from('{"content":"before"}'))

    parser.reset()

    const events = parser.feed(Buffer.from('{"content":"before"}'))
    assert.equal(events.length, 1) // no longer deduplicated after reset
  })

  it("handles JSON with nested braces", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(
      Buffer.from('{"name":"tool","toolUseId":"t1","input":{"nested":{"deep":"value"}}}'),
    )

    assert.equal(events.length, 1)
    if (events[0].type === "tool_start") {
      assert.ok(events[0].input.includes("nested"))
    }
  })

  it("handles JSON with strings containing braces", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(
      Buffer.from('{"content":"text with {braces} inside"}'),
    )

    assert.equal(events.length, 1)
    if (events[0].type === "content") {
      assert.equal(events[0].content, "text with {braces} inside")
    }
  })
})

// ============================================================================
// ThinkingTagParser tests
// ============================================================================

import { ThinkingTagParser } from "../src/thinking-parser.ts"
import type { AssistantMessageEvent, AssistantMessageLike } from "../src/types.ts"

function createTestOutput(): { output: AssistantMessageLike; events: AssistantMessageEvent[] } {
  const events: AssistantMessageEvent[] = []
  const output: AssistantMessageLike = {
    role: "assistant",
    content: [],
    api: "kiro-custom",
    provider: "kiro",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }
  return { output, events }
}

describe("ThinkingTagParser", () => {
  it("extracts thinking block from <thinking> tags", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>Let me think")
    parser.processChunk(" about this</thinking>Here is my answer")
    parser.finalize()

    // Should have: thinking block then text block
    assert.equal(output.content.length, 2)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "Let me think about this")
    assert.equal(output.content[1].type, "text")
    assert.equal((output.content[1] as { text: string }).text, "Here is my answer")
  })

  it("handles thinking-only response", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>Just thinking")
    parser.finalize()

    assert.equal(output.content.length, 1)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "Just thinking")
  })

  it("handles text-only response (no thinking tags)", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("Just plain text here")
    parser.finalize()

    assert.equal(output.content.length, 1)
    assert.equal(output.content[0].type, "text")
    assert.equal((output.content[0] as { text: string }).text, "Just plain text here")
  })

  it("handles split tag across chunks", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("Some text<thin")
    parser.processChunk("king>hidden thought</thinking>more text")
    parser.finalize()

    // Thinking is spliced before text (Kiro convention: thinking → text order)
    assert.equal(output.content.length, 3)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "hidden thought")
    assert.equal(output.content[1].type, "text")
    assert.equal((output.content[1] as { text: string }).text, "Some text")
    assert.equal(output.content[2].type, "text")
    assert.equal((output.content[2] as { text: string }).text, "more text")
  })

  it("recognizes <reasoning> tag variant", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<reasoning>reasoning here</reasoning>answer")
    parser.finalize()

    assert.equal(output.content.length, 2)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "reasoning here")
  })

  it("recognizes <thought> tag variant", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thought>my thoughts</thought>result")
    parser.finalize()

    assert.equal(output.content.length, 2)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "my thoughts")
  })

  it("emits proper thinking_start/delta/end events", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>hello</thinking>world")
    parser.finalize()

    const types = events.map((e) => e.type)
    assert.ok(types.includes("thinking_start"))
    assert.ok(types.includes("thinking_delta"))
    assert.ok(types.includes("thinking_end"))
    assert.ok(types.includes("text_start"))
    assert.ok(types.includes("text_delta"))
  })

  it("reorders thinking before text when text arrives first", () => {
    // Kiro sends text before thinking — parser should splice thinking block before text
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("some text<thinking>my thoughts</thinking>more text")
    parser.finalize()

    // Order should be: thinking, text("some text"), text("more text")
    assert.equal(output.content.length, 3)
    assert.equal(output.content[0].type, "thinking")
    assert.equal(output.content[1].type, "text")
    assert.equal(output.content[2].type, "text")
  })

  it("getTextBlockIndex returns null for empty parser", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))
    assert.equal(parser.getTextBlockIndex(), null)
  })

  it("getTextBlockIndex returns text index after processing", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>thought</thinking>text here")
    parser.finalize()

    assert.equal(parser.getTextBlockIndex(), 1) // index 0 is thinking, index 1 is text
  })
})

// ============================================================================
// Bracket tool parser tests
// ============================================================================

import { parseBracketToolCalls } from "../src/bracket-tool-parser.ts"

describe("parseBracketToolCalls", () => {
  it("extracts a bracket-style tool call", () => {
    const text = 'I need to use a tool. [Called read_file with args: {"path": "/tmp/test.txt"}] Done.'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read_file")
    assert.deepEqual(result.toolCalls[0].arguments, { path: "/tmp/test.txt" })
    assert.ok(result.cleanedText.includes("I need to use a tool."))
    assert.ok(result.cleanedText.includes("Done."))
    assert.ok(!result.cleanedText.includes("[Called"))
  })

  it("returns empty array for text without bracket patterns", () => {
    const result = parseBracketToolCalls("Just regular text here")
    assert.equal(result.toolCalls.length, 0)
    assert.equal(result.cleanedText, "Just regular text here")
  })

  it("handles multiple bracket tool calls", () => {
    const text = '[Called func_a with args: {"x": 1}] middle [Called func_b with args: {"y": 2}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 2)
    assert.equal(result.toolCalls[0].name, "func_a")
    assert.equal(result.toolCalls[1].name, "func_b")
  })

  it("handles nested JSON in args", () => {
    const text = '[Called tool with args: {"config": {"nested": true, "arr": [1, 2]}}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 1)
    assert.deepEqual(result.toolCalls[0].arguments, { config: { nested: true, arr: [1, 2] } })
  })

  it("skips malformed JSON", () => {
    const text = '[Called tool with args: {broken json}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 0)
  })

  it("generates unique toolUseId for each call", () => {
    const text = '[Called f with args: {"a": 1}] [Called f with args: {"b": 2}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 2)
    assert.notEqual(result.toolCalls[0].toolUseId, result.toolCalls[1].toolUseId)
  })
})

// ============================================================================
// History management tests
// ============================================================================

describe("buildKiroPayload with history truncation", () => {
  it("truncates large history to fit context window", () => {
    // Create a very long history that exceeds the limit
    const messages: Array<{ role: string; content: string }> = []
    // Add 1000 pairs of user/assistant messages with long content
    for (let i = 0; i < 1000; i++) {
      messages.push({ role: "user", content: `User message ${i} `.repeat(100) })
      messages.push({ role: "assistant", content: `Assistant response ${i} `.repeat(100) })
    }
    messages.push({ role: "user", content: "Final message" })

    const ctx: ContextLike = {
      messages,
      tools: [],
      systemPrompt: "Test system prompt",
    }

    // Small context window = tight limit
    const payload = buildKiroPayload("test-model", ctx, undefined, undefined, 200000)

    // History should be significantly shorter than 2000 messages
    const history = payload.conversationState.history as unknown[]
    assert.ok(history.length < 2000, `History was ${history.length}, expected < 2000`)
    // But should still have content
    assert.ok(history.length > 0)
  })

  it("preserves all history when under limit", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ]

    const ctx: ContextLike = {
      messages,
      tools: [],
      systemPrompt: "Test",
    }

    const payload = buildKiroPayload("test-model", ctx, undefined, undefined, 200000)
    const history = payload.conversationState.history as unknown[]
    // Should have 2 entries: user("Hello") + assistant("Hi there")
    assert.equal(history.length, 2)
  })

  it("injects thinking mode into system prompt when model has reasoning", () => {
    // This tests the payload builder's behavior when the system prompt
    // contains thinking mode directives (injected by core.ts before calling buildKiroPayload)
    const ctx: ContextLike = {
      messages: [{ role: "user", content: "Think about this" }],
      tools: [],
      systemPrompt: "<thinking_mode>enabled</thinking_mode><max_thinking_length>10000</max_thinking_length>\nYou are helpful",
    }

    const payload = buildKiroPayload("test-model", ctx)

    // System prompt should be prepended to the first user message
    const userMsg = (payload.conversationState.currentMessage as Record<string, unknown>).userInputMessage as Record<string, unknown>
    const content = String(userMsg.content)
    assert.ok(content.includes("<thinking_mode>enabled</thinking_mode>"))
    assert.ok(content.includes("<max_thinking_length>10000</max_thinking_length>"))
    assert.ok(content.includes("Think about this"))
  })
})
