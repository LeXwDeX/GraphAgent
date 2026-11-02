import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Result, Schema } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { Agent } from "@/agent/agent"
import { DagAgentMessages } from "@/dag/agent-messages"
import { MessageID, SessionID } from "@/session/schema"
import { AgentTool, Parameters } from "@/tool/agent"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ProviderTransform } from "@/provider/transform"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content: string) => Effect.succeed({ content, truncated: false }),
    }),
  ),
)

function context(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_agent_actual"),
    messageID: MessageID.make("msg_agent_actual"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    ask: () => Effect.void,
    metadata: () => Effect.void,
  }
}

const send = {
  action: "send" as const,
  recipient: "node" as const,
  workflow_id: "wf_owned",
  node_id: "worker",
  attempt_id: "attempt_original",
  idempotency_key: "request_1",
  content: "Check the new finding",
}

describe("agent tool contract", () => {
  it.effect("redacts unknown flat argument names in repair logs", () =>
    Effect.gen(function* () {
      const definition = yield* (yield* AgentTool.pipe(Effect.provide(Layer.mock(DagAgentMessages.Service, {})))).init()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- exercise an untrusted flat tool call
      const result = yield* Effect.exit(definition.execute({ action: "receive", SYNTHETIC_KEY_SECRET: "synthetic-value" } as any, context()))
      expect(Exit.isFailure(result)).toBe(true)
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("tool arguments repaired")
      expect(logs).toContain("params:undefined->object")
      expect(logs).not.toContain("SYNTHETIC_KEY_SECRET")
      expect(logs).not.toContain("synthetic-value")
    }),
  )
  it.effect("handles each of the six recovered call shapes at the tool boundary", () =>
    Effect.gen(function* () {
      const service = Layer.mock(DagAgentMessages.Service, {
        receive: () => Effect.succeed({ ok: true, messages: [], cursor: 0 }),
        send: () => Effect.succeed({ ok: true }),
      })
      const definition = yield* (yield* AgentTool.pipe(Effect.provide(service))).init()
      const cases = [
        { params: { action: "send", recipient: "parent", idempotency_key: "k", content: "synthetic" } },
        { params: { action: "send", workflow_id: "", recipient: "parent", idempotency_key: "k", content: "synthetic" } },
        { params: { action: "send", workflow_id: "", recipient: "parent", idempotency_key: "k", content: "synthetic" } },
        { action: "receive", wait_ms: 0 },
        { action: "send", content: "synthetic", idempotency_key: "k", recipient: "parent", workflow_id: "wf" },
        { action: "receive", wait_ms: 0 },
      ]
      for (const [index, input] of cases.entries()) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test the real decoder with original unvalidated envelopes
        const result = yield* Effect.exit(definition.execute(input as any, context()))
        if (index < 3) {
          expect(Exit.isFailure(result)).toBe(true)
          const error = Exit.isFailure(result) ? String(Cause.squash(result.cause)) : ""
          expect(error).toContain("workflow_id")
          expect(error).not.toContain("synthetic")
          expect(error).not.toContain("\n")
          expect(error.length).toBeLessThanOrEqual(600)
        } else {
          expect(Exit.isSuccess(result)).toBe(true)
        }
      }
    }),
  )

  it.effect("does not echo unknown action or property names in validation errors", () =>
    Effect.gen(function* () {
      const definition = yield* (yield* AgentTool.pipe(Effect.provide(Layer.mock(DagAgentMessages.Service, {})))).init()
      for (const input of [
        { params: { action: "SECRET_ACTION\nvalue" } },
        { params: { action: "receive", SECRET_PROPERTY: "private" } },
      ]) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- exercise invalid model arguments through the actual tool boundary
        const result = yield* Effect.exit(definition.execute(input as any, context()))
        expect(Exit.isFailure(result)).toBe(true)
        const text = Exit.isFailure(result) ? String(Cause.squash(result.cause)) : ""
        expect(text).not.toContain("SECRET_")
        expect(text).not.toContain("private")
        expect(text).not.toContain("\n")
        expect(text).toContain("[\"params\"]")
        expect(text.length).toBeLessThan(600)
      }
    }),
  )

  test("has a plain object schema on Qwen, GLM and DeepSeek transports", () => {
    for (const modelID of ["qwen3.5-plus", "glm-5.3", "deepseek-v4-pro"]) {
      const modalities = { text: true, audio: false, image: false, video: false, pdf: false }
      const model: Provider.Model = {
        id: ModelV2.ID.make(modelID),
        providerID: ProviderV2.ID.make("local-proxy"),
        api: { id: modelID, npm: "@ai-sdk/openai-compatible", url: "http://localhost" },
        name: modelID,
        release_date: "2026-01-01",
        status: "active",
        options: {},
        headers: {},
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: modalities,
          output: modalities,
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 32768, output: 4096 },
      }
      const schema = ProviderTransform.schema(model, ToolJsonSchema.fromSchema(Parameters))
      expect(schema.type).toBe("object")
      expect(schema.anyOf).toBeUndefined()
      expect(schema.oneOf).toBeUndefined()
      expect(schema.allOf).toBeUndefined()
      expect(schema.properties).toHaveProperty("params")
      const wire = JSON.stringify(schema)
      expect(wire).not.toContain('"session_id"')
      expect(wire).not.toContain('"project_id"')
      expect(wire).not.toContain('"sender"')
    }
  })

  test("requires an exact attempt and retry key when sending to a node", () => {
    const decode = Schema.decodeUnknownResult(Parameters, { onExcessProperty: "error" })
    expect(Result.isSuccess(decode({ params: send }))).toBe(true)
    expect(Result.isSuccess(decode({ params: { ...send, attempt_id: undefined } }))).toBe(false)
    expect(Result.isSuccess(decode({ params: { ...send, idempotency_key: undefined } }))).toBe(false)
    expect(Result.isSuccess(decode({ params: { ...send, sessionID: "ses_impersonated" } }))).toBe(false)
    expect(Result.isSuccess(decode({ params: { ...send, recipient: "parent" } }))).toBe(false)
  })

  test("bounds receive waits, batches and message payloads without truncation", () => {
    const decode = Schema.decodeUnknownResult(Parameters)
    expect(Result.isSuccess(decode({ params: { action: "receive" } }))).toBe(true)
    for (const params of [
      { action: "receive", wait_ms: 30_001 },
      { action: "receive", limit: 51 },
      { action: "receive", after_sequence: -1 },
      { ...send, content: "x".repeat(16_385) },
      { ...send, content: "" },
    ])
      expect(Result.isSuccess(decode({ params }))).toBe(false)
  })

  it.effect("routes node questions to the parent and asks the parent for grounded answers", () =>
    Effect.gen(function* () {
      const tool = yield* AgentTool.pipe(Effect.provide(Layer.mock(DagAgentMessages.Service, {})))
      const { description } = yield* tool.init()
      expect(description).toContain("sends the question to its owning parent; nodes do not ask the user")
      expect(description).toContain("reply_to its message with a conclusion you can stand behind")
      expect(description).toContain("never present a guess as settled")
    }),
  )

  it.effect("passes trusted session and exact destination through to durable acceptance", () =>
    Effect.gen(function* () {
      let received: Parameters<DagAgentMessages.Interface["send"]>[0] | undefined
      const service = Layer.mock(DagAgentMessages.Service, {
        send: (input) =>
          Effect.sync(() => {
            received = input
            return { state: "queued", message_id: "message_stable" }
          }),
      })
      const tool = yield* AgentTool.pipe(Effect.provide(service))
      const definition = yield* tool.init()
      const result = yield* definition.execute({ params: send }, context())
      expect(received?.sessionID).toBe("ses_agent_actual")
      expect(received?.attempt_id).toBe("attempt_original")
      expect(JSON.parse(result.output).state).toBe("queued")
      expect(result.output).not.toContain("delivered")
    }),
  )

  it.effect("receive forwards cancellation and returns records without delivery acknowledgement", () =>
    Effect.gen(function* () {
      const ctx = context()
      let signal: AbortSignal | undefined
      const service = Layer.mock(DagAgentMessages.Service, {
        receive: (input) =>
          Effect.sync(() => {
            signal = input.signal
            return { messages: [{ message_id: "message_stable", state: "queued" }], cursor: 1 }
          }),
      })
      const tool = yield* AgentTool.pipe(Effect.provide(service))
      const definition = yield* tool.init()
      const result = yield* definition.execute({ params: { action: "receive", wait_ms: 10 } }, ctx)
      expect(signal).toBe(ctx.abort)
      expect(JSON.parse(result.output).messages[0].state).toBe("queued")
    }),
  )

  it.effect("accepts flat envelopes and preserves JSON-looking scalar fields", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      let sentContent: string | undefined
      let sentKey: string | undefined
      let observedCursor: string | undefined
      const service = Layer.mock(DagAgentMessages.Service, {
        receive: (input) =>
          Effect.sync(() => {
            calls.push(`receive:${input.sessionID}:${input.workflow_id ?? ""}`)
            return { ok: true, messages: [], cursor: 0 }
          }),
        send: (input) =>
          Effect.sync(() => {
            calls.push(`send:${input.sessionID}:${input.workflow_id}`)
            sentContent = input.content
            sentKey = input.idempotency_key
            return { ok: true, message_id: "message_flat" }
          }),
        observe: (input) =>
          Effect.sync(() => {
            calls.push(`observe:${input.workflow_id}`)
            observedCursor = input.cursor
            return { ok: true, nodes: [] }
          }),
      })
      const tool = yield* AgentTool.pipe(Effect.provide(service))
      const definition = yield* tool.init()
      const ctx = context()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- flat envelope and rejection fixtures intentionally bypass the decoded parameter type
      const received = yield* definition.execute({ action: "receive", wait_ms: 0 } as any, ctx)
      const sent = yield* definition.execute(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- flat envelope and rejection fixtures intentionally bypass the decoded parameter type
        {
          action: "send",
          workflow_id: "wf_owned",
          recipient: "parent",
          idempotency_key: '{"key":1}',
          content: '{"approval":true}',
        } as any,
        ctx,
      )
      const observed = yield* definition.execute(
        {
          params: {
            action: "observe",
            workflow_id: "wf_owned",
            cursor: '{"workflowID":"wf_owned"}',
          },
        },
        ctx,
      )
      const stringified = yield* definition.execute(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- provider stringified-container compatibility
        { params: '{"action":"receive","wait_ms":0}' } as any,
        ctx,
      )
      expect(JSON.parse(received.output).ok).toBe(true)
      expect(JSON.parse(sent.output).ok).toBe(true)
      expect(JSON.parse(observed.output).ok).toBe(true)
      expect(JSON.parse(stringified.output).ok).toBe(true)
      expect(sentContent).toBe('{"approval":true}')
      expect(sentKey).toBe('{"key":1}')
      expect(observedCursor).toBe('{"workflowID":"wf_owned"}')
      expect(calls).toEqual([
        "receive:ses_agent_actual:",
        "send:ses_agent_actual:wf_owned",
        "observe:wf_owned",
        "receive:ses_agent_actual:",
      ])
    }),
  )

  it.effect("returns bounded actionable errors for missing or empty send workflow ids", () =>
    Effect.gen(function* () {
      const tool = yield* AgentTool.pipe(Effect.provide(Layer.mock(DagAgentMessages.Service, {})))
      const definition = yield* tool.init()
      for (const params of [
        { action: "send", workflow_id: "", recipient: "parent", idempotency_key: "k", content: "c" },
        { action: "send", recipient: "parent", idempotency_key: "k", content: "c" },
      ]) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- flat envelope and rejection fixtures intentionally bypass the decoded parameter type
        const exit = yield* Effect.exit(definition.execute({ params } as any, context()))
        expect(Exit.isFailure(exit)).toBe(true)
        const message = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : ""
        expect(message).toContain("workflow_id")
        expect(message.length).toBeLessThan(600)
      }
    }),
  )

  it.effect("bounds schema errors for out-of-range receive fields", () =>
    Effect.gen(function* () {
      const tool = yield* AgentTool.pipe(Effect.provide(Layer.mock(DagAgentMessages.Service, {})))
      const definition = yield* tool.init()
      for (const params of [
        { action: "receive", wait_ms: 60_000 },
        { action: "receive", limit: 51 },
      ]) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- flat envelope and rejection fixtures intentionally bypass the decoded parameter type
        const exit = yield* Effect.exit(definition.execute({ params } as any, context()))
        expect(Exit.isFailure(exit)).toBe(true)
        const message = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : ""
        expect(message).toMatch(/wait_ms|limit/)
        expect(message.length).toBeLessThan(600)
      }
    }),
  )

  it.effect("preserves the rate-limited receive response shape", () =>
    Effect.gen(function* () {
      const service = Layer.mock(DagAgentMessages.Service, {
        receive: () =>
          Effect.succeed({
            ok: false,
            reason: "rate_limited",
            retry_after_ms: 900,
            read_performed: false,
            hint: "This request did not check for new messages. Retry with the original cursor.",
          }),
      })
      const tool = yield* AgentTool.pipe(Effect.provide(service))
      const definition = yield* tool.init()
      const result = yield* definition.execute(
        { params: { action: "receive", workflow_id: "wf_owned", after_sequence: 7 } },
        context(),
      )
      expect(JSON.parse(result.output)).toMatchObject({
        ok: false,
        reason: "rate_limited",
        retry_after_ms: 900,
        read_performed: false,
      })
      expect(JSON.parse(result.output)).not.toHaveProperty("messages")
      expect(JSON.parse(result.output)).not.toHaveProperty("cursor")
    }),
  )

  it.effect("returns an actionable error for observe without a workflow id", () =>
    Effect.gen(function* () {
      const tool = yield* AgentTool.pipe(Effect.provide(Layer.mock(DagAgentMessages.Service, {})))
      const definition = yield* tool.init()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- flat envelope and rejection fixtures intentionally bypass the decoded parameter type
      const exit = yield* Effect.exit(definition.execute({ params: { action: "observe" } } as any, context()))
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : ""
      expect(message).toContain("agent observe")
      expect(message).toContain("workflow_id")
      expect(message.length).toBeLessThan(600)
    }),
  )
})
