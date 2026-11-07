import { describe, expect } from "bun:test"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { clearCaptureSlot, registerCaptureSlot } from "@/dag/runtime/capture"
import { MessageID } from "@/session/schema"
import { SubmitResultTool } from "@/tool/submit_result"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
        }),
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
    }),
  ),
)
const sessionID = "ses_submit_result" as never

function context(): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("submit_result", () => {
  it.effect("captures a provider-stringified JSON object as structured output", () =>
    Effect.gen(function* () {
      const captured: unknown[] = []
      const store = Layer.mock(DagStore.Service, {
        setCapturedOutput: (_childSessionID: string, payload: unknown) =>
          Effect.sync(() => {
            captured.push(payload)
          }),
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => registerCaptureSlot(sessionID, { type: "object", required: ["verdict"] })),
        () => Effect.sync(() => clearCaptureSlot(sessionID)),
      )
      const tool = yield* SubmitResultTool
      const definition = yield* tool.init()
      const result = yield* definition
        .execute({ payload: JSON.stringify({ verdict: "REVISE" }) }, context())
        .pipe(Effect.provide(store))

      expect(result.title).toBe("Structured output submitted")
      expect(captured).toEqual([{ verdict: "REVISE" }])
    }),
  )

  it.effect("preserves JSON-looking text when the output schema requires a string", () =>
    Effect.gen(function* () {
      const captured: unknown[] = []
      const store = Layer.mock(DagStore.Service, {
        setCapturedOutput: (_childSessionID: string, payload: unknown) =>
          Effect.sync(() => {
            captured.push(payload)
          }),
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => registerCaptureSlot(sessionID, { type: "string" })),
        () => Effect.sync(() => clearCaptureSlot(sessionID)),
      )
      const tool = yield* SubmitResultTool
      const definition = yield* tool.init()
      const payload = JSON.stringify({ verdict: "ACCEPT" })
      const result = yield* definition.execute({ payload }, context()).pipe(Effect.provide(store))

      expect(result.title).toBe("Structured output submitted")
      expect(captured).toEqual([payload])
    }),
  )

  it.effect("rejects malformed JSON text for an object output schema", () =>
    Effect.gen(function* () {
      const captured: unknown[] = []
      const store = Layer.mock(DagStore.Service, {
        setCapturedOutput: (_childSessionID: string, payload: unknown) =>
          Effect.sync(() => {
            captured.push(payload)
          }),
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => registerCaptureSlot(sessionID, { type: "object" })),
        () => Effect.sync(() => clearCaptureSlot(sessionID)),
      )
      const tool = yield* SubmitResultTool
      const definition = yield* tool.init()
      const result = yield* definition.execute({ payload: "{not-json" }, context()).pipe(Effect.provide(store))

      expect(result.title).toBe("submit_result validation failed")
      expect(result.output).toContain('expected type "object", got string')
      expect(captured).toEqual([])
    }),
  )
})
