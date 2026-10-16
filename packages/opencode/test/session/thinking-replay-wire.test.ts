import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { generateText, jsonSchema } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_thinking_replay_fixture")
const providerID = ProviderV2.ID.make("anthropic")
const modelID = ModelV2.ID.make("claude-fable-5-1")
const media = { text: true, audio: false, image: false, video: false, pdf: false }
const model: Provider.Model = {
  id: modelID,
  providerID,
  name: "Synthetic replay fixture",
  api: { id: modelID, url: "https://fixture.invalid/v1", npm: "@ai-sdk/anthropic" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: media,
    output: media,
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, input: 100_000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
type Block = {
  reasoningContent?: {
    reasoningText?: { text: string; signature: string }
    redactedContent?: string
    redactedReasoning?: { data: string }
  }
  type?: string
  signature?: string
  thinking?: string
  text?: string
  [key: string]: unknown
}
type Wire = { system?: unknown; tools?: unknown; messages: Array<{ role: string; content: Block[] }> }

function message(
  index: number,
  role: "user" | "assistant",
  parts: Array<Record<string, unknown>>,
): SessionV1.WithParts {
  const id = MessageID.make(`msg_${String(index).padStart(3, "0")}`)
  const common = { id, sessionID, role, time: { created: index }, agent: "fixture", mode: "" }
  const info =
    role === "user"
      ? { ...common, model: { providerID, modelID }, tools: {} }
      : {
          ...common,
          parentID: MessageID.make(`msg_${String(index - 1).padStart(3, "0")}`),
          providerID,
          modelID,
          path: { cwd: "/fixture", root: "/fixture" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
  return {
    info,
    parts: parts.map((part, offset) => ({
      ...part,
      id: PartID.make(`prt_${index}_${offset}`),
      messageID: id,
      sessionID,
    })),
  } as SessionV1.WithParts
}
const thinking = (signature: string, text = "") => ({ type: "reasoning", text, metadata: { anthropic: { signature } } })

async function capture(
  history: SessionV1.WithParts[],
  target = model,
  system = "Fixed fixture instructions",
  options?: Parameters<typeof MessageV2.toModelMessages>[2],
): Promise<Wire> {
  let wire: Wire | undefined
  const transport: typeof fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Missing fixture SDK request body")
      wire = JSON.parse(init.body)
      if (target.api.npm === "@ai-sdk/amazon-bedrock")
        return Response.json({
          output: { message: { role: "assistant", content: [{ text: "fixture answer" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })
      return Response.json({
        id: "fixture-response",
        type: "message",
        role: "assistant",
        model: target.api.id,
        content: [{ type: "text", text: "fixture answer" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
    { preconnect() {} },
  )
  await generateText({
    model:
      target.api.npm === "@ai-sdk/amazon-bedrock"
        ? createAmazonBedrock({
            apiKey: "synthetic-key",
            region: "us-east-1",
            baseURL: target.api.url,
            fetch: transport,
          })(target.api.id)
        : createAnthropic({ apiKey: "synthetic-key", baseURL: target.api.url, fetch: transport })(target.api.id),
    system,
    messages: ProviderTransform.message(await MessageV2.toModelMessages(history, target, options), target, {}),
    tools: {
      read: {
        description: "Fixture read",
        inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      },
    },
    maxRetries: 0,
    providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
  })
  if (!wire) throw new Error("Fixture SDK transport was not invoked")
  return wire
}
const signatures = (wire: Wire) =>
  wire.messages
    .flatMap((message) => message.content)
    .flatMap((block) => block.signature ?? block.reasoningContent?.reasoningText?.signature ?? [])

// Synthetic opaque bytes exercise real projection and SDK serialization, not upstream cryptographic validation.
describe("signed thinking replay through the pinned Anthropic SDK", () => {
  test("unchanged history preserves empty signed thinking, its sequence and stored parts", async () => {
    const history = [
      message(1, "user", [{ type: "text", text: "question" }]),
      message(2, "assistant", [
        thinking("opaque-one"),
        thinking("opaque-two", "visible reasoning"),
        { type: "text", text: "answer" },
      ]),
      message(3, "user", [{ type: "text", text: "continue" }]),
    ]
    const saved = structuredClone(history)
    const first = await capture(history)
    expect(await capture(history)).toEqual(first)
    expect(signatures(first)).toEqual(["opaque-one", "opaque-two"])
    expect(first.messages[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "opaque-one" })
    expect(history).toEqual(saved)
  })

  test("a hidden relay backend cannot be inferred from unchanged logical model IDs", async () => {
    const history = [
      message(1, "user", [{ type: "text", text: "question" }]),
      message(2, "assistant", [thinking("opaque-relay"), { type: "text", text: "answer" }]),
      message(3, "user", [{ type: "text", text: "continue" }]),
    ]
    const first = await capture(history)
    const relay = await capture(history, { ...model, api: { ...model.api, url: "https://relay.fixture.invalid/v1" } })
    expect(relay.messages).toEqual(first.messages)
    expect(signatures(relay)).toEqual(["opaque-relay"])
  })

  test("summarizer projection removes only native signed carriers under its different system", async () => {
    const history = [
      message(1, "user", [{ type: "text", text: "question" }]),
      message(2, "assistant", [
        thinking("opaque-old"),
        { type: "reasoning", text: "", metadata: { anthropic: { redactedData: "opaque-redacted" } } },
        { type: "text", text: "answer" },
      ]),
      message(3, "user", [{ type: "text", text: "summarize" }]),
    ]
    const saved = structuredClone(history)
    const original = await capture(history)
    expect(
      original.messages.flatMap((message) => message.content).some((block) => block.type === "redacted_thinking"),
    ).toBe(true)
    const summary = await capture(history, model, "Different summarizer instructions", { stripSignedThinking: true })
    expect(summary.system).not.toEqual(original.system)
    expect(signatures(summary)).toEqual([])
    expect(
      summary.messages.flatMap((message) => message.content).some((block) => block.type === "redacted_thinking"),
    ).toBe(false)
    expect(history).toEqual(saved)
  })

  test("logical provider/model switches retain the existing reasoning-to-text compatibility policy", async () => {
    const history = [
      message(1, "user", [{ type: "text", text: "question" }]),
      message(2, "assistant", [thinking("opaque-switch", "visible reasoning"), { type: "text", text: "answer" }]),
      message(3, "user", [{ type: "text", text: "continue" }]),
    ]
    for (const target of [
      { ...model, id: ModelV2.ID.make("other-model") },
      { ...model, providerID: ProviderV2.ID.make("other-provider") },
    ]) {
      const wire = await capture(history, target)
      expect(signatures(wire)).toEqual([])
      expect(wire.messages[1].content).toContainEqual(
        expect.objectContaining({ type: "text", text: "visible reasoning" }),
      )
    }
  })

  test("Bedrock signed and redacted carriers are removed only for the changed compaction context", async () => {
    const target = {
      ...model,
      providerID: ProviderV2.ID.make("amazon-bedrock"),
      api: { ...model.api, npm: "@ai-sdk/amazon-bedrock" },
    }
    const history = [
      message(1, "user", [{ type: "text", text: "question" }]),
      message(2, "assistant", [
        { type: "reasoning", text: "", metadata: { bedrock: { signature: "opaque-bedrock" } } },
        { type: "reasoning", text: "", metadata: { bedrock: { redactedData: "cmVkYWN0ZWQ=" } } },
        { type: "reasoning", text: "", metadata: { bedrock: { redactedContent: "cmVkYWN0ZWQ=" } } },
        { type: "text", text: "answer" },
      ]),
      message(3, "user", [{ type: "text", text: "continue" }]),
    ]
    for (const entry of history) if (entry.info.role === "assistant") entry.info.providerID = target.providerID
    const original = await capture(history, target)
    expect(signatures(original)).toEqual(["opaque-bedrock"])
    expect(
      original.messages.flatMap((message) => message.content).some((block) => block.reasoningContent?.redactedContent),
    ).toBe(true)
    expect(
      original.messages
        .flatMap((message) => message.content)
        .some((block) => block.reasoningContent?.redactedReasoning),
    ).toBe(true)
    const summary = await capture(history, target, "Summarizer instructions", { stripSignedThinking: true })
    expect(signatures(summary)).toEqual([])
    expect(summary.messages.flatMap((message) => message.content).some((block) => block.reasoningContent)).toBe(false)
  })

  test("compaction does not remove unsigned or non-Claude reasoning", async () => {
    const history = [
      message(1, "user", [{ type: "text", text: "question" }]),
      message(2, "assistant", [
        { type: "reasoning", text: "unsigned reasoning" },
        { type: "text", text: "answer" },
      ]),
    ]
    const projected = await MessageV2.toModelMessages(history, model, { stripSignedThinking: true })
    expect(projected[1].content).toContainEqual(
      expect.objectContaining({ type: "reasoning", text: "unsigned reasoning" }),
    )
    const other = { ...model, api: { ...model.api, npm: "@ai-sdk/openai" } }
    history[1].parts.unshift({
      ...history[1].parts[0],
      type: "reasoning",
      text: "native reasoning",
      metadata: { anthropic: { signature: "opaque-native" } },
    } as SessionV1.Part)
    const nonClaude = await MessageV2.toModelMessages(history, other, { stripSignedThinking: true })
    expect(nonClaude[1].content).toContainEqual(
      expect.objectContaining({ type: "reasoning", text: "native reasoning" }),
    )
  })

  test("uses chronological completed boundaries across legacy IDs and a later incomplete compaction", async () => {
    const user = message(1, "user", [{ type: "text", text: "question" }])
    const old = message(2, "assistant", [thinking("opaque-old"), { type: "text", text: "old answer" }])
    old.info.id = MessageID.make("msg_fff_legacy")
    const marker = message(3, "user", [{ type: "compaction", auto: true, tail_start_id: user.info.id }])
    const summary = message(4, "assistant", [{ type: "text", text: "summary" }])
    const fresh = message(5, "assistant", [thinking("opaque-fresh"), { type: "text", text: "fresh answer" }])
    const pending = message(6, "user", [{ type: "compaction", auto: true }])
    const partial = message(7, "assistant", [
      thinking("opaque-partial-summary"),
      { type: "text", text: "partial summary" },
    ])
    if (summary.info.role !== "assistant" || partial.info.role !== "assistant")
      throw new Error("Invalid fixture assistant")
    summary.info.summary = true
    summary.info.finish = "stop"
    partial.info.summary = true
    const history = [
      marker,
      summary,
      user,
      old,
      fresh,
      pending,
      partial,
      message(8, "user", [{ type: "text", text: "continue" }]),
    ]
    expect(signatures(await capture(history))).toEqual(["opaque-fresh"])
    summary.info.finish = undefined
    expect(signatures(await capture(history))).toEqual(["opaque-old", "opaque-fresh"])
  })

  for (const native of ["anthropic", "bedrock"])
    test(`does not replay ${native} retained thinking after compaction replaces its prefix`, async () => {
      const user = message(1, "user", [{ type: "text", text: "retained question" }])
      const tail = message(2, "assistant", [
        thinking("opaque-before-compaction"),
        {
          type: "tool",
          tool: "read",
          callID: "tool_fixture",
          state: {
            status: "completed",
            input: { path: "fixture.txt" },
            output: "fixture result",
            title: "fixture",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      ])
      const marker = message(3, "user", [{ type: "compaction", auto: true, tail_start_id: user.info.id }])
      const summary = message(4, "assistant", [
        thinking("opaque-summary-context"),
        { type: "text", text: "Summary replacing the earlier prefix" },
      ])
      if (summary.info.role !== "assistant") throw new Error("Invalid fixture assistant")
      summary.info.summary = true
      summary.info.finish = "stop"
      const next = message(5, "user", [{ type: "text", text: "continue after compaction" }])
      const fresh = message(6, "assistant", [
        thinking("opaque-after-compaction"),
        { type: "text", text: "fresh answer" },
      ])
      const newest = message(7, "user", [{ type: "text", text: "continue again" }])
      const history = [user, tail, marker, summary, next, fresh, newest]
      const target =
        native === "bedrock"
          ? {
              ...model,
              providerID: ProviderV2.ID.make("amazon-bedrock"),
              api: { ...model.api, npm: "@ai-sdk/amazon-bedrock" },
            }
          : model
      if (native === "bedrock")
        for (const entry of history) {
          if (entry.info.role === "assistant") entry.info.providerID = target.providerID
          for (const part of entry.parts)
            if (part.type === "reasoning" && part.metadata?.anthropic)
              part.metadata = { bedrock: part.metadata.anthropic }
        }
      const saved = structuredClone(history)
      const original = await capture([user, tail, next], target)
      expect(signatures(original)).toEqual(["opaque-before-compaction"])
      const compacted = await capture(MessageV2.filterCompacted([...history].reverse()), target)
      expect(compacted.messages[0]).not.toEqual(original.messages[0])
      expect(signatures(compacted)).toEqual(["opaque-after-compaction"])
      expect(await capture(MessageV2.filterCompacted([...history].reverse()), target)).toEqual(compacted)
      expect(
        compacted.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === "tool_use" || block.toolUse),
      ).toHaveLength(1)
      expect(
        compacted.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === "tool_result" || block.toolResult),
      ).toHaveLength(1)
      expect(history).toEqual(saved)
    })
})
