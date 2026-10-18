import { expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { ThinkingReplay } from "../../src/session/thinking-replay"

const user = { role: "user", content: [{ type: "text", text: "fixture" }] }
function signed(replay: ReturnType<typeof ThinkingReplay.project>, id: string) {
  replay.bind(LLMEvent.reasoningStart({ id }))
  const end = replay.bind(LLMEvent.reasoningEnd({ id, providerMetadata: { anthropic: { signature: id } } }))
  if (end.type !== "reasoning-end") throw new Error("Expected reasoning end")
  return { type: "reasoning", text: "", providerMetadata: end.providerMetadata }
}

test("keeps subsequent signatures when only a leading thinking block was removed", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  signed(initial, "leading")
  const retained = signed(initial, "retained")
  const replay = ThinkingReplay.project({ messages: [user, { role: "assistant", content: [retained] }] })
  expect(replay.invalidated).toEqual([])
  expect(JSON.stringify(replay.messages)).toContain("retained")
  expect(JSON.stringify(replay.messages)).not.toContain("thinkingReplay")
})

test("accepts signed blocks removed from the start, the end, or the whole history", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "first")
  const middle = signed(initial, "middle")
  const last = signed(initial, "last")
  // Middle retained, leading "first" removed: legal under the GA contract.
  expect(
    ThinkingReplay.project({ messages: [user, { role: "assistant", content: [middle, last] }] }).invalidated,
  ).toEqual([])
  // Trailing "last" removed: legal — nothing follows the removed block.
  expect(
    ThinkingReplay.project({ messages: [user, { role: "assistant", content: [first, middle] }] }).invalidated,
  ).toEqual([])
  // Entire signed history removed: legal.
  expect(ThinkingReplay.project({ messages: [user] }).invalidated).toEqual([])
})

test("settles carriers removed before projection without invalidating survivors", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "first")
  const last = signed(initial, "last")
  const source = [user, { role: "assistant", content: [first, last] }]
  const sourceOrigins = ThinkingReplay.replayOrigins(source)
  const folded = [user, { role: "assistant", content: [first] }]
  const replay = ThinkingReplay.project({ messages: folded, sourceOrigins })
  // The removed trailing block is durably settled, but the retained block is
  // still replayed: a tail removal never invalidates earlier signatures.
  expect(replay.invalidated).toEqual([ThinkingReplay.origin(last.providerMetadata)!.block])
  expect(JSON.stringify(replay.messages)).toContain("first")
  expect(replay.diagnostic).toMatchObject({ removedBeforeProjection: 1, newlyInvalidated: 1 })
})

test("invalidates known signatures when the logical provider or model changes", () => {
  const context = { provider: "anthropic", model: "claude-a", sdk: "@ai-sdk/anthropic" }
  const initial = ThinkingReplay.project({ messages: [user], context })
  const thinking = signed(initial, "bound")
  const messages = [user, { role: "assistant", content: [thinking] }]
  expect(ThinkingReplay.project({ messages, context }).invalidated).toEqual([])
  const switched = ThinkingReplay.project({ messages, context: { ...context, model: "claude-b" } })
  expect(switched.invalidated).toEqual([ThinkingReplay.origin(thinking.providerMetadata)!.block])
  expect(JSON.stringify(switched.messages)).not.toContain("bound")
  expect(switched.diagnostic.prefixChanged).toBe(1)
})

test("declares an opaque upstream backend behind an unchanged logical model unobservable", () => {
  // The prefix binds provider/model/sdk as the client knows them. A relay that
  // silently switches its hidden backend or account behind the same logical
  // model cannot be detected here. This pins the declared boundary: keep the
  // block rather than guessing, record upstreamIdentity: "unobservable" in the
  // DEBUG projection, and classify any 400 via errorDiagnostic.
  const context = { provider: "amazon-bedrock", model: "relay-claude", sdk: "opaque-relay" }
  const initial = ThinkingReplay.project({ messages: [user], context })
  const thinking = signed(initial, "relay")
  const replay = ThinkingReplay.project({
    messages: [user, { role: "assistant", content: [thinking] }],
    context,
  })
  expect(replay.invalidated).toEqual([])
  expect(replay.diagnostic).toMatchObject({ retained: 1, prefixChanged: 0, chainChanged: 0 })
})

test("excludes a later signature after a missing intermediate thinking block", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "first")
  signed(initial, "middle")
  const last = signed(initial, "last")
  const replay = ThinkingReplay.project({ messages: [user, { role: "assistant", content: [first, last] }] })
  expect(replay.invalidated).toEqual([ThinkingReplay.origin(last.providerMetadata)!.block])
  expect(JSON.stringify(replay.messages)).toContain("first")
  expect(JSON.stringify(replay.messages)).not.toContain("last")
})

test("chains redacted thinking carriers like signed blocks", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "first")
  initial.bind(LLMEvent.reasoningStart({ id: "redacted" }))
  const end = initial.bind(
    LLMEvent.reasoningEnd({ id: "redacted", providerMetadata: { anthropic: { redactedData: "opaque_payload" } } }),
  )
  if (end.type !== "reasoning-end") throw new Error("Expected reasoning end")
  const redacted = { type: "reasoning", text: "", providerMetadata: end.providerMetadata }
  const last = signed(initial, "after")
  expect(
    ThinkingReplay.project({ messages: [user, { role: "assistant", content: [first, redacted, last] }] }).invalidated,
  ).toEqual([])
  // Dropping the middle redacted carrier invalidates the later signed block,
  // exactly like dropping a signed middle block.
  expect(
    ThinkingReplay.project({ messages: [user, { role: "assistant", content: [first, last] }] }).invalidated,
  ).toEqual([ThinkingReplay.origin(last.providerMetadata)!.block])
})

test("includes preceding output text within the same response in each block origin", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const first = signed(initial, "first")
  initial.bind(LLMEvent.textStart({ id: "text" }))
  initial.bind(LLMEvent.textDelta({ id: "text", text: "between" }))
  initial.bind(LLMEvent.textEnd({ id: "text" }))
  const last = signed(initial, "last")
  const messages = [user, { role: "assistant", content: [first, { type: "text", text: "between" }, last] }]
  expect(ThinkingReplay.project({ messages }).invalidated).toEqual([])
  messages[1].content[1] = { type: "text", text: "rewritten" }
  expect(ThinkingReplay.project({ messages }).invalidated).toEqual([
    ThinkingReplay.origin(last.providerMetadata)!.block,
  ])
})

test("treats cache-named business fields in tool input as bound content", () => {
  const tool = { type: "tool-call", toolCallId: "call", toolName: "fixture", input: { cacheControl: "before" } }
  const messages: { role: string; content: Record<string, unknown>[] }[] = [
    user,
    { role: "assistant", content: [tool] },
  ]
  const initial = ThinkingReplay.project({ messages })
  const thinking = signed(initial, "after-tool")
  messages[1].content.push(thinking)
  expect(ThinkingReplay.project({ messages }).invalidated).toEqual([])
  tool.input.cacheControl = "after"
  expect(ThinkingReplay.project({ messages }).invalidated).toEqual([
    ThinkingReplay.origin(thinking.providerMetadata)!.block,
  ])
})

test("keeps unknown legacy carriers and unrelated provider reasoning unchanged", () => {
  const legacy = { type: "reasoning", text: "", providerMetadata: { anthropic: { signature: "legacy" } } }
  const other = {
    type: "reasoning",
    text: "provider reasoning",
    providerMetadata: { openai: { reasoningEncryptedContent: "opaque" } },
  }
  const source = [user, { role: "assistant", content: [legacy, other] }]
  const replay = ThinkingReplay.project({ messages: source, context: { model: "changed" } })
  expect(replay.invalidated).toEqual([])
  expect(replay.messages).toEqual(source)
  expect(ThinkingReplay.origin(legacy.providerMetadata)).toBeUndefined()
})

test("compaction invalidation preserves saved carriers and settles only in projection", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const thinking = signed(initial, "compacted")
  const original = structuredClone(thinking)
  const forced = { ...thinking, providerMetadata: ThinkingReplay.forceInvalidation(thinking.providerMetadata) }
  const replay = ThinkingReplay.project({ messages: [user, { role: "assistant", content: [forced] }] })
  expect(replay.invalidated).toEqual([ThinkingReplay.origin(thinking.providerMetadata)!.block])
  expect(JSON.stringify(replay.messages)).not.toContain("compacted")
  expect(thinking).toEqual(original)
  const marked = ThinkingReplay.invalidate(thinking.providerMetadata)
  expect(marked).toEqual({
    ...original.providerMetadata,
    opencode: { thinkingReplay: { ...ThinkingReplay.origin(original.providerMetadata)!, invalidated: true } },
  })
  expect(
    ThinkingReplay.project({
      messages: [user, { role: "assistant", content: [{ ...thinking, providerMetadata: marked }] }],
    }).invalidated,
  ).toEqual([])
})

test("detects a reordered tools array in the final outbound prefix", () => {
  const a = { type: "function", name: "a", inputSchema: { type: "object", properties: {} } }
  const b = { type: "function", name: "b", inputSchema: { type: "object", properties: {} } }
  const initial = ThinkingReplay.project({ messages: [user], tools: [a, b] })
  const thinking = signed(initial, "ordered-tools")
  const messages = [user, { role: "assistant", content: [thinking] }]
  expect(ThinkingReplay.project({ messages, tools: [a, b] }).invalidated).toEqual([])
  expect(ThinkingReplay.project({ messages, tools: [b, a] }).invalidated).toEqual([
    ThinkingReplay.origin(thinking.providerMetadata)!.block,
  ])
})

test("preserves SDK system string and native content-array representations", () => {
  const sdk = [{ role: "system", content: "system fixture" }, user]
  expect(ThinkingReplay.project({ messages: sdk }).messages).toEqual(sdk)
  const native = [{ role: "user", content: [{ type: "text", text: "native fixture" }] }]
  expect(ThinkingReplay.project({ messages: native }).messages).toEqual(native)
})

test("binds system message provider options that alter native system blocks", () => {
  const system = { role: "system", content: "system fixture", providerOptions: { anthropic: { effort: "low" } } }
  const initial = ThinkingReplay.project({ messages: [system, user] })
  const thinking = signed(initial, "system-options")
  const messages = [system, user, { role: "assistant", content: [thinking] }]
  expect(ThinkingReplay.project({ messages }).invalidated).toEqual([])
  system.providerOptions.anthropic.effort = "high"
  expect(ThinkingReplay.project({ messages }).invalidated).toEqual([
    ThinkingReplay.origin(thinking.providerMetadata)!.block,
  ])
})

test("tracks installed SDK wire changes from inline system toolChanges", async () => {
  const { createAnthropic } = await import("@ai-sdk/anthropic")
  let captured: unknown
  const model = createAnthropic({
    apiKey: "fixture",
    fetch: Object.assign(
      async (_url: RequestInfo | URL, options?: RequestInit) => {
        if (typeof options?.body !== "string") throw new Error("Missing serialized SDK body")
        captured = JSON.parse(options.body)
        throw new Error("Request captured without network")
      },
      { preconnect: () => undefined },
    ),
  })("claude-haiku-5-5")
  const changes = [{ type: "tool_removal", toolName: "fixture_a" }]
  const prompt: import("@ai-sdk/provider").LanguageModelV3Prompt = [
    { role: "system", content: "initial" },
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "system", content: "update", providerOptions: { anthropic: { toolChanges: changes } } },
  ]
  async function capture(input: typeof prompt) {
    captured = undefined
    try {
      await model.doGenerate({ prompt: input, maxOutputTokens: 32 })
    } catch {
      /* Capture intentionally stops transport. */
    }
    if (captured === undefined) throw new Error("SDK transport was not reached")
    return captured
  }
  const initial = ThinkingReplay.project({ messages: prompt })
  const thinking = signed(initial, "inline-system-tools")
  const before = await capture(initial.messages)
  changes[0].toolName = "fixture_b"
  const after = await capture(ThinkingReplay.project({ messages: prompt }).messages)
  expect(JSON.stringify(before)).toContain('"name":"fixture_a"')
  expect(JSON.stringify(after)).toContain('"name":"fixture_b"')
  expect(after).not.toEqual(before)
  const replay = ThinkingReplay.project({ messages: [...prompt, { role: "assistant", content: [thinking] }] })
  expect(replay.invalidated).toEqual([ThinkingReplay.origin(thinking.providerMetadata)!.block])
})

test("settles known carriers removed before the final projection without rechecking a source prefix", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const thinking = signed(initial, "removed-by-projection")
  const source = [user, { role: "assistant", content: [thinking, { type: "text", text: "answer" }] }]
  const sourceOrigins = ThinkingReplay.replayOrigins(source)
  const expected = ThinkingReplay.origin(thinking.providerMetadata)!.block
  expect(sourceOrigins).toEqual([expected])
  expect(ThinkingReplay.project({ messages: source, sourceOrigins }).invalidated).toEqual([])
  const folded = [user, { role: "assistant", content: [{ type: "text", text: "answer" }] }]
  const final = ThinkingReplay.project({ messages: folded, sourceOrigins })
  expect(final.invalidated).toEqual([expected])
  expect(final.messages).toEqual(folded)
  expect(final.diagnostic).toMatchObject({ removedBeforeProjection: 1, newlyInvalidated: 1 })
  expect(JSON.stringify(final.messages)).not.toContain(expected)
})

test("origin inventories ignore unknown legacy and durable tombstones", () => {
  const initial = ThinkingReplay.project({ messages: [user] })
  const thinking = signed(initial, "already-settled")
  const legacy = { type: "reasoning", text: "", providerMetadata: { anthropic: { signature: "legacy" } } }
  const marked = { ...thinking, providerMetadata: ThinkingReplay.invalidate(thinking.providerMetadata) }
  expect(ThinkingReplay.replayOrigins([user, { role: "assistant", content: [legacy, marked] }])).toEqual([])
})
