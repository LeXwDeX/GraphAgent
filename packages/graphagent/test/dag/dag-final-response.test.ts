// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded IDs and narrow Effect service mocks exercise only the runtime surface used by these tests.
import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import {
  captureFinalResponse,
  correctionPrompt,
  finalAssistantText,
  outputLimitReason,
  parseFinalResponse,
  repairPrompt,
} from "@/dag/runtime/final-response"
import { closeCaptureSlot, createCaptureSlot } from "@/dag/runtime/capture"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { continueRecoveredMessageNode, makeLastAssistantMessageReader, reconcileWorkflow } from "@/dag/runtime/recovery"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { makeNodeRow } from "./fixtures"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt, mockSessionPromptWithStub } from "../lib/child-runs"

/** The per-workflow child-run schedule the loop hands to `spawnNode`. */
const spawnSchedule = <T extends { readonly dagID: string }>(input: T, cap: number) => ({
  limit: { kind: "workflow" as const, workflowID: input.dagID },
  cap,
})

function assistant(
  parts: Array<Partial<SessionV1.TextPart>>,
  finish = "stop",
  output = 0,
  reasoning = 0,
): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: "ses_final_child" as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish,
    },
    parts: parts.map((part) => ({ type: "text", text: "", ...part })) as SessionV1.TextPart[],
  }
}

describe("final assistant response", () => {
  it("joins visible parts exactly and rejects an intermediate tool-call turn", () => {
    const final = assistant([
      { text: '{"status":' },
      { text: "ignored", synthetic: true },
      { text: '"ok"}' },
      { text: "ignored", ignored: true },
    ])
    expect(finalAssistantText(final)).toEqual({ ok: true, text: '{"status":"ok"}' })
    expect(finalAssistantText(assistant([{ text: "old result" }], "tool-calls")).ok).toBe(false)
    expect(finalAssistantText(assistant([{ text: "truncated" }], "length")).ok).toBe(false)
    expect(outputLimitReason({ cap: 32_000, output: 885, reasoning: 31_115, continued: true })).toContain(
      "reasoning 31115, text 885",
    )
    expect(parseFinalResponse('{"status":"ok"}\nextra').ok).toBe(false)
    expect(parseFinalResponse("null")).toEqual({ ok: true, payload: null })
  })

  it("recovery reads the latest message only", async () => {
    const old = assistant([{ text: "old" }])
    const latest = assistant([{ text: "partial" }], "tool-calls")
    const reader = makeLastAssistantMessageReader({
      messages: () => Effect.succeed([old, latest]),
    } as unknown as Session.Interface)
    const found = await Effect.runPromise(reader("ses_final_child"))
    expect(found?.info.id).toBe(latest.info.id)
    expect(finalAssistantText(found).ok).toBe(false)
  })
})

describe("outputLimitReason", () => {
  const raise = "Raise this model's limit.output or GRAPHAGENT_OUTPUT_TOKEN_MAX, or use a lower reasoning variant."
  const declare =
    "No limit.output is known for this model, so the request may have carried no cap and the provider's own default limit applied. Declare limit.output (or set GRAPHAGENT_OUTPUT_TOKEN_MAX) so requests carry an explicit cap, or use a lower reasoning variant."

  for (const cap of [8192, 384_000])
    it(`puts a known cap of ${cap} in the parentheses and asks to raise the limit`, () => {
      expect(outputLimitReason({ cap, output: 885, reasoning: 31_115, continued: false })).toBe(
        `child turn hit the output token cap (${cap}; reasoning 31115, text 885). ${raise}`,
      )
    })

  it("adds the continuation suffix only when the turn was continued", () => {
    expect(outputLimitReason({ cap: 8192, output: 1, reasoning: 2, continued: true })).toBe(
      `child turn hit the output token cap (8192; reasoning 2, text 1) after one continuation. ${raise}`,
    )
    expect(outputLimitReason({ cap: undefined, output: 1, reasoning: 2, continued: true })).toBe(
      `child turn hit the output token cap (unknown; reasoning 2, text 1) after one continuation. ${declare}`,
    )
  })

  it("says the cap is unknown, and why, when the request carried none", () => {
    const reason = outputLimitReason({ cap: undefined, output: 885, reasoning: 31_115, continued: false })
    expect(reason).toBe(`child turn hit the output token cap (unknown; reasoning 31115, text 885). ${declare}`)
    // There is no configured limit to name: the provider's own default ended the turn.
    expect(reason).not.toContain("configured")
    expect(reason).not.toContain("Raise this model's limit.output")
  })
})

describe("correctionPrompt", () => {
  it("keeps the field-level prompt for a near-miss and quotes the detail for every other schema failure", () => {
    const fix = { kind: "enum", path: "verdict", allowed: '["ACCEPT","REJECT"]', got: '"PASS"' } as const
    expect(correctionPrompt({ fix, repairDetail: "ignored when there is a fix" })).toBe(repairPrompt(fix))
    expect(correctionPrompt({ repairDetail: 'missing required field: "summary"' })).toBe(
      'Your final response was rejected: missing required field: "summary". Do not redo the work. Resubmit the same result as exactly one JSON value, with no Markdown fence and no surrounding prose.',
    )
  })

  it("has no prompt for a failure that is not the model's to correct", () => {
    expect(correctionPrompt({})).toBeUndefined()
  })
})

describe("captureFinalResponse failure classification", () => {
  const store = { setCapturedOutput: () => Effect.void } as unknown as DagStore.Interface
  const capture = (message: SessionV1.WithParts, schema: Record<string, unknown>, closed = false) => {
    const slot = createCaptureSlot(schema)
    if (closed) closeCaptureSlot(slot)
    return Effect.runPromise(captureFinalResponse({ store, sessionID: "ses_final_child", slot, message }))
  }

  it("marks a fenced or prefixed response as schema_invalid with a parse detail", async () => {
    const failed = await capture(assistant([{ text: '```json\n{"ok":true}\n```' }]), { type: "object" })
    expect(failed).toMatchObject({
      ok: false,
      schemaInvalid: true,
      repairDetail: "the final response is not exactly one JSON value",
    })
    expect(failed.ok || failed.fix).toBeFalsy()
  })

  it("marks a schema rejection as schema_invalid and carries the validator message as the detail", async () => {
    const failed = await capture(assistant([{ text: "{}" }]), { type: "object", required: ["summary"] })
    expect(failed).toMatchObject({ ok: false, schemaInvalid: true, repairDetail: 'missing required field: "summary"' })
    expect(failed.ok ? undefined : failed.reason).toBe(
      'final response schema validation failed: missing required field: "summary"',
    )
  })

  it("keeps the near-miss fix beside the detail", async () => {
    const failed = await capture(assistant([{ text: '{"verdict":"PASS"}' }]), {
      type: "object",
      properties: { verdict: { enum: ["ACCEPT", "REJECT"] } },
    })
    expect(failed).toMatchObject({ ok: false, schemaInvalid: true, fix: { kind: "enum", path: "verdict" } })
    expect(failed.ok ? undefined : failed.repairDetail).toContain("expected one of")
  })

  it("cuts a long detail to 400 code units", async () => {
    const key = "k".repeat(1_000)
    const failed = await capture(assistant([{ text: JSON.stringify({ [key]: 1 }) }]), {
      type: "object",
      additionalProperties: false,
    })
    const detail = failed.ok ? "" : (failed.repairDetail ?? "")
    expect(detail).toHaveLength(400)
    expect(detail.startsWith('unexpected additional property: "kkk')).toBe(true)
  })

  it("never splits a surrogate pair when it cuts the detail", async () => {
    // The prefix is 33 code units, so the 400th unit falls inside the 184th emoji.
    const key = "\u{1F600}".repeat(300)
    const failed = await capture(assistant([{ text: JSON.stringify({ [key]: 1 }) }]), {
      type: "object",
      additionalProperties: false,
    })
    const detail = failed.ok ? "" : (failed.repairDetail ?? "")
    expect(detail).toHaveLength(399)
    expect(detail.endsWith("\u{1F600}")).toBe(true)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(detail)).toBe(false)
  })

  it("does not classify empty output or an abnormal turn as schema_invalid", async () => {
    const empty = await capture(assistant([{ text: " " }]), { type: "object" })
    expect(empty).toEqual({ ok: false, reason: "provider returned empty output", code: undefined })
    const abnormal = await capture(assistant([{ text: "{}" }], "tool-calls"), { type: "object" })
    expect(abnormal).toEqual({
      ok: false,
      reason: "child model turn did not end normally (tool-calls)",
      code: undefined,
    })
    const errored = await capture(
      { info: { ...assistant([]).info, error: { name: "UnknownError", data: { message: "boom" } } }, parts: [] } as never,
      { type: "object" },
    )
    expect(errored).toEqual({ ok: false, reason: "child model turn stopped before a successful result", code: undefined })
  })

  it("does not classify a closed capture slot as schema_invalid", async () => {
    const failed = await capture(assistant([{ text: "{}" }]), { type: "object" }, true)
    expect(failed).toEqual({ ok: false, reason: "final response schema validation failed: capture slot is closed" })
    expect(correctionPrompt(failed.ok ? {} : failed)).toBeUndefined()
  })
})

describe("spawn final-response protocol", () => {
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        model: { providerID: "test" as never, modelID: "test-model" as never },
        tools: {},
        hooks: {},
      }),
  })
  const sessions = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
    create: () => Effect.succeed({ id: "ses_final_child" as never } as never),
  })

  /** `limits` are the model's output limit in the catalog (0 is unknown) and the one a config file declares for it. */
  async function run(
    messages: SessionV1.WithParts | SessionV1.WithParts[],
    schema?: Record<string, unknown>,
    limits: { catalog: number; configured?: number } = { catalog: 384_000, configured: 384_000 },
  ) {
    const queue = Array.isArray(messages) ? [...messages] : [messages]
    const events: Array<{ type: string; output?: unknown; reason?: string }> = []
    let receipt: { present: boolean; value: unknown } | undefined
    let prompts = 0
    const promptSessions: string[] = []
    const store = {
      getNode: () =>
        Effect.succeed({
          ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
          capturedOutput: receipt?.value,
          capturedOutputPresent: receipt?.present,
        }),
      getWorkflow: () => Effect.succeed({ status: "running", directory: process.cwd() }),
      setCapturedOutput: (_sessionID: string, value: unknown) =>
        Effect.sync(() => {
          receipt = { present: true, value }
        }),
    } as unknown as DagStore.Interface
    const dag = Layer.mock(Dag.Service, {
      store,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.void,
      nodeCompleted: (_dagID: string, _nodeID: string, output: unknown) =>
        Effect.sync(() => {
          events.push({ type: "completed", output })
        }),
      nodeFailed: (_dagID: string, _nodeID: string, reason: string) =>
        Effect.sync(() => {
          events.push({ type: "failed", reason })
        }),
    })
    const prompt = mockSessionPrompt({
      prompt: (input) =>
        Effect.sync(() => {
          prompts++
          promptSessions.push(input.sessionID)
          return queue.length > 1 ? queue.shift()! : queue[0]
        }),
    })
    const provider = Layer.mock(Provider.Service, {
      getModel: () =>
        Effect.succeed({
          id: "test-model",
          providerID: "test",
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
          limit: { context: 128_000, output: limits.catalog },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        } as never),
    })
    const config = Layer.mock(Config.Service, {
      get: () =>
        Effect.succeed({
          provider: {
            test: {
              models: {
                "test-model": {
                  limit: {
                    context: 128_000,
                    ...(limits.configured === undefined ? {} : { output: limits.configured }),
                  },
                },
              },
            },
          },
        } as never),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input: NodeSpawnInput = {
            dagID: "wf",
            nodeID: "n",
            node: makeNodeRow({ id: "n" }),
            parentSessionID: "ses_parent",
            promptParts: [{ type: "text", text: "work" }],
            outputSchema: schema,
          }
          const result = yield* spawnNode(spawnSchedule(input, 1), input)
          yield* Fiber.await(result.fiber)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              dag,
              agent,
              sessions,
              prompt,
              provider,
              config,
              RuntimeFlags.layer({}),
              AgentScheduler.defaultLayer,
            ),
          ),
        ),
      ) as Effect.Effect<never>,
    )
    return { events, receipt, prompts, promptSessions }
  }

  it("captures a null JSON result as present without a tool call", async () => {
    const result = await run(assistant([{ text: "null" }]), { type: "null" })
    expect(result.events).toEqual([{ type: "completed", output: null }])
    expect(result.receipt).toEqual({ present: true, value: null })
    expect(result.prompts).toBe(1)
  })

  for (const [raw, schema, value] of [
    ["false", { type: "boolean" }, false],
    ["0", { type: "number" }, 0],
  ] as const) {
    it(`captures ${raw} without losing presence`, async () => {
      const result = await run(assistant([{ text: raw }]), schema)
      expect(result.events).toEqual([{ type: "completed", output: value }])
      expect(result.receipt).toEqual({ present: true, value })
    })
  }

  it("decodes a JSON string value under a string schema", async () => {
    const result = await run(assistant([{ text: JSON.stringify("done") }]), { type: "string" })
    expect(result.events).toEqual([{ type: "completed", output: "done" }])
    expect(result.receipt).toEqual({ present: true, value: "done" })
  })

  it("captures a JSON-shaped string as string data under a string schema", async () => {
    const output = '{"verdict":"FAIL"}'
    const result = await run(assistant([{ text: JSON.stringify(output) }]), { type: "string" })
    expect(result.events).toEqual([{ type: "completed", output }])
    expect(result.receipt).toEqual({ present: true, value: output })
  })

  it("captures a JSON string under a nullable string schema", async () => {
    const output = '{"verdict":"FAIL"}'
    const result = await run(assistant([{ text: JSON.stringify(output) }]), { type: ["string", "null"] })
    expect(result.events).toEqual([{ type: "completed", output }])
    expect(result.receipt).toEqual({ present: true, value: output })
  })

  it("rejects a JSON object under a string schema", async () => {
    const result = await run(assistant([{ text: '{"verdict":"FAIL"}' }]), { type: "string" })
    expect(result.events[0]?.type).toBe("failed")
    expect(result.events[0]?.reason).toContain('expected type "string", got object')
    expect(result.receipt).toBeUndefined()
  })

  it("rejects prose around JSON after one correction turn and never asks for a legacy tool nudge", async () => {
    const result = await run(assistant([{ text: 'Here: {"ok":true}' }]), { type: "object" })
    expect(result.events[0]?.type).toBe("failed")
    expect(result.events[0]?.reason).toContain("one JSON value")
    // The original turn and exactly one correction turn, both in the child session.
    expect(result.prompts).toBe(2)
    expect(result.promptSessions).toEqual(["ses_final_child", "ses_final_child"])
  })

  it("accepts the corrected final response of the one correction turn", async () => {
    const result = await run([assistant([{ text: 'Here: {"ok":true}' }]), assistant([{ text: '{"ok":true}' }])], {
      type: "object",
    })
    expect(result.events).toEqual([{ type: "completed", output: { ok: true } }])
    expect(result.receipt).toEqual({ present: true, value: { ok: true } })
    expect(result.prompts).toBe(2)
  })

  it("preserves every plaintext part for a node without a schema", async () => {
    const result = await run(assistant([{ text: "first " }, { text: "second" }]))
    expect(result.events).toEqual([{ type: "completed", output: "first second" }])
  })

  it("continues once in the same child session when the final turn hits the output cap", async () => {
    const result = await run([assistant([{ text: "" }], "length", 885, 31_115), assistant([{ text: '{"ok":true}' }])], {
      type: "object",
    })
    expect(result.events).toEqual([{ type: "completed", output: { ok: true } }])
    expect(result.prompts).toBe(2)
    expect(result.promptSessions).toEqual(["ses_final_child", "ses_final_child"])
  })

  it("continues a plaintext final response that hit the output cap", async () => {
    const result = await run([assistant([{ text: "" }], "length", 885, 31_115), assistant([{ text: "final answer" }])])
    expect(result.events).toEqual([{ type: "completed", output: "final answer" }])
    expect(result.prompts).toBe(2)
  })

  it("fails with the cap and reasoning/text split when the continuation still ends in length", async () => {
    const result = await run(
      [assistant([{ text: "" }], "length", 885, 31_115), assistant([{ text: "" }], "length", 885, 31_115)],
      { type: "object" },
    )
    expect(result.events[0]?.type).toBe("failed")
    expect(result.events[0]?.reason).toContain("output token cap (384000; reasoning 31115, text 885)")
    expect(result.events[0]?.reason).toContain("limit.output")
    expect(result.events[0]?.reason).toContain("GRAPHAGENT_OUTPUT_TOKEN_MAX")
  })

  it("says the cap is unknown when a non-Anthropic model has no output limit and the request carried none", async () => {
    // No catalog limit, no configured one and no environment override: `requestOutputCap` gives the spawn no cap.
    const result = await run(
      [assistant([{ text: "" }], "length", 885, 31_115), assistant([{ text: "" }], "length", 885, 31_115)],
      { type: "object" },
      { catalog: 0 },
    )
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe("failed")
    const reason = result.events[0]?.reason ?? ""
    expect(reason).toContain(
      "output token cap (unknown; reasoning 31115, text 885) after one continuation. No limit.output is known for this model",
    )
    expect(reason).toContain("the provider's own default limit applied")
    expect(reason).toContain("Declare limit.output (or set GRAPHAGENT_OUTPUT_TOKEN_MAX)")
    expect(reason).not.toContain("configured")
  })
})

describe("recovered final-response settlement", () => {
  it("continues a live child transcript and settles its current structured final turn", async () => {
    const message = assistant([{ text: "false" }])
    const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
    const writes: Array<{ value: unknown; snapshotID?: string }> = []
    const completions: Array<{ output: unknown; snapshotID?: string }> = []
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNode: () => Effect.succeed(node),
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({
            sessionId: "ses_parent",
            status: "running",
            projectId: "project",
            directory: process.cwd(),
          } as never),
        setCapturedOutput: (_sessionID: string, value: unknown, snapshotID?: string) =>
          Effect.sync(() => {
            writes.push({ value, snapshotID })
          }),
      } as unknown as DagStore.Interface,
      nodeCompleted: (_dagID, _nodeID, output, attempt) =>
        Effect.sync(() => {
          completions.push({ output, snapshotID: attempt?.inputSnapshotID })
        }),
    })
    const { layer: prompt, stub } = mockSessionPromptWithStub({
      loop: () => Effect.succeed(message),
    })
    // A recovered attempt adopts the existing child session: the previous run
    // has ended, so this is a new episode, not a new child.
    stub.latest = {
      id: "crun_previous",
      childSessionID: SessionID.make("ses_final_child"),
      parentSessionID: SessionID.make("ses_parent"),
      ownerKind: "dag_node",
      state: "ended",
      attempt: 1,
      detached: false,
      timeCreated: 0,
    }
    const messages = Layer.mock(DagMessages.Service, {
      latestSnapshot: () => Effect.succeed({ ok: true, value: undefined } as never),
      snapshotForTurn: (_caller, turnID) =>
        Effect.sync(() => {
          expect(turnID).toBe(message.info.id)
          return { ok: true, value: { id: "snap-current" } } as never
        }),
      guard: (_caller, input, commit) =>
        Effect.gen(function* () {
          expect(input.snapshotID).toBe("snap-current")
          return { ok: true, value: yield* commit } as const
        }),
    })
    await Effect.runPromise(
      continueRecoveredMessageNode("wf", "n", {
        nodes: [{ id: "n", output_schema: { type: "boolean" } }],
      }).pipe(Effect.provide(Layer.mergeAll(dag, prompt, messages))),
    )
    expect(stub.runs.map((entry) => entry.via)).toEqual(["adopt"])
    expect(stub.settled[0]?.outcome).toEqual({ type: "completed" })
    expect(writes).toEqual([{ value: false, snapshotID: "snap-current" }])
    expect(completions).toEqual([{ output: false, snapshotID: "snap-current" }])
  })

  // Recovery settles the one final turn it adopts and never adds a correction turn: an unparseable response is
  // still `schema_invalid`, empty output is not.
  for (const [label, text, errorClass] of [
    ["empty output", "", undefined],
    ["an unparseable response", "not one JSON value", "schema_invalid"],
  ] as const)
    it(`classifies ${label} of a recovered structured final turn without a correction turn`, async () => {
      const message = assistant([{ text }])
      const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
      const failures: Array<{ reason: string; trigger?: string; errorClass?: string }> = []
      const dag = Layer.mock(Dag.Service, {
        store: {
          getNode: () => Effect.succeed(node),
          getNodes: () => Effect.succeed([node]),
          getWorkflow: () =>
            Effect.succeed({
              sessionId: "ses_parent",
              status: "running",
              projectId: "project",
              directory: process.cwd(),
            } as never),
          setCapturedOutput: () => Effect.void,
        } as unknown as DagStore.Interface,
        nodeFailed: (_dagID, _nodeID, reason, trigger, _attempt, errorClass) =>
          Effect.sync(() => {
            failures.push({ reason, trigger, errorClass })
          }),
      })
      let turns = 0
      const { layer: prompt, stub } = mockSessionPromptWithStub({
        loop: () =>
          Effect.sync(() => {
            turns++
            return message
          }),
      })
      stub.latest = {
        id: "crun_previous",
        childSessionID: SessionID.make("ses_final_child"),
        parentSessionID: SessionID.make("ses_parent"),
        ownerKind: "dag_node",
        state: "ended",
        attempt: 1,
        detached: false,
        timeCreated: 0,
      }
      const messages = Layer.mock(DagMessages.Service, {
        latestSnapshot: () => Effect.succeed({ ok: true, value: undefined } as never),
        snapshotForTurn: () => Effect.succeed({ ok: true, value: { id: "snap-current" } } as never),
        guard: (_caller, _input, commit) =>
          Effect.gen(function* () {
            return { ok: true, value: yield* commit } as const
          }),
      })
      await Effect.runPromise(
        continueRecoveredMessageNode("wf", "n", {
          nodes: [{ id: "n", output_schema: { type: "object" } }],
        }).pipe(Effect.provide(Layer.mergeAll(dag, prompt, messages))),
      )
      expect(turns).toBe(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ trigger: "verdict_fail" })
      expect(failures[0]?.errorClass).toBe(errorClass)
    })

  it("fails the node when the existing child session belongs to another run", async () => {
    const failed: string[] = []
    const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNode: () => Effect.succeed(node),
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({
            sessionId: "ses_parent",
            status: "running",
            projectId: "project",
            directory: process.cwd(),
          } as never),
      } as unknown as DagStore.Interface,
      nodeFailed: (_dagID, _nodeID, reason) =>
        Effect.sync(() => {
          failed.push(reason)
        }),
    })
    const { layer: prompt, stub } = mockSessionPromptWithStub({
      loop: () => Effect.die(new Error("must not drive a session owned by another run")),
    })
    stub.latest = {
      id: "crun_other",
      childSessionID: SessionID.make("ses_final_child"),
      parentSessionID: SessionID.make("ses_parent"),
      ownerKind: "dag_node",
      state: "ended",
      attempt: 1,
      detached: false,
      timeCreated: 0,
    }
    stub.adoptError = "not-owner"
    const messages = Layer.mock(DagMessages.Service, {
      latestSnapshot: () => Effect.succeed({ ok: true, value: undefined } as never),
    })

    await Effect.runPromise(
      continueRecoveredMessageNode("wf", "n", { nodes: [{ id: "n" }] }).pipe(
        Effect.provide(Layer.mergeAll(dag, prompt, messages)),
      ),
    )

    expect(stub.runs).toHaveLength(0)
    expect(failed[0]).toContain("owned by another run")
  })

  it("leaves the attempt to its driver when run registration races", async () => {
    const failed: string[] = []
    const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNode: () => Effect.succeed(node),
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({
            sessionId: "ses_parent",
            status: "running",
            projectId: "project",
            directory: process.cwd(),
          } as never),
      } as unknown as DagStore.Interface,
      nodeFailed: (_dagID, _nodeID, reason) =>
        Effect.sync(() => {
          failed.push(reason)
        }),
    })
    const { layer: prompt, stub } = mockSessionPromptWithStub({
      loop: () => Effect.die(new Error("must not drive a session another run owns")),
    })
    // No prior run: recovery uses `start`, which loses a concurrent
    // registration as a defect (unique constraint or the registry's guard).
    stub.registrationDefect = new Error("UNIQUE constraint failed: child_binding.child_session_id")
    const messages = Layer.mock(DagMessages.Service, {
      latestSnapshot: () => Effect.succeed({ ok: true, value: undefined } as never),
    })

    await Effect.runPromise(
      continueRecoveredMessageNode("wf", "n", { nodes: [{ id: "n" }] }).pipe(
        Effect.provide(Layer.mergeAll(dag, prompt, messages)),
      ),
    )

    expect(stub.runs).toHaveLength(0)
    // A lost registration is a concurrent driver, never a node failure.
    expect(failed).toEqual([])
  })

  it("settles the adopted run as an error when the isolated worktree cannot be completed", async () => {
    const message = assistant([{ text: "done" }])
    // An active worktree with no Worktree service in the layer: recovery
    // refuses to finish the node, and the run must follow that failure.
    const node = makeNodeRow({
      id: "n",
      status: "running",
      childSessionId: "ses_final_child",
      worktreeDirectory: "/tmp/dag-nonexistent-worktree",
      worktreeState: "active",
    })
    const failed: string[] = []
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNode: () => Effect.succeed(node),
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({
            sessionId: "ses_parent",
            status: "running",
            projectId: "project",
            directory: process.cwd(),
          } as never),
        setCapturedOutput: () => Effect.void,
      } as unknown as DagStore.Interface,
      nodeFailed: (_dagID, _nodeID, reason) =>
        Effect.sync(() => {
          failed.push(reason)
        }),
      nodeCompleted: () => Effect.die(new Error("must not complete an unfinished worktree")),
    })
    const { layer: prompt, stub } = mockSessionPromptWithStub({
      loop: () => Effect.succeed(message),
    })
    stub.latest = {
      id: "crun_previous",
      childSessionID: SessionID.make("ses_final_child"),
      parentSessionID: SessionID.make("ses_parent"),
      ownerKind: "dag_node",
      state: "ended",
      attempt: 1,
      detached: false,
      timeCreated: 0,
    }
    const messages = Layer.mock(DagMessages.Service, {
      latestSnapshot: () => Effect.succeed({ ok: true, value: undefined } as never),
      snapshotForTurn: () => Effect.succeed({ ok: true, value: undefined } as never),
    })

    await Effect.runPromise(
      continueRecoveredMessageNode("wf", "n", { nodes: [{ id: "n" }] }).pipe(
        Effect.provide(Layer.mergeAll(dag, prompt, messages)),
      ),
    )

    expect(failed[0]).toContain("worktree completion failed")
    expect(stub.settled[0]?.outcome).toMatchObject({ type: "error" })
  })

  it("binds recovered plaintext completion to its final message snapshot when mailbox revisions exist", async () => {
    const message = assistant([{ text: "first " }, { text: "second" }])
    let completed: { output: unknown; snapshotID?: string } | undefined
    let frozenTurn: string | undefined
    const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({ sessionId: "ses_parent", projectId: "project", directory: process.cwd() } as never),
      } as unknown as DagStore.Interface,
      nodeCompleted: (_dagID, _nodeID, output, attempt) =>
        Effect.sync(() => {
          completed = { output, snapshotID: attempt?.inputSnapshotID }
        }),
    })
    const messages = Layer.mock(DagMessages.Service, {
      revisions: () => Effect.succeed({ ok: true, value: { queued: 0, accepted: 3 } } as never),
      snapshotForTurn: (_caller, turnID) =>
        Effect.sync(() => {
          frozenTurn = turnID
          return { ok: true, value: { id: "snap-final" } } as never
        }),
    })
    const recovered = await Effect.runPromise(
      reconcileWorkflow(
        "wf",
        () => Effect.succeed("completed"),
        undefined,
        { nodes: [{ id: "n" }] },
        undefined,
        undefined,
        undefined,
        () => Effect.succeed(message),
      ).pipe(Effect.provide(Layer.mergeAll(dag, messages))),
    )
    expect(recovered.reconciled).toBe(1)
    expect(frozenTurn).toBe(message.info.id)
    expect(completed).toEqual({ output: "first second", snapshotID: "snap-final" })
  })

  it("fails closed when the final message has no associated snapshot", async () => {
    const message = assistant([{ text: "complete report" }])
    let completed = false
    let failure: string | undefined
    const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({ sessionId: "ses_parent", projectId: "project", directory: process.cwd() } as never),
      } as unknown as DagStore.Interface,
      nodeCompleted: () =>
        Effect.sync(() => {
          completed = true
        }),
      nodeFailed: (_dagID, _nodeID, reason) =>
        Effect.sync(() => {
          failure = reason
        }),
    })
    const messages = Layer.mock(DagMessages.Service, {
      revisions: () => Effect.succeed({ ok: true, value: { queued: 0, accepted: 4 } } as never),
      snapshotForTurn: () => Effect.succeed({ ok: true, value: undefined } as never),
    })
    const recovered = await Effect.runPromise(
      reconcileWorkflow(
        "wf",
        () => Effect.succeed("completed"),
        undefined,
        { nodes: [{ id: "n" }] },
        undefined,
        undefined,
        undefined,
        () => Effect.succeed(message),
      ).pipe(Effect.provide(Layer.mergeAll(dag, messages))),
    )
    expect(recovered.reconciled).toBe(1)
    expect(completed).toBe(false)
    expect(failure).toContain("no associated input snapshot")
  })

  it("keeps the frozen file receipt and its snapshot across a second recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dag-final-twice-"))
    try {
      const source = path.join(directory, "report.txt")
      await writeFile(source, "durable two-stage report")
      const message = assistant([{ text: source }])
      const node = {
        ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
        capturedOutput: undefined as unknown,
        capturedOutputPresent: false,
        capturedSnapshotID: null as string | null,
      }
      let completions = 0
      let guardedSnapshot: string | undefined
      let completedOutput: unknown
      const dag = Layer.mock(Dag.Service, {
        store: {
          getNodes: () => Effect.succeed([node]),
          getWorkflow: () => Effect.succeed({ sessionId: "ses_parent", projectId: "project", directory } as never),
          setCapturedOutput: (_sessionID: string, value: unknown, snapshotID?: string) =>
            Effect.sync(() => {
              node.capturedOutput = value
              node.capturedOutputPresent = true
              node.capturedSnapshotID = snapshotID ?? null
            }),
        } as unknown as DagStore.Interface,
        nodeCompleted: (_dagID, _nodeID, output, attempt) =>
          Effect.gen(function* () {
            expect(attempt?.inputSnapshotID).toBe("snap-final")
            completions++
            if (completions === 1)
              return yield* new Dag.StaleMessageInputError({ dagID: "wf", nodeID: "n", reason: "stale_input" })
            completedOutput = output
            return undefined
          }),
      })
      const messages = Layer.mock(DagMessages.Service, {
        revisions: () => Effect.succeed({ ok: true, value: { queued: 0, accepted: 2 } } as never),
        snapshotForTurn: (_caller, turnID) =>
          Effect.sync(() => {
            expect(turnID).toBe(message.info.id)
            return { ok: true, value: { id: "snap-final" } } as never
          }),
        guard: (_caller, input, commit) =>
          Effect.gen(function* () {
            guardedSnapshot = input.snapshotID
            return { ok: true, value: yield* commit } as const
          }),
      })
      const reconcile = () =>
        reconcileWorkflow(
          "wf",
          () => Effect.succeed("completed"),
          undefined,
          { nodes: [{ id: "n" }] },
          undefined,
          directory,
          undefined,
          () => Effect.succeed(message),
        ).pipe(Effect.provide(Layer.mergeAll(dag, messages)))
      const first = await Effect.runPromise(reconcile())
      expect(first.continuations).toEqual(["n"])
      expect(guardedSnapshot).toBe("snap-final")
      expect(node.capturedSnapshotID).toBe("snap-final")
      const frozen = node.capturedOutput as { path: string }
      await unlink(source)
      const second = await Effect.runPromise(reconcile())
      expect(second.reconciled).toBe(1)
      expect(completedOutput).toBe(frozen.path)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("restores a matching frozen file receipt after its source is deleted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dag-final-ref-"))
    try {
      const source = path.join(directory, "report.txt")
      await writeFile(source, "durable report")
      const ref = await Effect.runPromise(
        commitOutputFileRef(source, {
          workflow_id: "wf",
          node_id: "n",
          child_session_id: "ses_final_child",
          replan_attempt: 0,
        }),
      )
      expect(ref).toBeDefined()
      await unlink(source)
      const message = assistant([{ text: source }])
      let completed: unknown
      let authorized = false
      const node = {
        ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
        capturedOutput: ref,
        capturedOutputPresent: true,
        capturedSnapshotID: "snap-final",
      }
      const dag = Layer.mock(Dag.Service, {
        store: {
          getNodes: () => Effect.succeed([node]),
          getWorkflow: () => Effect.succeed({ sessionId: "ses_parent", projectId: "project", directory } as never),
        } as unknown as DagStore.Interface,
        nodeCompleted: (_dagID: string, _nodeID: string, output: unknown) =>
          Effect.sync(() => {
            completed = output
          }),
      })
      const messages = Layer.mock(DagMessages.Service, {
        revisions: () => Effect.succeed({ ok: true, value: { queued: 0 } } as never),
        snapshotForTurn: () => Effect.succeed({ ok: true, value: { id: "snap-final" } } as never),
      })
      const recovered = await Effect.runPromise(
        reconcileWorkflow(
          "wf",
          () => Effect.succeed("completed"),
          undefined,
          { nodes: [{ id: "n" }] },
          undefined,
          directory,
          () => (_sessionID, expected) =>
            Effect.sync(() => {
              expect(expected).toBe(source)
              authorized = true
            }),
          () => Effect.succeed(message),
        ).pipe(Effect.provide(Layer.mergeAll(dag, messages))),
      )
      expect(recovered.reconciled).toBe(1)
      expect(completed).toBe(ref?.path)
      expect(authorized).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("uses an exact-snapshot durable receipt without revalidating after a crash", async () => {
    const message = assistant([{ text: "false" }])
    let writes = 0
    let completed: unknown
    const node = {
      ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
      capturedOutput: false,
      capturedOutputPresent: true,
      capturedSnapshotID: "snap-final",
    }
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({ sessionId: "ses_parent", projectId: "project", directory: process.cwd() } as never),
        setCapturedOutput: () =>
          Effect.sync(() => {
            writes++
          }),
      } as unknown as DagStore.Interface,
      nodeCompleted: (_dagID: string, _nodeID: string, output: unknown) =>
        Effect.sync(() => {
          completed = output
        }),
    })
    const messages = Layer.mock(DagMessages.Service, {
      revisions: () => Effect.succeed({ ok: true, value: { queued: 0 } } as never),
      snapshotForTurn: () => Effect.succeed({ ok: true, value: { id: "snap-final" } } as never),
    })
    const recovered = await Effect.runPromise(
      reconcileWorkflow(
        "wf",
        () => Effect.succeed("completed"),
        undefined,
        { nodes: [{ id: "n", output_schema: { type: "boolean" } }] },
        undefined,
        undefined,
        undefined,
        () => Effect.succeed(message),
      ).pipe(Effect.provide(Layer.mergeAll(dag, messages))),
    )
    expect(recovered.reconciled).toBe(1)
    expect(completed).toBe(false)
    expect(writes).toBe(0)
  })

  it("does not attach a prior turn's capture to the latest snapshot", async () => {
    const message = assistant([{ text: "false" }])
    let persisted: unknown = true
    let completed: unknown
    let guardedSnapshot: string | undefined
    const node = {
      ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
      capturedOutput: true,
      capturedOutputPresent: true,
      capturedSnapshotID: "snap-old",
    }
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () =>
          Effect.succeed({ sessionId: "ses_parent", projectId: "project", directory: process.cwd() } as never),
        setCapturedOutput: (_sessionID: string, value: unknown) =>
          Effect.sync(() => {
            persisted = value
          }),
      } as unknown as DagStore.Interface,
      nodeCompleted: (_dagID: string, _nodeID: string, output: unknown) =>
        Effect.sync(() => {
          completed = output
        }),
    })
    const messages = Layer.mock(DagMessages.Service, {
      revisions: () => Effect.succeed({ ok: true, value: { queued: 0 } } as never),
      snapshotForTurn: () => Effect.succeed({ ok: true, value: { id: "snap-current" } } as never),
      guard: (_caller, input, commit) =>
        Effect.gen(function* () {
          guardedSnapshot = input.snapshotID
          return { ok: true, value: yield* commit } as const
        }),
    })
    const recovered = await Effect.runPromise(
      reconcileWorkflow(
        "wf",
        () => Effect.succeed("completed"),
        undefined,
        { nodes: [{ id: "n", output_schema: { type: "boolean" } }] },
        undefined,
        undefined,
        undefined,
        () => Effect.succeed(message),
      ).pipe(Effect.provide(Layer.mergeAll(dag, messages))),
    )
    expect(recovered.reconciled).toBe(1)
    expect(guardedSnapshot).toBe("snap-current")
    expect(persisted).toBe(false)
    expect(completed).toBe(false)
  })

  it("settles the current final response after a crash between capture and completion", async () => {
    const events: Array<{ type: string; output?: unknown; reason?: string }> = []
    let persisted: unknown = { old: true }
    const node = {
      ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
      capturedOutput: persisted,
      capturedOutputPresent: true,
    }
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () => Effect.succeed(undefined),
        setCapturedOutput: (_sessionID: string, value: unknown) =>
          Effect.sync(() => {
            persisted = value
          }),
      } as unknown as DagStore.Interface,
      nodeCompleted: (_dagID: string, _nodeID: string, output: unknown) =>
        Effect.sync(() => {
          events.push({ type: "completed", output })
        }),
      nodeFailed: (_dagID: string, _nodeID: string, reason: string) =>
        Effect.sync(() => {
          events.push({ type: "failed", reason })
        }),
    })
    const recovered = await Effect.runPromise(
      reconcileWorkflow(
        "wf",
        () => Effect.succeed("completed"),
        undefined,
        { nodes: [{ id: "n", output_schema: { type: "boolean" } }] },
        undefined,
        undefined,
        undefined,
        () => Effect.succeed(assistant([{ text: "false" }])),
      ).pipe(Effect.provide(dag)),
    )
    expect(recovered.reconciled).toBe(1)
    expect(events).toEqual([{ type: "completed", output: false }])
    expect(persisted).toBe(false)
  })
})
