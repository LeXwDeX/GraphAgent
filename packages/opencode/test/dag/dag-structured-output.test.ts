import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ToolBudget } from "@opencode-ai/core/session/tool-budget"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { evaluateCondition, resolveInputMapping } from "@/dag/runtime/eval"
import { registerCaptureSlot, validatePayload, clearCaptureSlot, validateAgainstSchema } from "@/dag/runtime/capture"
import { makeNodeRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

type TrackedEvent = { type: string; nodeID: string; output?: unknown; reason?: string; trigger?: string }

let capturedStore: Map<string, unknown> = new Map()

function makeEventTracker() {
  const events: TrackedEvent[] = []
  capturedStore = new Map()
  const storeStub: Partial<DagStore.Interface> = {
    tryClaimAdoption: () => Effect.succeed(true),
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => ({
        ...makeNodeRow({ id: nodeID, status: "running", childSessionId: "ses_child" }),
        capturedOutput: capturedStore.get(nodeID),
      }))),
    getWorkflow: Effect.fn("s")(() => Effect.succeed({ status: "running" } as never)),
    setCapturedOutput: Effect.fn("s")((_childSessionID: string, payload: unknown) =>
      Effect.sync(() => { capturedStore.set("node-1", payload) })),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeStarted: Effect.fn("s")((_dagID: string, _nodeID: string) => Effect.void),
    nodeCompleted: Effect.fn("s")((_dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID, output }))),
    nodeFailed: Effect.fn("s")((_dagID: string, nodeID: string, reason: string, trigger?: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID, reason, trigger }))),
    nodeSkipped: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID }))),
  })
  return { events, dagLayer }
}

const agentLayer = Layer.mock(Agent.Service, {
  get: () => Effect.succeed({
    name: "build", mode: "all", permission: [], options: {}, description: "", prompt: "",
    model: { providerID: "test" as never, modelID: "test-model" as never },
    tools: {}, hooks: {},
  }),
  list: () => Effect.succeed([]),
  defaultAgent: () => Effect.succeed("build"),
})

const sessionLayer = Layer.mock(Session.Service, {
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: () => Effect.succeed({ id: "ses_child" as never } as never),
  list: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
})

function reply(text: string, finish = "stop", output = 0, reasoning = 0): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(), role: "assistant", parentID: MessageID.ascending(),
      sessionID: "ses_child" as never, mode: "build", agent: "build", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never, providerID: "test" as never,
      time: { created: Date.now() }, finish,
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(result),
  })
}

function makePromptLayerWithCapture(result: SessionV1.WithParts, payloads: unknown[], schema: Record<string, unknown>): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.gen(function* () {
      registerCaptureSlot("ses_child", schema)
      for (const payload of payloads) {
        const r = validatePayload("ses_child", payload)
        if (r.ok) capturedStore.set("node-1", payload)
      }
      return result
    }),
  })
}

function makeSpawnInput(
  outputSchema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
): NodeSpawnInput {
  return {
    dagID: "wf-1", nodeID: "node-1", node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
    outputSchema,
    ...overrides,
  }
}

async function runSpawn(
  dagLayer: Layer.Layer<never>,
  promptLayer: Layer.Layer<never>,
  outputSchema?: Record<string, unknown>,
  overrides: Partial<NodeSpawnInput> = {},
  support: Layer.Layer<never> = Layer.empty,
) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer, support)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput(outputSchema, overrides))
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

// --- Unit tests for eval.ts ---

describe("evaluateCondition", () => {
  it("returns ok:true value:true for empty/undefined condition", () => {
    expect(evaluateCondition(undefined, {})).toEqual({ ok: true, value: true })
    expect(evaluateCondition("", {})).toEqual({ ok: true, value: true })
  })

  it("evaluates numeric comparison with structured output", () => {
    const outputs = { "explore": { output: { findings_count: 5 } } }
    expect(evaluateCondition("explore.output.findings_count > 0", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("explore.output.findings_count > 10", outputs)).toEqual({ ok: true, value: false })
  })

  it("evaluates equality with structured output", () => {
    const outputs = { "check": { output: { status: "ok" } } }
    expect(evaluateCondition('check.output.status == "ok"', outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition('check.output.status == "fail"', outputs)).toEqual({ ok: true, value: false })
  })

  it("fails loudly when a numeric comparison's path is missing (silent skip was the worst failure mode)", () => {
    const result = evaluateCondition("missing.output.field > 0", {})
    expect(result.ok).toBe(false)
  })

  it("equality with a missing path still evaluates (undefined never equals a literal)", () => {
    expect(evaluateCondition("missing.output.field == done", {})).toEqual({ ok: true, value: false })
  })
})

describe("resolveInputMapping", () => {
  it("resolves full output reference", () => {
    const getOutput = (id: string) => (id === "refactor" ? { diff: "abc" } : undefined)
    const result = resolveInputMapping({ diff: "refactor.output" }, getOutput)
    expect(result).toEqual({ diff: { diff: "abc" } })
  })

  it("resolves nested field from output", () => {
    const getOutput = (id: string) => (id === "plan" ? { steps: ["a", "b"] } : undefined)
    const result = resolveInputMapping({ steps: "plan.output.steps" }, getOutput)
    expect(result).toEqual({ steps: ["a", "b"] })
  })

  it("returns empty for undefined mapping", () => {
    expect(resolveInputMapping(undefined, () => null)).toEqual({})
  })

  it("resolves to null for missing node", () => {
    const result = resolveInputMapping({ x: "ghost.output" }, () => null)
    expect(result).toEqual({ x: null })
  })
})

// --- Unit tests for capture.ts (submit_result validation) ---

describe("validateAgainstSchema", () => {
  it("validates patterns against the complete accepted string", () => {
    expect(validateAgainstSchema("a".repeat(99_999) + "!", { pattern: "^a+$" }).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_000), { pattern: "^a+$" }).ok).toBe(true)
    expect(validateAgainstSchema("a".repeat(99_999) + "!", { pattern: "!$" }).ok).toBe(true)
  })

  it("rejects oversize pattern input rather than validating a prefix", () => {
    expect(validateAgainstSchema("a".repeat(100_000) + "!", { pattern: "^a+$" }).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), { pattern: "^a+$" }).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), { type: "string" }).ok).toBe(true)
  })

  it("preserves unanchored JSON Schema pattern matching and malformed-pattern rejection", () => {
    expect(validateAgainstSchema("prefix abc suffix", { pattern: "abc" }).ok).toBe(true)
    expect(validateAgainstSchema("abc", { pattern: "[" }).ok).toBe(false)
  })

  it("accepts matching object type", () => {
    expect(validateAgainstSchema({ a: 1 }, { type: "object" })).toEqual({ ok: true })
  })

  it("rejects wrong type", () => {
    expect(validateAgainstSchema("str", { type: "object" }).ok).toBe(false)
    expect(validateAgainstSchema({}, { type: "array" }).ok).toBe(false)
    expect(validateAgainstSchema(42, { type: "string" }).ok).toBe(false)
  })

  it("enforces required fields", () => {
    const schema = { type: "object" as const, required: ["name", "count"] }
    expect(validateAgainstSchema({ name: "x" }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ name: "x", count: 1 }, schema).ok).toBe(true)
  })

  it("requires own JSON properties even for Object.prototype names", () => {
    for (const field of ["constructor", "toString", "__proto__"]) {
      expect(validateAgainstSchema({}, { type: "object", required: [field] }).ok).toBe(false)
      const payload = JSON.parse(`{"${field}":"present"}`)
      expect(validateAgainstSchema(payload, { type: "object", required: [field] }).ok).toBe(true)
    }
  })

  it("validates only present own properties and rejects undeclared prototype names", () => {
    for (const field of ["constructor", "toString", "__proto__"]) {
      const properties = JSON.parse(`{"${field}":{"type":"string"}}`)
      const schema = { type: "object", properties, additionalProperties: false }
      expect(validateAgainstSchema({}, schema).ok).toBe(true)
      expect(validateAgainstSchema(JSON.parse(`{"${field}":"valid"}`), schema).ok).toBe(true)
      expect(validateAgainstSchema(JSON.parse(`{"${field}":1}`), schema).ok).toBe(false)
      expect(validateAgainstSchema(JSON.parse(`{"${field}":"extra"}`), {
        type: "object", properties: {}, additionalProperties: false,
      }).ok).toBe(false)
    }
  })

  it("matches the complete string at the regex length boundary and rejects longer values", () => {
    const schema = { type: "string", pattern: "^a+$" }
    expect(validateAgainstSchema("a".repeat(99_999), schema).ok).toBe(true)
    expect(validateAgainstSchema("a".repeat(100_000), schema).ok).toBe(true)
    expect(validateAgainstSchema("a".repeat(99_999) + "!", schema).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), schema).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_000) + "!", schema).ok).toBe(false)
    expect(validateAgainstSchema("a".repeat(100_001), { type: "string" }).ok).toBe(true)
  })

  it("validates nested properties recursively", () => {
    const schema = {
      type: "object" as const,
      properties: {
        meta: { type: "object" as const, required: ["id"] },
      },
    }
    expect(validateAgainstSchema({ meta: {} }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ meta: { id: "abc" } }, schema).ok).toBe(true)
  })

  it("validates array items", () => {
    const schema = { type: "array" as const, items: { type: "number" as const } }
    expect(validateAgainstSchema([1, 2, 3], schema).ok).toBe(true)
    expect(validateAgainstSchema([1, "x"], schema).ok).toBe(false)
  })

  it("validates integer type", () => {
    expect(validateAgainstSchema(5, { type: "integer" }).ok).toBe(true)
    expect(validateAgainstSchema(5.5, { type: "integer" }).ok).toBe(false)
    expect(validateAgainstSchema("5", { type: "integer" }).ok).toBe(false)
  })

  it("rejects values outside enum and accepts members", () => {
    const schema = { type: "string", enum: ["ACCEPT", "REJECT"] }
    expect(validateAgainstSchema("ACCEPT", schema).ok).toBe(true)
    expect(validateAgainstSchema("REJECT", schema).ok).toBe(true)
    const bad = validateAgainstSchema("MAYBE", schema)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error).toContain("ACCEPT")
      expect(bad.error).toContain("MAYBE")
    }
  })

  it("enum comparison is case-sensitive", () => {
    expect(validateAgainstSchema("accept", { enum: ["ACCEPT"] }).ok).toBe(false)
  })

  it("validates mixed-type enum values", () => {
    const schema = { enum: [1, "one", true, null] }
    expect(validateAgainstSchema(1, schema).ok).toBe(true)
    expect(validateAgainstSchema("one", schema).ok).toBe(true)
    expect(validateAgainstSchema(true, schema).ok).toBe(true)
    expect(validateAgainstSchema(null, schema).ok).toBe(true)
    expect(validateAgainstSchema(2, schema).ok).toBe(false)
    expect(validateAgainstSchema(false, schema).ok).toBe(false)
  })

  it("validates bare enum without type", () => {
    expect(validateAgainstSchema("x", { enum: ["x", "y"] }).ok).toBe(true)
    expect(validateAgainstSchema("z", { enum: ["x", "y"] }).ok).toBe(false)
  })

  it("validates const with structural deep equality (key order irrelevant)", () => {
    expect(validateAgainstSchema("fixed", { const: "fixed" }).ok).toBe(true)
    expect(validateAgainstSchema("other", { const: "fixed" }).ok).toBe(false)
    const schema = { const: { a: 1, b: { c: [1, 2] } } }
    expect(validateAgainstSchema({ b: { c: [1, 2] }, a: 1 }, schema).ok).toBe(true)
    expect(validateAgainstSchema({ a: 1, b: { c: [2, 1] } }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ a: 1 }, schema).ok).toBe(false)
  })

  it("validates enum nested inside properties and items", () => {
    const schema = {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["ACCEPT", "REJECT"] },
        tags: { type: "array", items: { enum: ["a", "b"] } },
      },
    }
    expect(validateAgainstSchema({ verdict: "ACCEPT", tags: ["a", "b"] }, schema).ok).toBe(true)
    const badField = validateAgainstSchema({ verdict: "MAYBE" }, schema)
    expect(badField.ok).toBe(false)
    if (!badField.ok) expect(badField.error).toContain('field "verdict"')
    const badItem = validateAgainstSchema({ tags: ["a", "c"] }, schema)
    expect(badItem.ok).toBe(false)
    if (!badItem.ok) expect(badItem.error).toContain("item[1]")
  })

  it("reports type mismatch before enum membership", () => {
    const result = validateAgainstSchema(1, { type: "string", enum: ["a"] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('expected type "string"')
  })
})

describe("validatePayload", () => {
  it("rejects when no schema registered", () => {
    clearCaptureSlot("nonexistent")
    const result = validatePayload("nonexistent", {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.notAvailable).toBe(true)
  })
})

// --- Integration tests for submit_result structured output ---

describe("spawnNode submit_result capture", () => {
  const modelInfo = {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    api: { id: "test-model", url: "", npm: "@ai-sdk/openai-compatible" },
    name: "Test",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 384_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } satisfies Provider.Model
  const outputSupport = Layer.mergeAll(
    Layer.mock(Provider.Service, { getModel: () => Effect.succeed(modelInfo) }),
    Layer.mock(Config.Service, {
      get: () =>
        Effect.succeed({
          provider: { test: { models: { "test-model": { limit: { context: 128_000, output: 384_000 } } } } },
        } as ConfigV1.Info),
    }),
    RuntimeFlags.layer({}),
  )

  function makeSequencePromptLayer(
    steps: Array<{ result: SessionV1.WithParts; submit?: unknown }>,
    seen: Array<{ sessionID: string; text: string }>,
    strict = false,
  ) {
    let index = 0
    return Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.gen(function* () {
          if (strict && index >= steps.length) return yield* Effect.die(new Error("unexpected extra prompt"))
          const step = steps[Math.min(index++, steps.length - 1)]
          seen.push({
            sessionID: input.sessionID,
            text: input.parts
              .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join(""),
          })
          if (step.submit !== undefined) {
            const result = validatePayload("ses_child", step.submit)
            if (result.ok) capturedStore.set("node-1", step.submit)
          }
          return step.result
        }),
    })
  }

  for (const max of [1, 2]) {
    it(`missing-output nudge retains the child budget with ${max} tool slot(s)`, async () => {
      const { events, dagLayer } = makeEventTracker()
      const schema = { type: "object", required: ["status"] }
      let budget = ToolBudget.create(max)
      let prompts = 0
      let executions = 0
      const promptLayer = Layer.mock(SessionPrompt.Service, {
        prompt: (_input, options) => Effect.sync(() => {
          if (!options?.continueToolBudget) budget = ToolBudget.create(max)
          prompts += 1
          // Initial work consumes one slot without submitting. Only the nudge
          // can submit, and only if the original budget still has a slot.
          if (budget.tryReserve()) {
            executions += 1
            if (prompts > 1) capturedStore.set("node-1", { status: "ok" })
          }
          return reply("work completed")
        }),
      })
      await runSpawn(dagLayer, promptLayer, schema)
      expect(prompts).toBe(2)
      expect(executions).toBe(max)
      expect(events.some((event) => event.type === "nodeCompleted")).toBe(max === 2)
      expect(events.some((event) => event.type === "nodeFailed" && event.trigger === "verdict_fail")).toBe(max === 1)
    })
  }

  it("(a) valid payload via submit_result → nodeCompleted with captured payload", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object", required: ["tests_passed", "diff"] }
    const payload = { tests_passed: 10, diff: "abc" }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("ignored text"), [payload], schema),
      schema,
    )
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual(payload)
  })

  it("(b) invalid payload then valid retry → nodeCompleted with valid payload", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object", required: ["status"] }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("text"), [{ wrong: "field" }, { status: "ok" }], schema),
      schema,
    )
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual({ status: "ok" })
  })

  it("(b2) enum-invalid verdict then valid retry → nodeCompleted with valid payload", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string", enum: ["ACCEPT", "REJECT"] } },
    }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("text"), [{ verdict: "MAYBE" }, { verdict: "ACCEPT" }], schema),
      schema,
    )
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual({ verdict: "ACCEPT" })
  })

  it("(c) schema declared, no submit_result call → nodeFailed with verdict_fail", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object" }
    registerCaptureSlot("ses_child", schema)
    await runSpawn(dagLayer, makePromptLayer(reply("some text")), schema)
    const failed = events.find((e) => e.type === "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("submit_result")
    expect(failed!.trigger).toBe("verdict_fail")
  })

  it("(d) no schema → last text part as output", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed")))
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed")
  })

  it("(e) a length-limited submit_result turn continues once in the same session and completes", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = { type: "object", required: ["status"] }
    const seen: Array<{ sessionID: string; text: string }> = []
    const promptLayer = makeSequencePromptLayer(
      [{ result: reply("", "length", 885, 31_115) }, { result: reply("done"), submit: { status: "ok" } }],
      seen,
    )
    await runSpawn(dagLayer, promptLayer, schema, {}, outputSupport)
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual({ status: "ok" })
    expect(seen).toHaveLength(2)
    expect(seen.every((entry) => entry.sessionID === "ses_child")).toBe(true)
    expect(seen[1]?.text).toContain("output token limit")
    expect(seen[1]?.text).toContain("submit_result")
  })

  it("(f) a continuation that still ends in length fails with the cap and reasoning/text split", async () => {
    const { events, dagLayer } = makeEventTracker()
    const seen: Array<{ sessionID: string; text: string }> = []
    const promptLayer = makeSequencePromptLayer(
      [{ result: reply("", "length", 885, 31_115) }, { result: reply("", "length", 885, 31_115) }],
      seen,
    )
    await runSpawn(dagLayer, promptLayer, { type: "object" }, {}, outputSupport)
    const failed = events.find((event) => event.type === "nodeFailed")
    expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
    expect(failed?.trigger).toBe("verdict_fail")
    expect(failed?.reason).toContain("output token cap (384000; reasoning 31115, text 885)")
    expect(failed?.reason).toContain("limit.output")
    expect(seen).toHaveLength(2)
  })

  for (const resultProtocol of ["submit_result", undefined] as const) {
    it(`(g) a captured submit_result wins over finish=length without another prompt (${resultProtocol ?? "historical"})`, async () => {
      const { events, dagLayer } = makeEventTracker()
      const seen: Array<{ sessionID: string; text: string }> = []
      const promptLayer = makeSequencePromptLayer(
        [{ result: reply("", "length", 885, 31_115), submit: { status: "ok" } }],
        seen,
        true,
      )
      await runSpawn(
        dagLayer,
        promptLayer,
        { type: "object", required: ["status"] },
        resultProtocol ? { resultProtocol } : {},
        outputSupport,
      )
      expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual({ status: "ok" })
      expect(events.find((event) => event.type === "nodeFailed")).toBeUndefined()
      expect(seen).toHaveLength(1)
    })
  }

  it("(j) a captured-but-invalid submit_result fails without a length continuation", async () => {
    const { events, dagLayer } = makeEventTracker()
    const seen: Array<{ sessionID: string; text: string }> = []
    const promptLayer = makeSequencePromptLayer(
      [{ result: reply("", "length", 885, 31_115), submit: { status: "ok" } }],
      seen,
      true,
    )
    await runSpawn(
      dagLayer,
      promptLayer,
      { type: "object", required: ["status"] },
      { resultProtocol: "submit_result", reviewImplementationFingerprint: "expected" },
      outputSupport,
    )
    const failed = events.find((event) => event.type === "nodeFailed")
    expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
    expect(failed?.trigger).toBe("verdict_fail")
    expect(failed?.reason).toContain("Review result contract failed")
    expect(seen).toHaveLength(1)
  })

  it("(k) a length continuation that captures an invalid review contract keeps the contract reason", async () => {
    const { events, dagLayer } = makeEventTracker()
    const seen: Array<{ sessionID: string; text: string }> = []
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["ACCEPT", "REJECT"] },
        implementation_fingerprint: { type: "string" },
      },
      required: ["verdict", "implementation_fingerprint"],
    }
    const promptLayer = makeSequencePromptLayer(
      [
        { result: reply("", "length", 885, 31_115) },
        {
          result: reply("", "length", 885, 31_115),
          submit: { verdict: "ACCEPT", implementation_fingerprint: "sha256:revision-1" },
        },
      ],
      seen,
      true,
    )
    await runSpawn(
      dagLayer,
      promptLayer,
      schema,
      { resultProtocol: "submit_result", reviewImplementationFingerprint: "sha256:revision-2" },
      outputSupport,
    )
    const failed = events.find((event) => event.type === "nodeFailed")
    expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
    expect(failed?.trigger).toBe("verdict_fail")
    expect(failed?.reason).toBe(
      "Review result contract failed: review result fingerprint sha256:revision-1 does not match current implementation sha256:revision-2",
    )
    expect(seen).toHaveLength(2)
  })

  it("(h) a plaintext turn without an output_schema continues once after length", async () => {
    const { events, dagLayer } = makeEventTracker()
    const seen: Array<{ sessionID: string; text: string }> = []
    const promptLayer = makeSequencePromptLayer(
      [{ result: reply("", "length", 885, 31_115) }, { result: reply("final answer") }],
      seen,
      true,
    )
    await runSpawn(dagLayer, promptLayer, undefined, {}, outputSupport)
    expect(events.find((event) => event.type === "nodeCompleted")?.output).toBe("final answer")
    expect(events.find((event) => event.type === "nodeFailed")).toBeUndefined()
    expect(seen).toHaveLength(2)
    expect(seen.every((entry) => entry.sessionID === "ses_child")).toBe(true)
    expect(seen[1]?.text).toContain("output token limit")
  })

  it("(i) a plaintext continuation that still ends in length fails once with the cap", async () => {
    const { events, dagLayer } = makeEventTracker()
    const seen: Array<{ sessionID: string; text: string }> = []
    const promptLayer = makeSequencePromptLayer(
      [{ result: reply("", "length", 885, 31_115) }, { result: reply("", "length", 885, 31_115) }],
      seen,
      true,
    )
    await runSpawn(dagLayer, promptLayer, undefined, {}, outputSupport)
    const failed = events.find((event) => event.type === "nodeFailed")
    expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
    expect(failed?.trigger).toBe("verdict_fail")
    expect(failed?.reason).toContain("after one continuation")
    expect(seen).toHaveLength(2)
  })

  it("fails a diff review whose result targets a stale implementation fingerprint", async () => {
    const { events, dagLayer } = makeEventTracker()
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["ACCEPT", "REJECT"] },
        implementation_fingerprint: { type: "string" },
      },
      required: ["verdict", "implementation_fingerprint"],
    }
    await runSpawn(
      dagLayer,
      makePromptLayerWithCapture(reply("ignored text"), [{
        verdict: "ACCEPT",
        implementation_fingerprint: "sha256:revision-1",
      }], schema),
      schema,
      { reviewImplementationFingerprint: "sha256:revision-2" },
    )

    expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
    expect(events.find((event) => event.type === "nodeFailed")).toEqual({
      type: "nodeFailed",
      nodeID: "node-1",
      reason: "Review result contract failed: review result fingerprint sha256:revision-1 does not match current implementation sha256:revision-2",
      trigger: "verdict_fail",
    })
  })

  describe("ACCEPT consistency", () => {
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["ACCEPT", "REJECT"] },
        required_actions: { type: "array" },
        refuted: { type: "array" },
      },
      required: ["verdict", "required_actions"],
    }
    const lane = { nodeID: "decision--standards", output: { verdict: "REJECT", required_actions: ["Add a test"] } }

    it("fails an ACCEPT that ignores a lane's required action", async () => {
      const { events, dagLayer } = makeEventTracker()
      await runSpawn(
        dagLayer,
        makePromptLayerWithCapture(reply("ignored"), [{ verdict: "ACCEPT", required_actions: [] }], schema),
        schema,
        { verdictEvidence: [lane] },
      )
      expect(events.find((event) => event.type === "nodeCompleted")).toBeUndefined()
      expect(events.find((event) => event.type === "nodeFailed")).toEqual({
        type: "nodeFailed",
        nodeID: "node-1",
        reason:
          "Verdict consistency contract failed: ACCEPT leaves required actions unrefuted: decision--standards[0]; refute each as { node, index, reason } or submit REJECT",
        trigger: "verdict_fail",
      })
    })

    it("completes an ACCEPT that refutes every lane action", async () => {
      const { events, dagLayer } = makeEventTracker()
      const accepted = {
        verdict: "ACCEPT",
        required_actions: [],
        refuted: [{ node: "decision--standards", index: 0, reason: "The test exists at src/a.test.ts:4" }],
      }
      await runSpawn(dagLayer, makePromptLayerWithCapture(reply("ignored"), [accepted], schema), schema, {
        verdictEvidence: [lane],
      })
      expect(events.find((event) => event.type === "nodeFailed")).toBeUndefined()
      expect(events.find((event) => event.type === "nodeCompleted")?.output).toEqual(accepted)
    })
  })
})
