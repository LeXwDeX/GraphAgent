import { describe, expect, test } from "bun:test"
import {
  ContextFoldingPolicy,
  estimateContextFoldingBudget,
  fingerprintContextFoldingRequest,
  normalizeParameters,
  planContextFolding,
  projectContextFoldingRequest,
  type ContextFoldingProjectionInput,
  type BudgetSkipReason,
  type FoldCandidate,
  type FoldPlan,
  type FoldRef,
  type FoldStep,
  type PreparedRequestBudgetInput,
  type WireProjectionSnapshot,
} from "../../src/session/context-folding"
import { Token } from "../../src/util/token"

const ref = (id: string): FoldRef => ({ messageID: `message-${id}`, partID: `part-${id}`, callID: `call-${id}` })

const duplicatePlan = (source: FoldRef, witness: FoldRef): FoldPlan => ({
  replacements: [{ source, witness }],
  protectedStepIDs: [],
  exclusions: [],
  skipReason: undefined,
})

const emptyDuplicatePlan: FoldPlan = {
  replacements: [],
  protectedStepIDs: [],
  exclusions: [],
  skipReason: "no-eligible-duplicates",
}

const budgetInput = (
  messages: unknown,
  overrides: Partial<PreparedRequestBudgetInput> = {},
): PreparedRequestBudgetInput => ({
  contextLimit: 1_000,
  inputLimit: { kind: "absent" },
  outputReserve: 100,
  system: { kind: "none" },
  messages,
  tools: [],
  protocolOverheadTokens: 0,
  media: "none",
  ...overrides,
})

const requestFingerprint = (request: unknown, identity: unknown, budget: PreparedRequestBudgetInput) => {
  const fingerprint = fingerprintContextFoldingRequest({ request, identity, budget })
  if (!fingerprint.ok) throw new Error(`request fingerprint failed: ${fingerprint.reason}`)
  return fingerprint.value
}

const withCurrentFingerprint = <Request>(
  input: ContextFoldingProjectionInput<Request>,
): ContextFoldingProjectionInput<Request> => {
  const fingerprint = requestFingerprint(input.request, input.identity, input.budget)
  return {
    ...input,
    expectedRequestFingerprint: fingerprint,
    mapping: { ...input.mapping, requestFingerprint: fingerprint },
  }
}

type WireRequest = {
  messages: Array<{ role: string; callID: string; body?: string; nested?: { mutable: string } }>
  metadata: { mutable: string }
}

const projectionFixture = (body: string, sourceCallID = "visible-source", witnessCallID = "visible-witness") => {
  const source = ref("source")
  const witness = ref("witness")
  const request: WireRequest = {
    messages: [
      { role: "assistant", callID: sourceCallID },
      { role: "tool", callID: sourceCallID, body },
      { role: "assistant", callID: witnessCallID },
      { role: "tool", callID: witnessCallID, body },
    ],
    metadata: { mutable: "original" },
  }
  const identity = { model: "test-model", runtime: "test-runtime" }
  const budget = budgetInput(request.messages)
  const fingerprint = requestFingerprint(request, identity, budget)
  const mapping: WireProjectionSnapshot = {
    requestFingerprint: fingerprint,
    calls: [
      { ref: source, visibleCallID: sourceCallID, visibleCallIDPath: ["messages", 0, "callID"], ordinal: 0 },
      { ref: witness, visibleCallID: witnessCallID, visibleCallIDPath: ["messages", 2, "callID"], ordinal: 1 },
    ],
    results: [
      {
        ref: source,
        visibleCallID: sourceCallID,
        visibleCallIDPath: ["messages", 1, "callID"],
        ordinal: 0,
        bodyPath: ["messages", 1, "body"],
        complete: true,
      },
      {
        ref: witness,
        visibleCallID: witnessCallID,
        visibleCallIDPath: ["messages", 3, "callID"],
        ordinal: 1,
        bodyPath: ["messages", 3, "body"],
        complete: true,
      },
    ],
  }
  const input: ContextFoldingProjectionInput<WireRequest> = {
    request,
    identity,
    expectedRequestFingerprint: fingerprint,
    duplicatePlan: duplicatePlan(source, witness),
    budget,
    mapping,
  }
  return { input, source, witness }
}

const expectedPlaceholder = (callID: string) =>
  `[Duplicate tool output folded. Identical full output is retained in later tool call ${JSON.stringify(callID)}.]`

const bodyForSavings = (savings: number, callID = "visible-witness") => {
  const placeholderTokens = Token.estimate(JSON.stringify(expectedPlaceholder(callID)))
  for (let length = Math.max(0, (savings + placeholderTokens) * 4 - 16); length < 20_000; length++) {
    const body = "x".repeat(length)
    if (Token.estimate(JSON.stringify(body)) - placeholderTokens === savings) return body
  }
  throw new Error(`could not build body for ${savings} tokens of savings`)
}

const deepFreeze = (value: unknown, seen = new Set<object>()): void => {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  Object.freeze(value)
}

describe("context folding budget", () => {
  test("computes U=min(I,C-O), T=floor(U*0.7), and counts each actual system location once", () => {
    const system = "system".repeat(600)
    const inMessages = estimateContextFoldingBudget(
      budgetInput([{ role: "system", content: system }], {
        contextLimit: 10_000,
        inputLimit: { kind: "value", value: 8_000 },
        outputReserve: 1_000,
        system: { kind: "messages" },
      }),
    )
    const inInstructions = estimateContextFoldingBudget(
      budgetInput([], {
        contextLimit: 10_000,
        inputLimit: { kind: "value", value: 8_000 },
        outputReserve: 1_000,
        system: { kind: "instructions", value: system },
      }),
    )
    const noSystem = estimateContextFoldingBudget(
      budgetInput([], {
        contextLimit: 10_000,
        inputLimit: { kind: "value", value: 8_000 },
        outputReserve: 1_000,
      }),
    )

    expect(inMessages).toMatchObject({ usableInputTokens: 8_000, targetTokens: 5_600 })
    expect(inInstructions).toMatchObject({ usableInputTokens: 8_000, targetTokens: 5_600 })
    expect(inMessages.estimatedInputTokens!).toBeGreaterThan(noSystem.estimatedInputTokens!)
    expect(inInstructions.estimatedInputTokens!).toBeGreaterThan(noSystem.estimatedInputTokens!)

    const largeUsableInput = 2_847_580_569_751_480
    expect(
      estimateContextFoldingBudget(budgetInput([], { contextLimit: largeUsableInput + 1, outputReserve: 1 }))
        .targetTokens,
    ).toBe(1_993_306_398_826_036)
  })

  test("plans only above the soft target, not below or equal", () => {
    const baseInput = budgetInput([], { contextLimit: 100_000, outputReserve: 10_000 })
    const base = estimateContextFoldingBudget(baseInput)
    expect(base.estimatedInputTokens).toBeDefined()
    const target = base.targetTokens!
    const equal = estimateContextFoldingBudget({
      ...baseInput,
      protocolOverheadTokens: target - base.estimatedInputTokens!,
    })
    const above = estimateContextFoldingBudget({
      ...baseInput,
      protocolOverheadTokens: target - base.estimatedInputTokens! + 1,
    })

    expect(equal).toMatchObject({ estimatedInputTokens: target, overBudget: false, skipReason: "below-target" })
    expect(above).toMatchObject({ estimatedInputTokens: target + 1, overBudget: true, skipReason: undefined })
  })

  test("fails closed for explicit invalid limits, unknown output reserve, media, and unserializable tools", () => {
    const cases: Array<[Partial<PreparedRequestBudgetInput>, BudgetSkipReason]> = [
      [{ contextLimit: 0 }, "invalid-context-limit"],
      [{ inputLimit: { kind: "value", value: Number.NaN } }, "invalid-input-limit"],
      [{ outputReserve: undefined }, "invalid-output-reserve"],
      [{ outputReserve: 1_000 }, "invalid-output-reserve"],
      [{ protocolOverheadTokens: -1 }, "invalid-protocol-overhead"],
      [{ media: "unknown" }, "unknown-media"],
      [{ system: { kind: "unknown" } }, "unknown-system"],
      [{ tools: [{ execute: () => undefined }] }, "unknown-content"],
    ]
    for (const [overrides, reason] of cases) {
      expect(estimateContextFoldingBudget(budgetInput([], overrides)).skipReason).toBe(reason)
    }
  })

  test("re-estimates current messages and tool schemas", () => {
    const base = estimateContextFoldingBudget(budgetInput([{ role: "user", content: "hello" }]))
    const changedMessages = estimateContextFoldingBudget(budgetInput([{ role: "user", content: "hello".repeat(500) }]))
    const changedTools = estimateContextFoldingBudget(
      budgetInput([{ role: "user", content: "hello" }], {
        tools: [{ name: "read", description: "d".repeat(2_000), schema: { type: "object" } }],
      }),
    )
    expect(changedMessages.estimatedInputTokens!).toBeGreaterThan(base.estimatedInputTokens!)
    expect(changedTools.estimatedInputTokens!).toBeGreaterThan(base.estimatedInputTokens!)
  })
})

describe("context folding projection", () => {
  test("U15 keeps an over-budget request with only unique content unchanged", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const result = projectContextFoldingRequest({ ...input, duplicatePlan: emptyDuplicatePlan })
    expect(result.request).toBe(input.request)
    expect(result).toMatchObject({ applied: false, plan: { overBudget: true, skipReason: "no-eligible-duplicates" } })
  })

  test("U16 includes placeholder/reference cost at the 511/512/513 token boundary", () => {
    for (const savings of [511, 512, 513]) {
      const { input } = projectionFixture(bodyForSavings(savings))
      const result = projectContextFoldingRequest(input)
      expect(result.applied).toBe(savings >= 512)
      expect(result.plan.skipReason).toBe(savings >= 512 ? undefined : "insufficient-savings")
      if (result.applied) expect(result.plan.replacements[0].estimatedSavings).toBe(savings)
    }
  })

  test("selects old sources in order, stops at target, and can remain over budget after exhaustion", () => {
    const firstBody = bodyForSavings(700, "visible-witness-a")
    const secondBody = bodyForSavings(700, "visible-witness-b")
    const refs = [ref("source-a"), ref("witness-a"), ref("source-b"), ref("witness-b")]
    const visible = ["visible-source-a", "visible-witness-a", "visible-source-b", "visible-witness-b"]
    const request = {
      messages: refs.flatMap((_, index) => [
        { role: "assistant", callID: visible[index] },
        { role: "tool", callID: visible[index], body: index < 2 ? firstBody : secondBody },
      ]),
      metadata: { mutable: "original" },
    }
    const identity = { model: "test", runtime: "test-runtime" }
    const duplicate: FoldPlan = {
      replacements: [
        { source: refs[0], witness: refs[1] },
        { source: refs[2], witness: refs[3] },
      ],
      protectedStepIDs: [],
      exclusions: [],
      skipReason: undefined,
    }
    const baseBudget = estimateContextFoldingBudget(
      budgetInput(request.messages, { contextLimit: 100_000, outputReserve: 1_000 }),
    )
    const desiredTarget = baseBudget.estimatedInputTokens! - 699
    const usable = Math.ceil(desiredTarget / ContextFoldingPolicy.softTargetRatio)
    const inputForBudget = (budget: PreparedRequestBudgetInput) => {
      const fingerprint = requestFingerprint(request, identity, budget)
      return {
        request,
        identity,
        expectedRequestFingerprint: fingerprint,
        duplicatePlan: duplicate,
        budget,
        mapping: {
          requestFingerprint: fingerprint,
          calls: refs.map((item, ordinal) => ({
            ref: item,
            visibleCallID: visible[ordinal],
            visibleCallIDPath: ["messages", ordinal * 2, "callID"] as const,
            ordinal,
          })),
          results: refs.map((item, ordinal) => ({
            ref: item,
            visibleCallID: visible[ordinal],
            visibleCallIDPath: ["messages", ordinal * 2 + 1, "callID"] as const,
            ordinal,
            bodyPath: ["messages", ordinal * 2 + 1, "body"] as const,
            complete: true,
          })),
        },
      }
    }
    const stopsAfterOne = projectContextFoldingRequest(
      inputForBudget(budgetInput(request.messages, { contextLimit: usable + 100, outputReserve: 100 })),
    )
    expect(stopsAfterOne.plan.replacements).toHaveLength(1)
    expect(stopsAfterOne.plan.overBudget).toBe(false)

    const exhausted = projectContextFoldingRequest(
      inputForBudget(
        budgetInput(request.messages, { contextLimit: 1_000, outputReserve: 100, protocolOverheadTokens: 5_000 }),
      ),
    )
    expect(exhausted.plan.replacements).toHaveLength(2)
    expect(exhausted.plan.overBudget).toBe(true)
  })

  test("folds older-task duplicates before current-task duplicates when only one fits the target", () => {
    const firstBody = bodyForSavings(700, "visible-witness-a")
    const secondBody = bodyForSavings(700, "visible-witness-b")
    const refs = [ref("source-a"), ref("witness-a"), ref("source-b"), ref("witness-b")]
    const visible = ["visible-source-a", "visible-witness-a", "visible-source-b", "visible-witness-b"]
    const request = {
      messages: refs.flatMap((_, index) => [
        { role: "assistant", callID: visible[index] },
        { role: "tool", callID: visible[index], body: index < 2 ? firstBody : secondBody },
      ]),
      metadata: { mutable: "original" },
    }
    const identity = { model: "test", runtime: "test-runtime" }
    // The current-task duplicate comes first by source order, but only the older-task source should be compressed.
    const duplicate: FoldPlan = {
      replacements: [
        { source: refs[0], witness: refs[1], anchor: true },
        { source: refs[2], witness: refs[3], anchor: false },
      ],
      protectedStepIDs: [],
      exclusions: [],
      skipReason: undefined,
    }
    const baseBudget = estimateContextFoldingBudget(
      budgetInput(request.messages, { contextLimit: 100_000, outputReserve: 1_000 }),
    )
    const desiredTarget = baseBudget.estimatedInputTokens! - 699
    const usable = Math.ceil(desiredTarget / ContextFoldingPolicy.softTargetRatio)
    const inputForBudget = (budget: PreparedRequestBudgetInput) => {
      const fingerprint = requestFingerprint(request, identity, budget)
      return {
        request,
        identity,
        expectedRequestFingerprint: fingerprint,
        duplicatePlan: duplicate,
        budget,
        mapping: {
          requestFingerprint: fingerprint,
          calls: refs.map((item, ordinal) => ({
            ref: item,
            visibleCallID: visible[ordinal],
            visibleCallIDPath: ["messages", ordinal * 2, "callID"] as const,
            ordinal,
          })),
          results: refs.map((item, ordinal) => ({
            ref: item,
            visibleCallID: visible[ordinal],
            visibleCallIDPath: ["messages", ordinal * 2 + 1, "callID"] as const,
            ordinal,
            bodyPath: ["messages", ordinal * 2 + 1, "body"] as const,
            complete: true,
          })),
        },
      }
    }

    const one = projectContextFoldingRequest(
      inputForBudget(budgetInput(request.messages, { contextLimit: usable + 100, outputReserve: 100 })),
    )
    expect(one.plan.replacements.map((replacement) => replacement.source)).toEqual([refs[2]])
    expect(one.request.messages[1].body).toBe(firstBody)
    expect(one.request.messages[5].body).toBe(expectedPlaceholder("visible-witness-b"))

    const both = projectContextFoldingRequest(
      inputForBudget(
        budgetInput(request.messages, { contextLimit: 1_000, outputReserve: 100, protocolOverheadTokens: 5_000 }),
      ),
    )
    expect(both.plan.replacements.map((replacement) => replacement.source)).toEqual([refs[0], refs[2]])
  })

  test("escapes a bounded final wire call ID and rejects overlong or colliding IDs", () => {
    const unusual = 'visible-"witness\\line\nnext'
    const { input } = projectionFixture(bodyForSavings(600, unusual), "visible-source", unusual)
    const applied = projectContextFoldingRequest(input)
    expect(applied.applied).toBe(true)
    expect(applied.request.messages[1].body).toBe(expectedPlaceholder(unusual))

    const long = "x".repeat(ContextFoldingPolicy.maximumVisibleCallIDBytes + 1)
    const longFixture = projectionFixture(bodyForSavings(600, long), "visible-source", long)
    expect(projectContextFoldingRequest(longFixture.input)).toMatchObject({
      applied: false,
      plan: { skipReason: "invalid-reference" },
    })

    const collision = projectionFixture(bodyForSavings(600), "same-id", "same-id")
    expect(projectContextFoldingRequest(collision.input)).toMatchObject({
      applied: false,
      plan: { skipReason: "mapping-mismatch" },
    })
  })

  test("rejects missing, truncated, stale, reordered, or body-mismatched witness mappings", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const malformedCompleteness = input.mapping.results.map((item) => ({ ...item }))
    Reflect.set(malformedCompleteness[1], "complete", "yes")
    const variants: ContextFoldingProjectionInput<WireRequest>[] = [
      { ...input, mapping: { ...input.mapping, results: input.mapping.results.slice(0, 1) } },
      {
        ...input,
        mapping: {
          ...input.mapping,
          results: input.mapping.results.map((item, index) => (index === 1 ? { ...item, complete: false } : item)),
        },
      },
      {
        ...input,
        mapping: {
          ...input.mapping,
          results: input.mapping.results.map((item, index) => (index === 0 ? { ...item, ordinal: 2 } : item)),
        },
      },
      {
        ...input,
        mapping: {
          ...input.mapping,
          calls: input.mapping.calls.map((item, index) => (index === 1 ? { ...item, ordinal: 0 } : item)),
        },
      },
      { ...input, mapping: { ...input.mapping, results: malformedCompleteness } },
      {
        ...input,
        request: {
          ...input.request,
          messages: input.request.messages.map((item, index) => (index === 3 ? { ...item, body: "changed" } : item)),
        },
      },
    ]
    for (const variant of variants) {
      const result = projectContextFoldingRequest(variant)
      expect(result.request).toBe(variant.request)
      expect(result.applied).toBe(false)
    }

    const changedIdentity = { model: "changed-model", runtime: "test-runtime", request: input.request, tools: [] }
    expect(projectContextFoldingRequest({ ...input, identity: changedIdentity })).toMatchObject({
      applied: false,
      plan: { skipReason: "stale-request" },
    })
  })

  test("binds the captured fingerprint to the actual request, identity, budget, and final wire IDs", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const changedCallID = structuredClone(input.request)
    changedCallID.messages[2].callID = "changed-final-id"
    const changedInput = structuredClone(input.request)
    changedInput.messages[1].nested = { mutable: "changed-input" }
    const changedMetadata = structuredClone(input.request)
    changedMetadata.metadata.mutable = "changed-metadata"

    const staleVariants: ContextFoldingProjectionInput<WireRequest>[] = [
      { ...input, request: changedCallID, budget: { ...input.budget, messages: changedCallID.messages } },
      { ...input, request: changedInput, budget: { ...input.budget, messages: changedInput.messages } },
      { ...input, request: changedMetadata, budget: { ...input.budget, messages: changedMetadata.messages } },
      { ...input, identity: { model: "changed-model", runtime: "test-runtime" } },
      { ...input, budget: { ...input.budget, tools: [{ name: "read", schema: { type: "object" } }] } },
      { ...input, budget: { ...input.budget, outputReserve: 101 } },
    ]
    for (const variant of staleVariants) {
      const result = projectContextFoldingRequest(variant)
      expect(result.request).toBe(variant.request)
      expect(result).toMatchObject({ applied: false, plan: { skipReason: "stale-request" } })
    }

    const currentRequest = structuredClone(input.request)
    currentRequest.messages[2].callID = "changed-final-id"
    currentRequest.messages[3].callID = "changed-final-id"
    const current = withCurrentFingerprint({
      ...input,
      request: currentRequest,
      budget: { ...input.budget, messages: currentRequest.messages },
    })
    expect(projectContextFoldingRequest(current)).toMatchObject({
      applied: false,
      plan: { skipReason: "mapping-mismatch" },
    })
  })

  test("applies to a fully independent copy, accepts frozen inputs, and never mutates the source", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const original = JSON.stringify(input.request)
    deepFreeze(input)
    const result = projectContextFoldingRequest(input)
    expect(result.applied).toBe(true)
    expect(JSON.stringify(input.request)).toBe(original)
    expect(result.request).not.toBe(input.request)
    result.request.metadata.mutable = "projected-only"
    expect(input.request.metadata.mutable).toBe("original")
  })

  test("preserves own __proto__, constructor, prototype, and null-prototype objects", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const special: unknown = JSON.parse(
      '{"__proto__":{"hidden":"value"},"constructor":{"kind":"own"},"prototype":{"kind":"own"},"keep":true}',
    )
    if (!special || typeof special !== "object") throw new Error("special fixture must be an object")
    const nullPrototype: object = Object.create(null)
    for (const [key, value] of [
      ["__proto__", { hidden: "null-value" }],
      ["constructor", { kind: "null-own" }],
      ["prototype", { kind: "null-own" }],
      ["keep", true],
    ] as const) {
      Object.defineProperty(nullPrototype, key, { value, enumerable: true, writable: true, configurable: true })
    }
    Object.defineProperty(input.request, "special", {
      value: special,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(input.request, "nullPrototype", {
      value: nullPrototype,
      enumerable: true,
      writable: true,
      configurable: true,
    })

    const current = withCurrentFingerprint(input)
    const result = projectContextFoldingRequest(current)
    expect(result.applied).toBe(true)
    const projectedSpecial = Reflect.get(result.request, "special")
    const projectedNullPrototype = Reflect.get(result.request, "nullPrototype")
    if (!projectedSpecial || typeof projectedSpecial !== "object") throw new Error("projected special object missing")
    if (!projectedNullPrototype || typeof projectedNullPrototype !== "object") {
      throw new Error("projected null-prototype object missing")
    }
    expect(JSON.stringify(projectedSpecial)).toBe(JSON.stringify(special))
    expect(JSON.stringify(projectedNullPrototype)).toBe(JSON.stringify(nullPrototype))
    expect(Object.getPrototypeOf(projectedSpecial)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(projectedNullPrototype)).toBeNull()
    for (const key of ["__proto__", "constructor", "prototype", "keep"]) {
      expect(Object.prototype.hasOwnProperty.call(projectedSpecial, key)).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(projectedNullPrototype, key)).toBe(true)
    }
  })

  test("discards a private partial copy when projection fails midway", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const original = JSON.stringify(input.request)
    const result = projectContextFoldingRequest(input, {
      afterReplacement: () => {
        throw new Error("injected projection failure")
      },
    })
    expect(result.request).toBe(input.request)
    expect(result).toMatchObject({ applied: false, plan: { skipReason: "projection-failed" } })
    expect(JSON.stringify(input.request)).toBe(original)
  })

  test("detects shared-reference pollution and discards the private copy", () => {
    const body = bodyForSavings(600)
    const source = ref("aliased-source")
    const witness = ref("aliased-witness")
    const shared = { body }
    const request = {
      messages: [
        { callID: "source" },
        { callID: "source", result: shared },
        { callID: "witness" },
        { callID: "witness", result: shared },
      ],
      metadata: { mutable: "original" },
    }
    const identity = { model: "test", runtime: "test-runtime" }
    const budget = budgetInput(request.messages)
    const input = withCurrentFingerprint<typeof request>({
      request,
      identity,
      expectedRequestFingerprint: "captured-below",
      duplicatePlan: duplicatePlan(source, witness),
      budget,
      mapping: {
        requestFingerprint: "captured-below",
        calls: [
          { ref: source, visibleCallID: "source", visibleCallIDPath: ["messages", 0, "callID"], ordinal: 0 },
          { ref: witness, visibleCallID: "witness", visibleCallIDPath: ["messages", 2, "callID"], ordinal: 1 },
        ],
        results: [
          {
            ref: source,
            visibleCallID: "source",
            visibleCallIDPath: ["messages", 1, "callID"],
            ordinal: 0,
            bodyPath: ["messages", 1, "result", "body"],
            complete: true,
          },
          {
            ref: witness,
            visibleCallID: "witness",
            visibleCallIDPath: ["messages", 3, "callID"],
            ordinal: 1,
            bodyPath: ["messages", 3, "result", "body"],
            complete: true,
          },
        ],
      },
    })
    const result = projectContextFoldingRequest(input)
    expect(result.request).toBe(request)
    expect(result.plan.skipReason).toBe("projection-failed")
    expect(shared.body).toBe(body)
  })

  test("rejects source aliases into unselected user, metadata, result, and multiple source paths", () => {
    for (const alias of ["user", "metadataAlias", "unselectedResult"]) {
      const { input } = projectionFixture(bodyForSavings(600))
      Object.defineProperty(input.request, alias, {
        value: input.request.messages[1],
        enumerable: true,
        writable: true,
        configurable: true,
      })
      const before = JSON.stringify(input.request)
      const current = withCurrentFingerprint(input)
      const result = projectContextFoldingRequest(current)
      expect(result.request).toBe(input.request)
      expect(result.plan.skipReason).toBe("projection-failed")
      expect(JSON.stringify(input.request)).toBe(before)
    }

    const body = bodyForSavings(600)
    const refs = [ref("source-a"), ref("witness-a"), ref("source-b"), ref("witness-b")]
    const ids = ["source-a", "witness-a", "source-b", "witness-b"]
    const sharedSource = { body }
    const request = {
      messages: ids.flatMap((callID, index) => [
        { callID },
        { callID, result: index === 0 || index === 2 ? sharedSource : { body } },
      ]),
      metadata: { mutable: "original" },
    }
    const identity = { model: "test-model", runtime: "test-runtime" }
    const budget = budgetInput(request.messages)
    const duplicate: FoldPlan = {
      replacements: [
        { source: refs[0], witness: refs[1] },
        { source: refs[2], witness: refs[3] },
      ],
      protectedStepIDs: [],
      exclusions: [],
      skipReason: undefined,
    }
    const fingerprint = requestFingerprint(request, identity, budget)
    const input: ContextFoldingProjectionInput<typeof request> = {
      request,
      identity,
      expectedRequestFingerprint: fingerprint,
      duplicatePlan: duplicate,
      budget,
      mapping: {
        requestFingerprint: fingerprint,
        calls: refs.map((item, ordinal) => ({
          ref: item,
          visibleCallID: ids[ordinal],
          visibleCallIDPath: ["messages", ordinal * 2, "callID"],
          ordinal,
        })),
        results: refs.map((item, ordinal) => ({
          ref: item,
          visibleCallID: ids[ordinal],
          visibleCallIDPath: ["messages", ordinal * 2 + 1, "callID"],
          ordinal,
          bodyPath: ["messages", ordinal * 2 + 1, "result", "body"],
          complete: true,
        })),
      },
    }
    const result = projectContextFoldingRequest(input)
    expect(result.request).toBe(request)
    expect(result.plan.skipReason).toBe("projection-failed")
    expect(sharedSource.body).toBe(body)
  })

  test("does not chain or damage an already projected request", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const first = projectContextFoldingRequest(input)
    expect(first.applied).toBe(true)
    const secondInput = withCurrentFingerprint({
      ...input,
      request: first.request,
      budget: { ...input.budget, messages: first.request.messages },
    })
    const second = projectContextFoldingRequest(secondInput)
    expect(second.request).toBe(first.request)
    expect(second.applied).toBe(false)
    expect(second.plan.skipReason).toBe("already-projected")
  })

  test("uses the error placeholder only when the plan and mapping agree on an error result", () => {
    const { input, source, witness } = projectionFixture(bodyForSavings(600))
    const errorPlan: FoldPlan = {
      ...input.duplicatePlan,
      replacements: [{ source, witness, resultKind: "error" }],
    }
    const errorMapping = {
      ...input.mapping,
      results: input.mapping.results.map((result) => ({ ...result, resultKind: "error" as const })),
    }
    const applied = projectContextFoldingRequest({ ...input, duplicatePlan: errorPlan, mapping: errorMapping })
    expect(applied.applied).toBe(true)
    const errorPlaceholder =
      '[Duplicate tool error output folded. The identical full error is retained in later tool call "visible-witness".]'
    expect(applied.plan.replacements[0].placeholder).toBe(errorPlaceholder)
    expect(applied.request.messages[1].body).toBe(errorPlaceholder)

    // A plan that claims an error result cannot be projected onto a text mapping.
    const mismatch = projectContextFoldingRequest({ ...input, duplicatePlan: errorPlan })
    expect(mismatch.applied).toBe(false)
    expect(mismatch.plan.skipReason).toBe("mapping-mismatch")

    // An unknown mapping kind never matches any plan kind.
    const unknownKind = projectContextFoldingRequest({
      ...input,
      duplicatePlan: errorPlan,
      mapping: {
        ...input.mapping,
        results: input.mapping.results.map((result) => ({ ...result, resultKind: "unknown" as const })),
      },
    })
    expect(unknownKind.applied).toBe(false)
    expect(unknownKind.plan.skipReason).toBe("mapping-mismatch")
  })

  test("recognizes an error placeholder from an earlier projection", () => {
    const placeholder =
      '[Duplicate tool error output folded. The identical full error is retained in later tool call "visible-witness".]'
    // Pad past the soft target so the already-projected guard, not the budget, decides the outcome.
    const { input } = projectionFixture(placeholder + "x".repeat(4_000))
    const result = projectContextFoldingRequest(input)
    expect(result.applied).toBe(false)
    expect(result.plan.skipReason).toBe("already-projected")
  })
})

describe("context folding resource limits", () => {
  const candidate = (
    id: string,
    input: unknown = { filePath: "/workspace/file.ts" },
    text = "body",
  ): FoldCandidate => ({
    ref: ref(id),
    toolName: "read",
    source: {
      sessionID: "session",
      assistantMessageID: `message-${id}`,
      callID: `call-${id}`,
      toolName: "read",
      sourceKind: "host-builtin",
      registrationID: "builtin-read",
      registrationGeneration: "generation-1",
    },
    status: "completed",
    input,
    result: { kind: "text", text, complete: true },
    safety: { attachments: "none", instructions: "none", providerExecuted: false },
    targetPath: "/workspace/file.ts",
  })
  const step = (id: string, candidates: readonly FoldCandidate[] = []): FoldStep => ({
    id,
    estimatedTokens: 4_000,
    candidates,
  })

  test("guards deep, oversized, sparse, and excessive candidate inputs before unbounded construction", () => {
    let deep: unknown = "leaf"
    for (let index = 0; index <= ContextFoldingPolicy.workLimits.maxDepth; index++) deep = { value: deep }
    expect(normalizeParameters(deep)).toEqual({ ok: false })

    const sparse: unknown[] = []
    sparse.length = ContextFoldingPolicy.workLimits.maxContainerEntries + 1
    expect(normalizeParameters(sparse)).toEqual({ ok: false })

    const huge = "x".repeat(ContextFoldingPolicy.workLimits.maxInputBytes + 1)
    expect(planContextFolding([step("huge", [candidate("huge", { value: huge }, huge)])]).skipReason).toBe("work-limit")

    const many = Array.from({ length: ContextFoldingPolicy.maximumCandidates + 1 }, (_, index) =>
      candidate(`many-${index}`),
    )
    expect(planContextFolding([step("many", many)]).skipReason).toBe("work-limit")
  })

  test("bounds degenerate fingerprint buckets without approximate equality", () => {
    const candidates = Array.from({ length: ContextFoldingPolicy.maximumFingerprintBucketEntries + 1 }, (_, index) =>
      candidate(`collision-${index}`, { filePath: `/workspace/${index}.ts` }, `body-${index}`),
    )
    const plan = planContextFolding([step("collisions", candidates)], { fingerprint: () => "one-bucket" })
    expect(plan).toMatchObject({ replacements: [], skipReason: "work-limit" })
  })

  test("budget estimation skips oversized request content instead of approximating it", () => {
    const huge = "x".repeat(ContextFoldingPolicy.workLimits.maxInputBytes + 1)
    expect(estimateContextFoldingBudget(budgetInput([{ role: "user", content: huge }]))).toMatchObject({
      estimatedInputTokens: undefined,
      skipReason: "work-limit",
    })

    const multibyte = "你".repeat(Math.floor(ContextFoldingPolicy.workLimits.maxInputBytes / 3) + 1)
    expect(multibyte.length).toBeLessThan(ContextFoldingPolicy.workLimits.maxInputBytes)
    expect(estimateContextFoldingBudget(budgetInput([{ role: "user", content: multibyte }]))).toMatchObject({
      estimatedInputTokens: undefined,
      skipReason: "work-limit",
    })
  })

  test("bounds final wire mappings before allocating validation indexes", () => {
    const { input } = projectionFixture(bodyForSavings(600))
    const calls = Array.from({ length: ContextFoldingPolicy.maximumCandidates + 1 }, (_, index) => ({
      ref: ref(`mapping-${index}`),
      visibleCallID: `visible-${index}`,
      visibleCallIDPath: ["messages", index, "callID"] as const,
      ordinal: index,
    }))
    const result = projectContextFoldingRequest({ ...input, mapping: { ...input.mapping, calls } })
    expect(result.request).toBe(input.request)
    expect(result).toMatchObject({ applied: false, plan: { skipReason: "work-limit" } })
  })
})
