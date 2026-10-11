// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded IDs and narrow Effect service mocks exercise only the runtime surface used by these tests.
import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { finalAssistantText, parseFinalResponse } from "@/dag/runtime/final-response"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { continueRecoveredMessageNode, makeLastAssistantMessageReader, reconcileWorkflow } from "@/dag/runtime/recovery"
import { spawnNode } from "@/dag/runtime/spawn"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { makeNodeRow } from "./fixtures"

function assistant(parts: Array<Partial<SessionV1.TextPart>>, finish = "stop"): SessionV1.WithParts {
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
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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

  async function run(message: SessionV1.WithParts, schema?: Record<string, unknown>) {
    const events: Array<{ type: string; output?: unknown; reason?: string }> = []
    let receipt: { present: boolean; value: unknown } | undefined
    let prompts = 0
    const store = {
      tryClaimAdoption: () => Effect.succeed(true),
      getNode: () =>
        Effect.succeed({
          ...makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" }),
          capturedOutput: receipt?.value,
          capturedOutputPresent: receipt?.present,
        }),
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
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: () =>
        Effect.sync(() => {
          prompts++
          return message
        }),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            dagID: "wf",
            nodeID: "n",
            node: makeNodeRow({ id: "n" }),
            parentSessionID: "ses_parent",
            promptParts: [{ type: "text", text: "work" }],
            outputSchema: schema,
            resultProtocol: "final_response",
          })
          yield* Fiber.await(result.fiber)
        }).pipe(Effect.provide(Layer.mergeAll(dag, agent, sessions, prompt))),
      ) as Effect.Effect<never>,
    )
    return { events, receipt, prompts }
  }

  it("captures a null JSON result as present without a submit_result call", async () => {
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

  it("rejects prose around JSON and never asks for a legacy tool nudge", async () => {
    const result = await run(assistant([{ text: 'Here: {"ok":true}' }]), { type: "object" })
    expect(result.events[0]?.type).toBe("failed")
    expect(result.events[0]?.reason).toContain("one JSON value")
    expect(result.prompts).toBe(1)
  })

  it("preserves every plaintext part for a node without a schema", async () => {
    const result = await run(assistant([{ text: "first " }, { text: "second" }]))
    expect(result.events).toEqual([{ type: "completed", output: "first second" }])
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
          Effect.succeed({ status: "running", projectId: "project", directory: "/tmp/project" } as never),
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
    const prompt = Layer.mock(SessionPrompt.Service, {
      loop: () => Effect.succeed(message),
    })
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
        result_protocol: "final_response",
        nodes: [{ id: "n", output_schema: { type: "boolean" } }],
      }).pipe(Effect.provide(Layer.mergeAll(dag, prompt, messages))),
    )
    expect(writes).toEqual([{ value: false, snapshotID: "snap-current" }])
    expect(completions).toEqual([{ output: false, snapshotID: "snap-current" }])
  })

  it("binds recovered plaintext completion to its final message snapshot when mailbox revisions exist", async () => {
    const message = assistant([{ text: "first " }, { text: "second" }])
    let completed: { output: unknown; snapshotID?: string } | undefined
    let frozenTurn: string | undefined
    const node = makeNodeRow({ id: "n", status: "running", childSessionId: "ses_final_child" })
    const dag = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed([node]),
        getWorkflow: () => Effect.succeed({ projectId: "project", directory: "/tmp/project" } as never),
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
        { result_protocol: "final_response", nodes: [{ id: "n" }] },
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
        getWorkflow: () => Effect.succeed({ projectId: "project", directory: "/tmp/project" } as never),
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
        { result_protocol: "final_response", nodes: [{ id: "n" }] },
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
          getWorkflow: () => Effect.succeed({ projectId: "project", directory } as never),
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
          { result_protocol: "final_response", nodes: [{ id: "n" }] },
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
          getWorkflow: () => Effect.succeed({ projectId: "project", directory } as never),
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
          { result_protocol: "final_response", nodes: [{ id: "n" }] },
          undefined,
          directory,
          (_sessionID, expected) =>
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
        getWorkflow: () => Effect.succeed({ projectId: "project", directory: "/tmp/project" } as never),
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
        { result_protocol: "final_response", nodes: [{ id: "n", output_schema: { type: "boolean" } }] },
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
        getWorkflow: () => Effect.succeed({ projectId: "project", directory: "/tmp/project" } as never),
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
        { result_protocol: "final_response", nodes: [{ id: "n", output_schema: { type: "boolean" } }] },
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
        { result_protocol: "final_response", nodes: [{ id: "n", output_schema: { type: "boolean" } }] },
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
