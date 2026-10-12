import { describe, expect } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { ToolSourceLedger, type Interface as Ledger } from "@/session/tool-source-ledger"
import { reloadInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(ToolSourceLedger.defaultLayer)
const sessionID = "ses_context_folding"

const identity = (input: {
  messageID: string
  callID: string
  sourceKind?: "host-builtin" | "custom" | "mcp" | "provider"
  generation: string
}) => ({
  sessionID,
  assistantMessageID: input.messageID,
  callID: input.callID,
  toolName: "read",
  sourceKind: input.sourceKind ?? ("host-builtin" as const),
  registrationID: `${input.sourceKind ?? "host-builtin"}:read`,
  registrationGeneration: input.generation,
})

const assistant = (input: {
  messageID: string
  partID: string
  callID?: string
  output?: string
  filler?: string
  truncated?: boolean
  providerExecuted?: boolean
  loaded?: unknown
  instructionMarker?: "none" | "dynamic"
}): SessionV1.WithParts => ({
  info: {
    id: input.messageID,
    sessionID,
    role: "assistant",
    parentID: "msg_parent",
    time: { created: 0 },
    modelID: "model",
    providerID: "provider",
    mode: "",
    agent: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as SessionV1.Assistant,
  parts: input.callID
    ? ([
        {
          id: `${input.partID}_step`,
          sessionID,
          messageID: input.messageID,
          type: "step-start",
        },
        {
          id: input.partID,
          sessionID,
          messageID: input.messageID,
          type: "tool",
          callID: input.callID,
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/source.ts" },
            output: input.output ?? "same complete output",
            title: "source.ts",
            metadata: {
              ...(input.truncated ? { truncated: true } : {}),
              ...(input.loaded === undefined ? { loaded: [] } : { loaded: input.loaded }),
              ...(input.instructionMarker === undefined
                ? { contextFoldingInstructions: "none" }
                : { contextFoldingInstructions: input.instructionMarker }),
            },
            time: { start: 0, end: 1 },
          },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        },
      ] as SessionV1.Part[])
    : ([
        {
          id: `${input.partID}_step`,
          sessionID,
          messageID: input.messageID,
          type: "step-start",
        },
        {
          id: input.partID,
          sessionID,
          messageID: input.messageID,
          type: "text",
          text: input.filler ?? "x".repeat(20_000),
        },
      ] as SessionV1.Part[]),
})

const conversation = (options?: { truncated?: boolean; providerExecuted?: boolean }) => [
  assistant({ messageID: "msg_source", partID: "prt_source", callID: "call_source" }),
  assistant({
    messageID: "msg_witness",
    partID: "prt_witness",
    callID: "call_witness",
    truncated: options?.truncated,
    providerExecuted: options?.providerExecuted,
  }),
  ...Array.from({ length: 4 }, (_, index) =>
    assistant({ messageID: `msg_recent_${index}`, partID: `prt_recent_${index}` }),
  ),
]

const registerPair = (ledger: Ledger, sourceKind: "host-builtin" | "custom" | "mcp" | "provider" = "host-builtin") =>
  Effect.gen(function* () {
    const generation = yield* ledger.activate(sessionID, [{ sourceKind, registrationID: `${sourceKind}:read` }])
    yield* ledger.record(identity({ messageID: "msg_source", callID: "call_source", sourceKind, generation }))
    yield* ledger.record(identity({ messageID: "msg_witness", callID: "call_witness", sourceKind, generation }))
    return generation
  })

describe("session tool-source ledger", () => {
  it.instance("does not reuse registration generations after an ABA registration change", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const builtin = [{ sourceKind: "host-builtin" as const, registrationID: "builtin:read" }]
      const custom = [{ sourceKind: "custom" as const, registrationID: "custom:read" }]
      const firstBuiltin = yield* ledger.activate(sessionID, builtin)
      yield* ledger.record(identity({ messageID: "msg_existing", callID: "call_existing", generation: firstBuiltin }))

      const repeatedBuiltin = yield* ledger.activate(sessionID, builtin)
      expect(repeatedBuiltin).toBe(firstBuiltin)
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_existing",
          callID: "call_existing",
          toolName: "read",
        }),
      ).toBeDefined()

      const customGeneration = yield* ledger.activate(sessionID, custom)
      const returnedBuiltin = yield* ledger.activate(sessionID, builtin)
      expect(returnedBuiltin).not.toBe(firstBuiltin)
      expect(returnedBuiltin).not.toBe(customGeneration)

      yield* ledger.record(identity({ messageID: "msg_late_a", callID: "call_late_a", generation: firstBuiltin }))
      yield* ledger.record(identity({ messageID: "msg_late_b", callID: "call_late_b", generation: customGeneration }))
      yield* ledger.record(identity({ messageID: "msg_current", callID: "call_current", generation: returnedBuiltin }))

      for (const [messageID, callID] of [
        ["msg_late_a", "call_late_a"],
        ["msg_late_b", "call_late_b"],
      ]) {
        expect(
          yield* ledger.lookup({ sessionID, assistantMessageID: messageID, callID, toolName: "read" }),
        ).toBeUndefined()
      }
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_current",
          callID: "call_current",
          toolName: "read",
        }),
      ).toMatchObject({ registrationGeneration: returnedBuiltin })
    }),
  )

  it.instance("does not reuse generations after materialization returns to an earlier model", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const registrations = [{ sourceKind: "host-builtin" as const, registrationID: "builtin:read" }]
      const firstModel = yield* ledger.activate(sessionID, registrations, "provider:model-a:schema-a")
      const secondModel = yield* ledger.activate(sessionID, registrations, "provider:model-b:schema-b")
      const returnedModel = yield* ledger.activate(sessionID, registrations, "provider:model-a:schema-a")

      expect(returnedModel).not.toBe(firstModel)
      expect(returnedModel).not.toBe(secondModel)
      yield* ledger.record(
        identity({ messageID: "msg_late_model_a", callID: "call_late_model_a", generation: firstModel }),
      )
      yield* ledger.record(
        identity({ messageID: "msg_late_model_b", callID: "call_late_model_b", generation: secondModel }),
      )
      yield* ledger.record(
        identity({ messageID: "msg_current_model_a", callID: "call_current_model_a", generation: returnedModel }),
      )

      for (const [messageID, callID] of [
        ["msg_late_model_a", "call_late_model_a"],
        ["msg_late_model_b", "call_late_model_b"],
      ]) {
        expect(
          yield* ledger.lookup({ sessionID, assistantMessageID: messageID, callID, toolName: "read" }),
        ).toBeUndefined()
      }
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_current_model_a",
          callID: "call_current_model_a",
          toolName: "read",
        }),
      ).toMatchObject({ registrationGeneration: returnedModel })
    }),
  )

  it.instance("isolates session records and invalidates old registration generations", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const first = yield* ledger.activate(sessionID, [{ sourceKind: "host-builtin", registrationID: "builtin:read" }])
      yield* ledger.record(identity({ messageID: "msg_source", callID: "call_source", generation: first }))
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_source",
          callID: "call_source",
          toolName: "read",
        }),
      ).toBeDefined()
      expect(
        yield* ledger.lookup({
          sessionID: "ses_other",
          assistantMessageID: "msg_source",
          callID: "call_source",
          toolName: "read",
        }),
      ).toBeUndefined()

      const second = yield* ledger.activate(sessionID, [{ sourceKind: "custom", registrationID: "custom:read" }])
      expect(second).not.toBe(first)
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_source",
          callID: "call_source",
          toolName: "read",
        }),
      ).toBeUndefined()
      yield* ledger.record(identity({ messageID: "msg_source", callID: "call_source", generation: first }))
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_source",
          callID: "call_source",
          toolName: "read",
        }),
      ).toBeUndefined()

      yield* ledger.record(
        identity({ messageID: "msg_source", callID: "call_source", sourceKind: "custom", generation: second }),
      )
      const rematerialized = yield* ledger.activate(
        sessionID,
        [{ sourceKind: "custom", registrationID: "custom:read" }],
        "provider:model-b:schema-b",
      )
      expect(rematerialized).not.toBe(second)
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_source",
          callID: "call_source",
          toolName: "read",
        }),
      ).toBeUndefined()
      yield* ledger.record(
        identity({
          messageID: "msg_source",
          callID: "call_source",
          sourceKind: "custom",
          generation: rematerialized,
        }),
      )
      yield* ledger.clearSession(sessionID)
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_source",
          callID: "call_source",
          toolName: "read",
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("keeps another session's provenance when a subagent materializes a different tool set", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      yield* registerPair(ledger)
      const parentGeneration = yield* ledger.activate(sessionID, [
        { sourceKind: "host-builtin", registrationID: "host-builtin:read" },
      ])

      // A child session in the same directory uses another model and a narrower tool set.
      const child = yield* ledger.activate(
        "ses_child",
        [{ sourceKind: "host-builtin", registrationID: "host-builtin:read" }],
        "provider:child-model:schema-child",
      )
      expect(child).not.toBe(parentGeneration)
      yield* ledger.record({
        ...identity({ messageID: "msg_child", callID: "call_child", generation: child }),
        sessionID: "ses_child",
      })

      // The parent's next turn rematerializes its own unchanged tool set.
      const resumed = yield* ledger.activate(sessionID, [
        { sourceKind: "host-builtin", registrationID: "host-builtin:read" },
      ])
      expect(resumed).toBe(parentGeneration)
      const result = yield* MessageV2.contextFoldingHistory({ messages: conversation(), ledger })
      expect(result.duplicatePlan.replacements).toEqual([
        {
          source: { messageID: "msg_source", partID: "prt_source", callID: "call_source" },
          witness: { messageID: "msg_witness", partID: "prt_witness", callID: "call_witness" },
        },
      ])
      expect(
        yield* ledger.lookup({
          sessionID: "ses_child",
          assistantMessageID: "msg_child",
          callID: "call_child",
          toolName: "read",
        }),
      ).toBeDefined()

      // A changed set for the parent still invalidates the parent's older identities only.
      yield* ledger.activate(sessionID, [{ sourceKind: "custom", registrationID: "custom:read" }])
      expect(
        yield* ledger.lookup({ sessionID, assistantMessageID: "msg_source", callID: "call_source", toolName: "read" }),
      ).toBeUndefined()
      expect(
        yield* ledger.lookup({
          sessionID: "ses_child",
          assistantMessageID: "msg_child",
          callID: "call_child",
          toolName: "read",
        }),
      ).toBeDefined()
    }),
  )

  it.instance("bounds tracked sessions and drops the evicted session's evidence", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const registrations = [{ sourceKind: "host-builtin" as const, registrationID: "builtin:read" }]
      const first = yield* ledger.activate("ses_evicted", registrations)
      yield* ledger.record({
        ...identity({ messageID: "msg_evicted", callID: "call_evicted", generation: first }),
        sessionID: "ses_evicted",
      })
      for (let index = 0; index < 1_024; index++) yield* ledger.activate(`ses_fill_${index}`, registrations)
      expect(
        yield* ledger.lookup({
          sessionID: "ses_evicted",
          assistantMessageID: "msg_evicted",
          callID: "call_evicted",
          toolName: "read",
        }),
      ).toBeUndefined()
      const again = yield* ledger.activate("ses_evicted", registrations)
      expect(again).not.toBe(first)
      yield* ledger.record({
        ...identity({ messageID: "msg_evicted", callID: "call_evicted", generation: first }),
        sessionID: "ses_evicted",
      })
      expect(
        yield* ledger.lookup({
          sessionID: "ses_evicted",
          assistantMessageID: "msg_evicted",
          callID: "call_evicted",
          toolName: "read",
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("refreshes an unchanged session so the least recently active session is evicted first", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const registrations = [{ sourceKind: "host-builtin" as const, registrationID: "builtin:read" }]
      const kept = yield* ledger.activate("ses_kept", registrations)
      yield* ledger.record({
        ...identity({ messageID: "msg_kept", callID: "call_kept", generation: kept }),
        sessionID: "ses_kept",
      })
      const dropped = yield* ledger.activate("ses_dropped", registrations)
      yield* ledger.record({
        ...identity({ messageID: "msg_dropped", callID: "call_dropped", generation: dropped }),
        sessionID: "ses_dropped",
      })
      for (let index = 0; index < 1_022; index++) yield* ledger.activate(`ses_fill_${index}`, registrations)
      // The tracked set is full. Reactivating the oldest unchanged session refreshes its recency.
      expect(yield* ledger.activate("ses_kept", registrations)).toBe(kept)
      yield* ledger.activate("ses_new", registrations)

      expect(
        yield* ledger.lookup({
          sessionID: "ses_kept",
          assistantMessageID: "msg_kept",
          callID: "call_kept",
          toolName: "read",
        }),
      ).toMatchObject({ registrationGeneration: kept })
      expect(
        yield* ledger.lookup({
          sessionID: "ses_dropped",
          assistantMessageID: "msg_dropped",
          callID: "call_dropped",
          toolName: "read",
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("creates a new provenance generation after an instance reload", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const current = yield* TestInstance
      const first = yield* ledger.activate(sessionID, [{ sourceKind: "host-builtin", registrationID: "builtin:read" }])
      yield* reloadInstance({ directory: current.directory })
      const second = yield* ledger.activate(sessionID, [{ sourceKind: "host-builtin", registrationID: "builtin:read" }])
      expect(second).not.toBe(first)
    }),
  )

  it.instance("keeps the identity ledger bounded", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const generation = yield* ledger.activate(sessionID, [
        { sourceKind: "host-builtin", registrationID: "builtin:read" },
      ])
      for (let index = 0; index <= 4_096; index++) {
        yield* ledger.record(identity({ messageID: `msg_${index}`, callID: `call_${index}`, generation }))
      }
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_0",
          callID: "call_0",
          toolName: "read",
        }),
      ).toBeUndefined()
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: "msg_4096",
          callID: "call_4096",
          toolName: "read",
        }),
      ).toBeDefined()
    }),
  )

  it.instance("derives one old-source replacement from immutable persisted history", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      yield* registerPair(ledger)
      const messages = conversation()
      const before = JSON.stringify(messages)
      const result = yield* MessageV2.contextFoldingHistory({ messages, ledger })

      expect(result.duplicatePlan.replacements).toEqual([
        {
          source: { messageID: "msg_source", partID: "prt_source", callID: "call_source" },
          witness: { messageID: "msg_witness", partID: "prt_witness", callID: "call_witness" },
        },
      ])
      expect(JSON.stringify(messages)).toBe(before)
      expect(result.duplicatePlan.protectedStepIDs).toHaveLength(4)
    }),
  )

  it.instance("does not trust a read/glob/grep name when provenance is missing or overwritten", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      const messages = conversation()

      const missing = yield* MessageV2.contextFoldingHistory({ messages, ledger })
      expect(missing.duplicatePlan.replacements).toEqual([])
      expect(missing.duplicatePlan.exclusions.map((item) => item.reason)).toEqual([
        "untrusted-source",
        "untrusted-source",
      ])

      for (const sourceKind of ["custom", "mcp", "provider"] as const) {
        yield* registerPair(ledger, sourceKind)
        const overwritten = yield* MessageV2.contextFoldingHistory({ messages, ledger })
        expect(overwritten.duplicatePlan.replacements).toEqual([])
        expect(overwritten.duplicatePlan.exclusions.every((item) => item.reason === "untrusted-source")).toBe(true)
      }
    }),
  )

  it.instance("rejects truncated and provider-executed candidates", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      yield* registerPair(ledger)
      const truncated = yield* MessageV2.contextFoldingHistory({ messages: conversation({ truncated: true }), ledger })
      expect(truncated.duplicatePlan.replacements).toEqual([])
      expect(truncated.duplicatePlan.exclusions.some((item) => item.reason === "incomplete-content")).toBe(true)

      const providerExecuted = yield* MessageV2.contextFoldingHistory({
        messages: conversation({ providerExecuted: true }),
        ledger,
      })
      expect(providerExecuted.duplicatePlan.replacements).toEqual([])
      expect(providerExecuted.duplicatePlan.exclusions.some((item) => item.reason === "provider-executed")).toBe(true)
    }),
  )

  it.instance("protects dynamic and unknown instruction-bearing results as both source and witness", () =>
    Effect.gen(function* () {
      const ledger = yield* ToolSourceLedger.Service
      yield* registerPair(ledger)

      for (const messages of [
        [
          assistant({
            messageID: "msg_source",
            partID: "prt_source",
            callID: "call_source",
            loaded: ["/workspace/AGENTS.md"],
          }),
          assistant({
            messageID: "msg_witness",
            partID: "prt_witness",
            callID: "call_witness",
            loaded: ["/workspace/AGENTS.md"],
          }),
        ],
        [
          assistant({
            messageID: "msg_source",
            partID: "prt_source",
            callID: "call_source",
            loaded: "unknown-shape",
          }),
          assistant({
            messageID: "msg_witness",
            partID: "prt_witness",
            callID: "call_witness",
            loaded: "unknown-shape",
          }),
        ],
      ]) {
        const result = yield* MessageV2.contextFoldingHistory({
          messages: [
            ...messages,
            ...Array.from({ length: 4 }, (_, index) =>
              assistant({ messageID: `msg_recent_${index}`, partID: `prt_recent_${index}` }),
            ),
          ],
          ledger,
        })
        expect(result.duplicatePlan.replacements).toEqual([])
        expect(result.duplicatePlan.exclusions.map((item) => item.reason)).toEqual([
          "instruction-content",
          "instruction-content",
        ])
      }
    }),
  )
})
