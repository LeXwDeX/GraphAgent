// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Token } from "@/util/token"
import {
  estimateOverhead,
  estimatePendingToolOutputTokens,
  estimateRequest,
  isOverflow,
  serializedTools,
  usable,
  windowOf,
} from "../../src/session/overflow"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

describe("estimateRequest", () => {
  test("counts CJK text near one token per character", () => {
    const messages = [{ role: "user", content: "中".repeat(4_000) }]
    const naive = Token.estimate(JSON.stringify({ system: [], messages }))
    expect(naive).toBeLessThan(1_200)
    expect(estimateRequest({ system: [], messages })).toBeGreaterThanOrEqual(4_000)
  })

  test("includes system text and tool schemas", () => {
    const base = estimateRequest({ system: [], messages: [] })
    const withSystem = estimateRequest({ system: ["x".repeat(4_000)], messages: [] })
    const withTools = estimateRequest({
      system: [],
      messages: [],
      tools: { read: { description: "y".repeat(4_000), parameters: { type: "object" } } },
    })
    expect(withSystem).toBeGreaterThan(base + 900)
    expect(withTools).toBeGreaterThan(base + 900)
  })

  test("counts the AI SDK inputSchema shape, not only descriptions", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "z".repeat(4_000) } } }
    const withDescriptionOnly = estimateRequest({
      system: [],
      messages: [],
      tools: { lookup: { description: "lookup" } },
    })
    const withSchema = estimateRequest({
      system: [],
      messages: [],
      tools: { lookup: { description: "lookup", inputSchema: { jsonSchema: schema } } },
    })
    expect(withSchema).toBeGreaterThan(withDescriptionOnly + 900)
  })
})

describe("estimateOverhead", () => {
  test("counts system and tool schemas without any messages", () => {
    const base = estimateOverhead({ system: [] })
    const withSystem = estimateOverhead({ system: ["x".repeat(4_000)] })
    const withTools = estimateOverhead({
      system: [],
      tools: { lookup: { description: "y".repeat(4_000), parameters: { type: "object" } } },
    })
    expect(base).toBeLessThan(20)
    expect(withSystem).toBeGreaterThan(base + 900)
    expect(withTools).toBeGreaterThan(base + 900)
    expect(withSystem + withTools).toBeGreaterThan(base + 1_800)
  })

  test("counts the AI SDK inputSchema shape", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "z".repeat(4_000) } } }
    expect(
      estimateOverhead({ system: [], tools: { lookup: { inputSchema: { jsonSchema: schema } } } }),
    ).toBeGreaterThan(900)
  })

  test("reuses a pre-serialized tool fragment without touching tool schemas", () => {
    let accesses = 0
    const tools = {
      lookup: {
        description: "lookup",
        get inputSchema() {
          accesses += 1
          return { jsonSchema: { type: "object", properties: { query: { type: "string" } } } }
        },
      },
    }
    const system = ["s".repeat(100)]
    const toolsJson = JSON.stringify(serializedTools(tools))
    const expected = estimateOverhead({ system, tools })

    accesses = 0
    expect(estimateOverhead({ system, tools, toolsJson })).toBe(expected)
    expect(accesses).toBe(0)
  })

  test("keeps the legacy JSON shape for empty and absent tools", () => {
    expect(estimateOverhead({ system: ["x"], tools: undefined })).toBe(Token.estimateReserve('{"system":["x"]}'))
    expect(estimateOverhead({ system: ["x"], tools: {} })).toBe(Token.estimateReserve('{"system":["x"],"tools":[]}'))
  })
})

describe("usable output reserve", () => {
  const model = (context: number, output: number, input?: number) =>
    ({
      id: "reasoner",
      providerID: "local",
      limit: { context, output, ...(input === undefined ? {} : { input }) },
    }) as any
  const cfg = (output?: number) =>
    ({
      compaction: {},
      ...(output === undefined
        ? {}
        : { provider: { local: { models: { reasoner: { limit: { context: 128_000, output } } } } } }),
    }) as any

  test("keeps the existing reserve for context windows larger than the output budget", () => {
    expect(usable({ cfg: cfg(), model: model(1_000_000, 384_000) })).toBe(968_000)
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000) })).toBe(168_000)
  })

  test("does not starve a small-context model when the configured output budget is large", () => {
    const small = model(128_000, 384_000)
    expect(usable({ cfg: cfg(384_000), model: small })).toBe(20_000)
    expect(usable({ cfg: cfg(), model: model(128_000, 32_000) })).toBe(96_000)
    expect(usable({ cfg: cfg(), model: model(8_000, 32_000) })).toBe(8_000)
  })

  test("compacts a small context window at the input budget left by the output reserve", () => {
    const small = model(8_192, 2_048)
    const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(usable({ cfg: cfg(), model: small })).toBe(6_144)
    expect(isOverflow({ cfg: cfg(), model: small, tokens: none, estimatedInputTokens: 6_143 })).toBe(false)
    expect(isOverflow({ cfg: cfg(), model: small, tokens: none, estimatedInputTokens: 6_144 })).toBe(true)
    expect(isOverflow({ cfg: cfg(), model: small, tokens: none, estimatedInputTokens: 7_000 })).toBe(true)
  })

  test("keeps a configured output budget above the window from disabling compaction", () => {
    const small = model(128_000, 384_000)
    const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(usable({ cfg: cfg(384_000), model: small })).toBe(20_000)
    expect(isOverflow({ cfg: cfg(384_000), model: small, tokens: none, estimatedInputTokens: 19_999 })).toBe(false)
    expect(isOverflow({ cfg: cfg(384_000), model: small, tokens: none, estimatedInputTokens: 20_000 })).toBe(true)
  })

  test("keeps the input-cap reserve independent of the output budget", () => {
    expect(usable({ cfg: cfg(384_000), model: model(1_050_000, 128_000, 922_000) })).toBe(902_000)
  })

  test("keeps the experimental output override authoritative", () => {
    const small = model(128_000, 384_000)
    expect(usable({ cfg: cfg(384_000), model: small, outputTokenMax: 32_000 })).toBe(96_000)
  })

  test("reserves an environment override above the conservative default for a catalog-only limit", () => {
    expect(usable({ cfg: cfg(), model: model(1_000_000, 128_000), outputTokenMax: 64_000 })).toBe(936_000)
    expect(usable({ cfg: cfg(), model: model(1_000_000, 128_000) })).toBe(968_000)
  })

  test("sizes the trigger line from the default window when the model declares none", () => {
    expect(windowOf(model(0, 32_000))).toBe(128_000)
    expect(windowOf(model(200_000, 32_000))).toBe(200_000)
    expect(usable({ cfg: cfg(), model: model(0, 32_000) })).toBe(96_000)
    expect(usable({ cfg: cfg(), model: model(0, 8_192) })).toBe(119_808)
    expect(usable({ cfg: cfg(), model: model(0, 32_000, 100_000) })).toBe(80_000)
  })

  test("compacts a model with an unknown window at the default window's input budget", () => {
    const unknown = model(0, 32_000)
    const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(isOverflow({ cfg: cfg(), model: unknown, tokens: none, estimatedInputTokens: 95_999 })).toBe(false)
    expect(isOverflow({ cfg: cfg(), model: unknown, tokens: none, estimatedInputTokens: 96_000 })).toBe(true)
  })

  test("keeps automatic compaction off for an unknown window when the user disabled it", () => {
    const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const off = { ...cfg(), compaction: { auto: false } }
    expect(isOverflow({ cfg: off, model: model(0, 32_000), tokens: none, estimatedInputTokens: 500_000 })).toBe(false)
  })
})

describe("estimatePendingToolOutputTokens", () => {
  const sessionID = SessionID.make("ses_pending_tool_output")
  const messageID = MessageID.make("msg_pending_tool_output")
  const completed = (output: string, compacted?: number) =>
    ({
      status: "completed",
      input: {},
      output,
      title: "tool",
      metadata: {},
      time: { start: 0, end: 1, ...(compacted === undefined ? {} : { compacted }) },
    }) satisfies SessionV1.ToolStateCompleted
  const failed = (error: string) =>
    ({ status: "error", input: {}, error, time: { start: 0, end: 1 } }) satisfies SessionV1.ToolStateError
  const turn = (...states: SessionV1.ToolPart["state"][]) =>
    ({
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: 0 },
        parentID: MessageID.make("msg_pending_tool_output_parent"),
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: states.map((state, index) => ({
        id: PartID.make(`prt_pending_tool_output_${index}`),
        sessionID,
        messageID,
        type: "tool" as const,
        callID: `call_${index}`,
        tool: "read",
        state,
      })),
    }) satisfies SessionV1.WithParts

  test("counts a completed tool output at the reserve rate, not length / 4", () => {
    const messages = [turn(completed("中".repeat(4_000)))]
    expect(Token.estimate("中".repeat(4_000))).toBeLessThan(1_200)
    expect(estimatePendingToolOutputTokens(messages, 0)).toBeGreaterThanOrEqual(4_000)
  })

  test("counts a failed tool call by its error text", () => {
    expect(estimatePendingToolOutputTokens([turn(failed("中".repeat(1_000)))], 0)).toBeGreaterThanOrEqual(1_000)
  })

  test("adds up every call and ignores compacted outputs, empty outputs and missing messages", () => {
    const messages = [turn(completed("中".repeat(300)), failed("错".repeat(200)), completed("中".repeat(900), 5))]
    expect(estimatePendingToolOutputTokens(messages, 0)).toBe(500)
    expect(estimatePendingToolOutputTokens([turn(completed(""))], 0)).toBe(0)
    expect(estimatePendingToolOutputTokens(messages, 1)).toBe(0)
    expect(estimatePendingToolOutputTokens(messages, -1)).toBe(0)
  })
})
