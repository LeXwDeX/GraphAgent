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
  triggerLimit,
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
  const model = (context: number, output: number, input?: number, effectiveContext?: number) =>
    ({
      id: "reasoner",
      providerID: "local",
      limit: { context, output, ...(input === undefined ? {} : { input }) },
      profile: { context, effectiveContext, sources: {} },
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

  test("applies compaction.reserved to a model without an input cap", () => {
    const reserved = (value: number) => ({ ...cfg(), compaction: { reserved: value } })
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000) })).toBe(168_000)
    expect(usable({ cfg: reserved(40_000), model: model(200_000, 32_000) })).toBe(160_000)
    expect(usable({ cfg: reserved(0), model: model(200_000, 32_000) })).toBe(200_000)
    // A reserve at least as large as the window cannot be taken from it: keep up to the compaction buffer instead.
    expect(usable({ cfg: reserved(200_000), model: model(200_000, 32_000) })).toBe(20_000)
    expect(usable({ cfg: reserved(500_000), model: model(8_000, 32_000) })).toBe(8_000)
    // The input-cap branch has always read it.
    expect(usable({ cfg: reserved(50_000), model: model(1_050_000, 128_000, 922_000) })).toBe(872_000)
  })

  test("takes the window from profile.effective_context when it is smaller than the declared window", () => {
    expect(windowOf(model(200_000, 32_000, undefined, 100_000))).toBe(100_000)
    expect(windowOf(model(200_000, 32_000, undefined, 300_000))).toBe(200_000)
    expect(windowOf(model(200_000, 32_000, undefined, 0))).toBe(200_000)
    expect(windowOf(model(0, 32_000, undefined, 100_000))).toBe(100_000)
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000, undefined, 100_000) })).toBe(68_000)
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000, undefined, 300_000) })).toBe(168_000)
  })

  test("caps an input limit at the effective window and leaves it alone without one", () => {
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000, 180_000) })).toBe(160_000)
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000, 180_000, 100_000) })).toBe(80_000)
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000, 180_000, 300_000) })).toBe(160_000)
    // An input limit already below the effective window stays the base.
    expect(usable({ cfg: cfg(), model: model(200_000, 32_000, 60_000, 100_000) })).toBe(40_000)
    // The window is unknown: the input limit is not capped at the assumed window unless a smaller one is declared.
    expect(usable({ cfg: cfg(), model: model(0, 32_000, 200_000) })).toBe(180_000)
    expect(usable({ cfg: cfg(), model: model(0, 32_000, 200_000, 100_000) })).toBe(80_000)
  })

  describe("compaction.trigger_ratio", () => {
    const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const ratio = (value: number | undefined, extra: Record<string, unknown> = {}) => ({
      ...cfg(),
      compaction: { ...(value === undefined ? {} : { trigger_ratio: value }), ...extra },
    })

    test("leaves the trigger line at the usable budget when it is not set", () => {
      expect(triggerLimit({ cfg: ratio(undefined), model: model(200_000, 32_000) })).toBe(168_000)
      expect(triggerLimit({ cfg: cfg(), model: model(200_000, 32_000) })).toBe(168_000)
      expect(triggerLimit({ cfg: ratio(undefined), model: model(0, 32_000) })).toBe(96_000)
    })

    test("triggers at a share of the window, never above the usable budget", () => {
      const window = model(200_000, 32_000)
      expect(triggerLimit({ cfg: ratio(0.5), model: window })).toBe(100_000)
      expect(triggerLimit({ cfg: ratio(0.1), model: window })).toBe(20_000)
      expect(triggerLimit({ cfg: ratio(0.9), model: window })).toBe(168_000)
      expect(triggerLimit({ cfg: ratio(1), model: window })).toBe(168_000)
      expect(triggerLimit({ cfg: ratio(0.5), model: model(100_003, 32_000) })).toBe(50_001)
    })

    test("takes the share from the effective window and from the default window of an unknown one", () => {
      expect(triggerLimit({ cfg: ratio(undefined), model: model(200_000, 32_000, undefined, 100_000) })).toBe(68_000)
      expect(triggerLimit({ cfg: ratio(0.5), model: model(200_000, 32_000, undefined, 100_000) })).toBe(50_000)
      expect(triggerLimit({ cfg: ratio(0.5), model: model(0, 32_000) })).toBe(64_000)
    })

    test("takes the share from the window, not from the input limit", () => {
      expect(triggerLimit({ cfg: ratio(undefined), model: model(1_000_000, 128_000, 922_000) })).toBe(902_000)
      expect(triggerLimit({ cfg: ratio(0.5), model: model(1_000_000, 128_000, 922_000) })).toBe(500_000)
    })

    test("moves the compaction boundary with the share and keeps the on/off switch authoritative", () => {
      const window = model(200_000, 32_000)
      const at = (config: ReturnType<typeof ratio>, estimatedInputTokens: number) =>
        isOverflow({ cfg: config, model: window, tokens: none, estimatedInputTokens })
      expect(at(ratio(0.5), 99_999)).toBe(false)
      expect(at(ratio(0.5), 100_000)).toBe(true)
      expect(at(ratio(undefined), 100_000)).toBe(false)
      expect(at(ratio(undefined), 168_000)).toBe(true)
      expect(at(ratio(0.5, { auto: false }), 150_000)).toBe(false)
      const measuredOnly = { ...none, input: 100_000 }
      expect(isOverflow({ cfg: ratio(0.5), model: window, tokens: measuredOnly })).toBe(true)
      expect(isOverflow({ cfg: ratio(undefined), model: window, tokens: measuredOnly })).toBe(false)
    })
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
