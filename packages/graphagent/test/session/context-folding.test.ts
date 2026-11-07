import { describe, expect, test } from "bun:test"
import type { FoldRef } from "@opencode-ai/core/session/context-folding"
import { jsonSchema, tool, type ModelMessage } from "ai"
import { ContextFolding, type HistorySnapshot, type Snapshot } from "@/session/context-folding"
import { LLMNative } from "@/session/llm/native-request"
import { ProviderTransform } from "@/provider/transform"
import { ProviderTest } from "../fake/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const source: FoldRef = { messageID: "msg_source", partID: "prt_source", callID: "call:source" }
const witness: FoldRef = { messageID: "msg_witness", partID: "prt_witness", callID: "call:witness" }
const body = "same complete tool output\n".repeat(600)
const errorBody = "same complete tool error\n".repeat(600)
const tools = {
  read: tool({
    description: "Read a file",
    inputSchema: jsonSchema({
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
      additionalProperties: false,
    }),
  }),
}

function model(apiID = "gpt-5.2", providerID = "openai") {
  return ProviderTest.model({
    id: ModelV2.ID.make(apiID),
    providerID: ProviderV2.ID.make(providerID),
    api: { id: apiID, url: "https://example.com", npm: "@ai-sdk/openai" },
    limit: { context: 4_000, input: 4_000, output: 512 },
  })
}

function historySnapshot(sourceRef = source, witnessRef = witness): HistorySnapshot {
  const evidence = {
    input: { filePath: "/tmp/a.txt" },
    result: body,
    comparisonMetadata: {
      title: "a.txt",
      metadata: { loaded: [], contextFoldingInstructions: "none" },
    },
    outerMetadata: undefined,
  }
  return {
    duplicatePlan: {
      replacements: [{ source: sourceRef, witness: witnessRef }],
      protectedStepIDs: ["recent"],
      exclusions: [],
      skipReason: undefined,
    },
    references: [
      { ref: sourceRef, toolName: "read", complete: true, resultKind: "text", evidence },
      { ref: witnessRef, toolName: "read", complete: true, resultKind: "text", evidence },
    ],
  }
}

function errorHistorySnapshot(sourceRef = source, witnessRef = witness): HistorySnapshot {
  const evidence = {
    input: { filePath: "/tmp/a.txt" },
    result: errorBody,
    comparisonMetadata: { metadata: {} },
    outerMetadata: undefined,
  }
  return {
    duplicatePlan: {
      replacements: [{ source: sourceRef, witness: witnessRef, resultKind: "error" }],
      protectedStepIDs: ["recent"],
      exclusions: [],
      skipReason: undefined,
    },
    references: [
      { ref: sourceRef, toolName: "read", complete: true, resultKind: "error", evidence },
      { ref: witnessRef, toolName: "read", complete: true, resultKind: "error", evidence },
    ],
  }
}

function duplicateHistory(pairs: ReadonlyArray<readonly [FoldRef, FoldRef]>): HistorySnapshot {
  const evidence = {
    input: { filePath: "/tmp/a.txt" },
    result: body,
    comparisonMetadata: {
      title: "a.txt",
      metadata: { loaded: [], contextFoldingInstructions: "none" },
    },
    outerMetadata: undefined,
  }
  return {
    duplicatePlan: {
      replacements: pairs.map(([sourceRef, witnessRef]) => ({ source: sourceRef, witness: witnessRef })),
      protectedStepIDs: [],
      exclusions: [],
      skipReason: undefined,
    },
    references: pairs.flatMap(([sourceRef, witnessRef]) => [
      { ref: sourceRef, toolName: "read", complete: true, resultKind: "text", evidence },
      { ref: witnessRef, toolName: "read", complete: true, resultKind: "text", evidence },
    ]),
  }
}

function snapshot(
  sourceRef = source,
  witnessRef = witness,
  sourceMessages = messages(sourceRef.callID, witnessRef.callID),
): Snapshot {
  const result = ContextFolding.bindModelMessages(historySnapshot(sourceRef, witnessRef), sourceMessages)
  if (!result) throw new Error("failed to bind context-folding test snapshot")
  return result
}

function messages(
  sourceID = source.callID,
  witnessID = witness.callID,
  sharedOutput?: { type: "text" | "error-text"; value: string },
): ModelMessage[] {
  const output = sharedOutput ?? { type: "text", value: body }
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: sourceID,
          toolName: "read",
          input: { filePath: "/tmp/a.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: sourceID,
          toolName: "read",
          output,
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: witnessID,
          toolName: "read",
          input: { filePath: "/tmp/a.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: witnessID,
          toolName: "read",
          output,
        },
      ],
    },
  ]
}

function toolCallAt(value: ModelMessage[], index: number) {
  const message = value[index]
  if (!message || message.role !== "assistant" || !Array.isArray(message.content))
    throw new Error(`expected assistant tool call at ${index}`)
  const part = message.content[0]
  if (!part || part.type !== "tool-call") throw new Error(`expected tool call at ${index}`)
  return part
}

function toolResultAt(value: ModelMessage[], index: number) {
  const message = value[index]
  if (!message || message.role !== "tool" || !Array.isArray(message.content))
    throw new Error(`expected tool result at ${index}`)
  const part = message.content[0]
  if (!part || part.type !== "tool-result") throw new Error(`expected tool result at ${index}`)
  return part
}

function aiProjection(input: {
  model?: ReturnType<typeof model>
  messages?: ModelMessage[]
  preparedMessages?: ModelMessage[]
  snapshot?: Snapshot
  purpose?: "conversation" | "compaction" | "auxiliary" | "unknown"
  sourceMessages?: ModelMessage[]
}) {
  const selected = input.model ?? model()
  const sourceMessages = input.sourceMessages ?? input.messages ?? messages()
  const transformed = input.preparedMessages ?? ProviderTransform.message(structuredClone(sourceMessages), selected, {})
  return ContextFolding.projectAISDK({
    model: selected,
    purpose: input.purpose ?? "conversation",
    snapshot: input.snapshot ?? snapshot(source, witness, sourceMessages),
    messages: transformed,
    sourceMessages,
    messageTransformOptions: {},
    tools,
    maxOutputTokens: 512,
    params: { maxOutputTokens: 512 },
    system: { kind: "messages" },
  })
}

function outputValue(projected: { messages: ModelMessage[] }, index: number) {
  const message = projected.messages[index]
  if (!message || !Array.isArray(message.content)) return undefined
  const part = message.content[0]
  if (!part || part.type !== "tool-result") return undefined
  return part.output.type === "text" ? part.output.value : undefined
}

function errorOutputValue(projected: { messages: ModelMessage[] }, index: number) {
  const message = projected.messages[index]
  if (!message || !Array.isArray(message.content)) return undefined
  const part = message.content[0]
  if (!part || part.type !== "tool-result") return undefined
  return part.output.type === "error-text" ? part.output.value : undefined
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

describe("session.context-folding OpenCode wire adapters", () => {
  test("projects the AI SDK final provider-visible request without mutating stored messages", () => {
    const stored = messages()
    const before = structuredClone(stored)
    const outbound = deepFreeze(ProviderTransform.message(structuredClone(stored), model(), {}))
    const projected = aiProjection({ preparedMessages: outbound })

    expect(projected.applied).toBe(true)
    expect(outputValue(projected.request, 1)).toContain("Duplicate tool output folded")
    expect(outputValue(projected.request, 1)).toContain(witness.callID)
    expect(outputValue(projected.request, 3)).toBe(body)
    expect(stored).toEqual(before)
    expect(outbound).toEqual(ProviderTransform.message(structuredClone(stored), model(), {}))
  })

  test("duplicates shared host aliases into an independent wire tree before projection", () => {
    const shared = { type: "text" as const, value: body }
    const original = messages(source.callID, witness.callID, shared)
    const projected = aiProjection({ messages: original })

    expect(projected.applied).toBe(true)
    expect(outputValue(projected.request, 1)).not.toBe(body)
    expect(outputValue(projected.request, 3)).toBe(body)
    expect(shared.value).toBe(body)
  })

  test("supports non-colliding Claude and Mistral IDs through the shared scrub helper", () => {
    const claude = model("claude-4-sonnet")
    const claudeResult = aiProjection({ model: claude })
    expect(claudeResult.applied).toBe(true)
    expect(outputValue(claudeResult.request, 1)).toContain(ProviderTransform.toolCallID(witness.callID, claude))

    const mistralSource = { ...source, callID: "sourceABC:1" }
    const mistralWitness = { ...witness, callID: "witnessXY:2" }
    const mistral = model("mistral-large", "mistral")
    const mistralResult = aiProjection({
      model: mistral,
      snapshot: snapshot(mistralSource, mistralWitness),
      messages: messages(mistralSource.callID, mistralWitness.callID),
    })
    expect(mistralResult.applied).toBe(true)
    expect(outputValue(mistralResult.request, 1)).toContain(
      ProviderTransform.toolCallID(mistralWitness.callID, mistral),
    )
  })

  test("fails closed when Claude or Mistral scrubbing collides", () => {
    const claudeSource = { ...source, callID: "same:id" }
    const claudeWitness = { ...witness, callID: "same?id" }
    const claude = model("claude-4-sonnet")
    const claudeResult = aiProjection({
      model: claude,
      snapshot: snapshot(claudeSource, claudeWitness),
      messages: messages(claudeSource.callID, claudeWitness.callID),
    })
    expect(claudeResult.applied).toBe(false)
    expect(claudeResult.plan.skipReason).toBe("mapping-mismatch")

    const mistralSource = { ...source, callID: "abcdefghi-source" }
    const mistralWitness = { ...witness, callID: "abcdefghi-witness" }
    const mistral = model("mistral-large", "mistral")
    const mistralResult = aiProjection({
      model: mistral,
      snapshot: snapshot(mistralSource, mistralWitness),
      messages: messages(mistralSource.callID, mistralWitness.callID),
    })
    expect(mistralResult.applied).toBe(false)
    expect(mistralResult.plan.skipReason).toBe("mapping-mismatch")
  })

  test("projects canonical Native messages before executable definitions are added", () => {
    const selected = model()
    const canonical = LLMNative.request({
      model: selected,
      apiKey: "test-key",
      messages: ProviderTransform.message(messages(), selected, {}),
      tools,
      maxOutputTokens: 512,
    })
    const projected = ContextFolding.projectNative({
      model: selected,
      purpose: "conversation",
      snapshot: snapshot(),
      request: canonical,
      transformedMessages: ProviderTransform.message(structuredClone(messages()), selected, {}),
      sourceMessages: messages(),
      messageTransformOptions: {},
      tools,
      maxOutputTokens: 512,
      params: { maxOutputTokens: 512 },
      system: { kind: "messages" },
    })

    expect(projected.applied).toBe(true)
    expect(JSON.stringify(projected.request.messages)).toContain("Duplicate tool output folded")
    expect(JSON.stringify(canonical.messages)).not.toContain("Duplicate tool output folded")
  })

  test("skips compaction, auxiliary and unknown purposes", () => {
    for (const purpose of ["compaction", "auxiliary", "unknown"] as const) {
      const projected = aiProjection({ purpose })
      expect(projected.applied).toBe(false)
      expect(projected.plan.skipReason).toBe("no-eligible-duplicates")
    }
  })

  test("fails closed for an incomplete result mapping", () => {
    const complete = snapshot()
    const incomplete: ContextFolding.Snapshot = {
      ...complete,
      references: complete.references.map((reference, index) =>
        index === 0 ? { ...reference, complete: false } : reference,
      ),
    }
    const projected = aiProjection({ snapshot: incomplete })
    expect(projected.applied).toBe(false)
    expect(projected.plan.skipReason).toBe("mapping-mismatch")
  })

  test("fails closed when bound history metadata evidence changes", () => {
    const complete = snapshot()
    for (const key of ["comparisonMetadataFingerprint", "outerMetadataFingerprint"] as const) {
      const changed: ContextFolding.Snapshot = {
        ...complete,
        references: complete.references.map((reference, index) =>
          index === 0 ? { ...reference, [key]: `${reference[key]}-changed` } : reference,
        ),
      }
      const projected = aiProjection({ snapshot: changed })
      expect(projected.applied).toBe(false)
      expect(projected.plan.skipReason).toBe("mapping-mismatch")
    }
  })

  test("fails closed when final AI SDK input, body, outer fields or order differ from the bound history", () => {
    const mutations = [
      (value: ModelMessage[]) => {
        toolCallAt(value, 2).input = { filePath: "/DIFFERENT" }
      },
      (value: ModelMessage[]) => {
        toolResultAt(value, 3).output = { type: "text", value: "different body" }
      },
      (value: ModelMessage[]) => {
        toolCallAt(value, 0).providerOptions = { unknown: { changed: true } }
      },
      (value: ModelMessage[]) => {
        value.splice(0, value.length, ...value.slice(2), ...value.slice(0, 2))
      },
    ]
    for (const mutate of mutations) {
      const sourceMessages = messages()
      const final = ProviderTransform.message(structuredClone(sourceMessages), model(), {})
      mutate(final)
      const projected = aiProjection({
        sourceMessages,
        preparedMessages: final,
        snapshot: snapshot(source, witness, sourceMessages),
      })
      expect(projected.applied).toBe(false)
      expect(projected.plan.skipReason).toBe("mapping-mismatch")
    }
  })

  test("fails closed for a full-request visible ID collision across different tool names", () => {
    const sourceMessages = messages()
    const final = ProviderTransform.message(structuredClone(sourceMessages), model(), {})
    final.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: source.callID,
            toolName: "grep",
            input: { pattern: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: source.callID,
            toolName: "grep",
            output: { type: "text", value: body },
          },
        ],
      },
    )
    const projected = aiProjection({
      sourceMessages,
      preparedMessages: final,
      snapshot: snapshot(source, witness, sourceMessages),
    })
    expect(projected.applied).toBe(false)
    expect(projected.plan.skipReason).toBe("mapping-mismatch")
  })

  test("fails closed when final Native input, body or order differs from the bound history", () => {
    const selected = model()
    for (const mutate of [
      (value: ModelMessage[]) => {
        toolCallAt(value, 2).input = { filePath: "/DIFFERENT" }
      },
      (value: ModelMessage[]) => {
        toolResultAt(value, 3).output = { type: "text", value: "different body" }
      },
      (value: ModelMessage[]) => value.splice(0, value.length, ...value.slice(2), ...value.slice(0, 2)),
    ]) {
      const sourceMessages = messages()
      const transformed = ProviderTransform.message(structuredClone(sourceMessages), selected, {})
      mutate(transformed)
      const canonical = LLMNative.request({
        model: selected,
        apiKey: "test-key",
        messages: transformed,
        tools,
        maxOutputTokens: 512,
      })
      const projected = ContextFolding.projectNative({
        model: selected,
        purpose: "conversation",
        snapshot: snapshot(source, witness, sourceMessages),
        request: canonical,
        transformedMessages: transformed,
        sourceMessages,
        messageTransformOptions: {},
        tools,
        maxOutputTokens: 512,
        params: { maxOutputTokens: 512 },
        system: { kind: "messages" },
      })
      expect(projected.applied).toBe(false)
      expect(projected.plan.skipReason).toBe("mapping-mismatch")
    }
  })

  test("projects duplicate error-text results with the error placeholder", () => {
    const sourceMessages = messages(source.callID, witness.callID, { type: "error-text", value: errorBody })
    const bound = ContextFolding.bindModelMessages(errorHistorySnapshot(), sourceMessages)
    expect(bound).toBeDefined()
    const projected = aiProjection({ snapshot: bound!, sourceMessages })

    expect(projected.applied).toBe(true)
    expect(errorOutputValue(projected.request, 1)).toContain("Duplicate tool error output folded")
    expect(errorOutputValue(projected.request, 1)).toContain(witness.callID)
    expect(errorOutputValue(projected.request, 3)).toBe(errorBody)
  })

  test("never binds a text identity to an error-text wire result or the reverse", () => {
    const errorWire = messages(source.callID, witness.callID, { type: "error-text", value: errorBody })
    const boundToText = ContextFolding.bindModelMessages(
      {
        ...historySnapshot(),
        references: historySnapshot().references.map((reference) => ({
          ...reference,
          evidence: { ...reference.evidence, result: errorBody },
        })),
      },
      errorWire,
    )
    expect(boundToText).toBeDefined()
    expect(boundToText!.duplicatePlan.replacements).toEqual([])
    expect(boundToText!.duplicatePlan.skipReason).toBe("mapping-mismatch")

    const textWire = messages(source.callID, witness.callID)
    const boundToError = ContextFolding.bindModelMessages(
      {
        ...errorHistorySnapshot(),
        references: errorHistorySnapshot().references.map((reference) => ({
          ...reference,
          evidence: { ...reference.evidence, result: body },
        })),
      },
      textWire,
    )
    expect(boundToError).toBeDefined()
    expect(boundToError!.duplicatePlan.replacements).toEqual([])
    expect(boundToError!.duplicatePlan.skipReason).toBe("mapping-mismatch")
  })

  test("projects duplicate Native error results with the error placeholder", () => {
    const selected = model()
    const sourceMessages = messages(source.callID, witness.callID, { type: "error-text", value: errorBody })
    const bound = ContextFolding.bindModelMessages(errorHistorySnapshot(), sourceMessages)
    expect(bound).toBeDefined()
    const transformed = ProviderTransform.message(structuredClone(sourceMessages), selected, {})
    const canonical = LLMNative.request({
      model: selected,
      apiKey: "test-key",
      messages: transformed,
      tools,
      maxOutputTokens: 512,
    })
    const projected = ContextFolding.projectNative({
      model: selected,
      purpose: "conversation",
      snapshot: bound!,
      request: canonical,
      transformedMessages: transformed,
      sourceMessages,
      messageTransformOptions: {},
      tools,
      maxOutputTokens: 512,
      params: { maxOutputTokens: 512 },
      system: { kind: "messages" },
    })

    expect(projected.applied).toBe(true)
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- reads the canonical native wire shape built by LLMNative
    const results = (projected.request.messages as ReadonlyArray<{ content: ReadonlyArray<Record<string, unknown>> }>)
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool-result")
      .map((part) => part.result)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ type: "error", value: expect.stringContaining("Duplicate tool error output folded") })
    expect(results[0]).toEqual({ type: "error", value: expect.stringContaining(witness.callID) })
    expect(results[1]).toEqual({ type: "error", value: errorBody })
  })

  test("isolates an unverifiable pair instead of disabling every verified pair", () => {
    const firstSource = { messageID: "msg_s1", partID: "prt_s1", callID: "call:s1" }
    const firstWitness = { messageID: "msg_w1", partID: "prt_w1", callID: "call:w1" }
    const secondSource = { messageID: "msg_s2", partID: "prt_s2", callID: "call:s2" }
    const secondWitness = { messageID: "msg_w2", partID: "prt_w2", callID: "call:w2" }
    const sourceMessages = [
      ...messages(firstSource.callID, firstWitness.callID),
      ...messages(secondSource.callID, secondWitness.callID),
    ]
    const bound = ContextFolding.bindModelMessages(
      duplicateHistory([
        [firstSource, firstWitness],
        [secondSource, secondWitness],
      ]),
      sourceMessages,
    )
    expect(bound).toBeDefined()
    expect(bound!.duplicatePlan.replacements).toEqual([
      { source: firstSource, witness: firstWitness },
      { source: secondSource, witness: secondWitness },
    ])

    const projected = aiProjection({ snapshot: bound!, sourceMessages })
    expect(projected.applied).toBe(true)
    expect(outputValue(projected.request, 1)).toContain(firstWitness.callID)
    expect(outputValue(projected.request, 3)).toBe(body)
    expect(outputValue(projected.request, 5)).toContain(secondWitness.callID)
    expect(outputValue(projected.request, 7)).toBe(body)

    const changed = structuredClone(sourceMessages)
    toolResultAt(changed, 1).output = { type: "text", value: "different body" }
    const partial = ContextFolding.bindModelMessages(
      duplicateHistory([
        [firstSource, firstWitness],
        [secondSource, secondWitness],
      ]),
      changed,
    )
    expect(partial).toBeDefined()
    expect(partial!.duplicatePlan.replacements).toEqual([{ source: secondSource, witness: secondWitness }])

    const changedTool = changed[5]
    if (!changedTool || changedTool.role !== "tool") throw new Error("expected tool message")
    changedTool.content = [
      {
        type: "tool-result",
        toolCallId: secondSource.callID,
        toolName: "read",
        output: { type: "text", value: "different body" },
      },
    ]
    const dropped = ContextFolding.bindModelMessages(
      duplicateHistory([
        [firstSource, firstWitness],
        [secondSource, secondWitness],
      ]),
      changed,
    )
    expect(dropped).toBeDefined()
    expect(dropped!.duplicatePlan.replacements).toEqual([])
    expect(dropped!.duplicatePlan.skipReason).toBe("mapping-mismatch")
  })
})
