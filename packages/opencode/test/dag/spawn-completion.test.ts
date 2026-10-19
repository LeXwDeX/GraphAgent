import { SettingsHook } from "@/hook/settings"
import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { makeNodeRow } from "./fixtures"

type TrackedEvent = {
  type: string
  dagID: string
  nodeID: string
  output?: unknown
  reason?: string
  trigger?: string
}

function makeEventTracker(store: Partial<DagStore.Interface> = {}) {
  const events: TrackedEvent[] = []
  const dagLayer = Layer.mock(Dag.Service, {
    store: { tryClaimAdoption: () => Effect.succeed(true), ...store } as unknown as DagStore.Interface,
    nodeQueued: Effect.fn("stub.nodeQueued")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeQueued", dagID, nodeID })),
    ),
    nodeStarted: Effect.fn("stub.nodeStarted")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeStarted", dagID, nodeID })),
    ),
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID, output })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string, trigger: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason, trigger })),
    ),
  })
  return { events, dagLayer }
}

const agentLayer = Layer.mock(Agent.Service, {
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
  list: () => Effect.succeed([]),
  defaultAgent: () => Effect.succeed("build"),
})

const sessionStub = {
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: () => Effect.succeed({ id: "ses_child" as never } as never),
  list: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
}
const sessionLayer = Layer.mock(Session.Service, sessionStub)

function reply(text: string, includeText = text !== ""): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: "ses_child" as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: includeText ? ([{ type: "text", text }] as never) : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(result),
  })
}

function makeFailingPromptLayer(error: string): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.die(new Error(error)),
  })
}

function makeSpawnInput(): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }] as never,
  }
}

async function runSpawn(dagLayer: Layer.Layer<never>, extraLayer: Layer.Layer<never>) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, extraLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput())
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

function findEvent(events: TrackedEvent[], type: string) {
  return events.find((e) => e.type === type)
}

describe("spawnNode completion bridge", () => {
  it("inherits the parent session model when the node and agent omit one", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const agentWithoutModel = Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "general",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          tools: {},
          hooks: {},
        }),
    })
    const parentWithModel = Layer.mock(Session.Service, {
      get: () =>
        Effect.succeed({
          id: "ses_parent",
          permission: [],
          agent: "build",
          model: { providerID: "local-proxy-compatible", id: "glm-5.2" },
        } as never),
      create: () => Effect.succeed({ id: "ses_child" as never } as never),
    })
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(dagLayer, agentWithoutModel, parentWithModel, prompt)),
      ) as Effect.Effect<never>,
    )

    expect(promptModel as unknown).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "glm-5.2",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("prefers the configured DAG tier over the worker agent model", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            fallbackModel: {
              providerID: "configured",
              modelID: "dag-tier-model",
            },
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, prompt))) as Effect.Effect<never>,
    )

    expect(promptModel as unknown).toEqual({
      providerID: "configured",
      modelID: "dag-tier-model",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("canonicalizes a provider-qualified model from a persisted node", async () => {
    const { events, dagLayer } = makeEventTracker()
    let promptModel: SessionPrompt.PromptInput["model"]
    const prompt = Layer.mock(SessionPrompt.Service, {
      prompt: (input) =>
        Effect.sync(() => {
          promptModel = input.model
          return reply("done")
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            ...makeSpawnInput(),
            node: makeNodeRow({
              modelId: "local-proxy-compatible/glm-5.2",
              modelProviderId: "local-proxy-compatible",
            }),
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, prompt))) as Effect.Effect<never>,
    )

    expect(promptModel as unknown).toEqual({
      providerID: "local-proxy-compatible",
      modelID: "glm-5.2",
    })
    expect(findEvent(events, "nodeCompleted")).toBeDefined()
  })

  it("publishes NodeCompleted with output text on success", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed successfully")))

    const completed = findEvent(events, "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed successfully")

    const started = findEvent(events, "nodeStarted")
    expect(started).toBeDefined()
  })

  it("publishes verdict_fail when the provider returns no text output", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("")))

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
    expect(findEvent(events, "nodeFailed")).toEqual(
      expect.objectContaining({
        reason: "provider returned empty output",
        trigger: "verdict_fail",
      }),
    )
  })

  it("classifies empty and whitespace-only text parts like missing text", async () => {
    for (const text of ["", " \n\t "]) {
      const { events, dagLayer } = makeEventTracker()
      await runSpawn(dagLayer, makePromptLayer(reply(text, true)))
      expect(findEvent(events, "nodeCompleted")).toBeUndefined()
      expect(findEvent(events, "nodeFailed")).toEqual(
        expect.objectContaining({
          reason: "provider returned empty output",
          trigger: "verdict_fail",
        }),
      )
    }
  })

  it("preserves non-empty text byte-for-byte", async () => {
    const { events, dagLayer } = makeEventTracker()
    const text = "\n  exact output\t"
    await runSpawn(dagLayer, makePromptLayer(reply(text, true)))

    expect(findEvent(events, "nodeCompleted")?.output).toBe(text)
  })

  it("publishes NodeFailed when prompt fails", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makeFailingPromptLayer("LLM exploded"))

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("Error: LLM exploded")
    expect(failed!.reason).not.toContain("Cause([Die(")

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
  })

  // Issue #777: the live path must keep the durable assistant error identity
  // in the failure reason; the trigger stays "exec_failed" and the role check
  // precedes the error check so non-assistant results keep the plain reason.
  function replyWith(error: SessionV1.Assistant["error"]): SessionV1.WithParts {
    const info: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: SessionID.make("ses_child"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      error,
    }
    return { info, parts: [] }
  }

  it("keeps a persisted abort identity in the live NodeFailed reason", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(
      dagLayer,
      makePromptLayer(
        replyWith({ name: "MessageAbortedError", data: { message: "Aborted" } } satisfies SessionV1.Assistant["error"]),
      ),
    )

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.trigger).toBe("exec_failed")
    expect(failed!.reason).toContain("child model turn stopped before a successful result")
    expect(failed!.reason).toContain("(MessageAbortedError)")
    expect(failed!.reason).toContain("interrupted")
    expect(failed!.reason).toContain("source unknown")
    expect(failed!.reason).toContain("checking side effects")
    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
  })

  it("keeps a genuine failure identity in the live NodeFailed reason", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(
      dagLayer,
      makePromptLayer(
        replyWith({
          name: "UnknownError",
          data: { message: "provider exploded" },
        } satisfies SessionV1.Assistant["error"]),
      ),
    )

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.trigger).toBe("exec_failed")
    expect(failed!.reason).toBe("child model turn stopped before a successful result (UnknownError)")
    expect(failed!.reason).not.toContain("interrupted")
  })

  it("keeps the plain live reason for a non-assistant prompt result", async () => {
    const { events, dagLayer } = makeEventTracker()
    const base = reply("")
    const nonAssistant: SessionV1.WithParts = {
      info: {
        id: base.info.id,
        sessionID: base.info.sessionID,
        role: "user",
        time: { created: base.info.time.created },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      },
      parts: [],
    }
    await runSpawn(dagLayer, makePromptLayer(nonAssistant))

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toBe("child model turn stopped before a successful result")
    expect(failed!.trigger).toBe("exec_failed")
  })

  it("publishes exactly one terminal event per node", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("done")))

    const terminal = events.filter((e) => e.type === "nodeCompleted" || e.type === "nodeFailed")
    expect(terminal.length).toBe(1)
  })

  it("notification preparation defects cannot publish a second terminal event", async () => {
    const { events, dagLayer } = makeEventTracker()
    const hooks: string[] = []
    await runSpawn(
      dagLayer,
      Layer.merge(
        makePromptLayer(reply("done")),
        Layer.mock(SettingsHook.Service, {
          registerScoped: () => Effect.void,
          unregisterScoped: () => Effect.void,
          trigger: (payload) =>
            Effect.sync(() => {
              hooks.push(payload.event)
              return { additionalContexts: [], systemMessages: [] }
            }),
        }),
      ),
    )
    // This fixture intentionally has no store.getNode: notification preparation
    // fails after nodeCompleted, but that optional notification is not execution.
    expect(hooks).toEqual(["SubagentStart"])
    expect(events.filter((e) => e.type === "nodeCompleted" || e.type === "nodeFailed").map((e) => e.type)).toEqual([
      "nodeCompleted",
    ])
  })

  for (const status of ["completed", "failed", "stale-attempt", "stale-child"] as const)
    it(`notifies Stop only for the settled live attempt: ${status}`, async () => {
      const { events, dagLayer } = makeEventTracker({
        getNode: () =>
          Effect.succeed(
            makeNodeRow({
              status: status === "failed" ? "failed" : "completed",
              childSessionId: status === "stale-child" ? "ses_other" : "ses_child",
              replanAttempts: status === "stale-attempt" ? 1 : 0,
            }),
          ),
      })
      const hooks: string[] = []
      const appended: string[] = []
      const unregistered: string[] = []
      const userID = MessageID.ascending()
      await runSpawn(
        dagLayer,
        Layer.mergeAll(
          makePromptLayer(reply(status === "failed" ? "" : "done")),
          Layer.mock(Session.Service, {
            ...sessionStub,
            messages: ({ sessionID }) =>
              Effect.succeed<SessionV1.WithParts[]>([
                {
                  info: {
                    id: userID,
                    sessionID,
                    role: "user",
                    time: { created: 1 },
                    agent: "build",
                    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
                  },
                  parts: [],
                },
              ]),
            updatePart: (part) =>
              Effect.sync(() => {
                expect(part.messageID).toBe(userID)
                expect(part.sessionID).toBe(SessionID.make("ses_child"))
                if (part.type === "text") appended.push(part.text)
                return part
              }),
          }),
          Layer.mock(SettingsHook.Service, {
            registerScoped: () => Effect.void,
            unregisterScoped: (sessionID) =>
              Effect.sync(() => {
                unregistered.push(sessionID)
              }),
            trigger: (payload, context) =>
              Effect.sync(() => {
                hooks.push(payload.event)
                expect(context.sessionID).toBe("ses_parent")
                if (payload.event !== "SubagentStop") return { additionalContexts: [], systemMessages: [] }
                // Completion/failure must already be durable before Stop can observe it.
                expect(events.filter((event) => ["nodeCompleted", "nodeFailed"].includes(event.type))).toHaveLength(1)
                expect(payload.agentID).toBe("ses_child")
                expect(payload.agentTranscriptPath).toBeString()
                expect(payload.stopHookActive).toBe(false)
                expect(payload.backgroundTasks).toEqual([])
                return {
                  additionalContexts: ["settled context"],
                  systemMessages: ["notice"],
                  blocked: { reason: "block cannot reopen settlement", command: "fixture" },
                  stopReason: "stop notice",
                }
              }),
          }),
        ),
      )
      const current = status === "completed" || status === "failed"
      expect(hooks).toEqual(current ? ["SubagentStart", "SubagentStop"] : ["SubagentStart"])
      expect(appended).toEqual(current ? ["settled context"] : [])
      expect(unregistered).toEqual(["ses_child"])
      expect(
        events.filter((event) => ["nodeCompleted", "nodeFailed"].includes(event.type)).map((event) => event.type),
      ).toEqual([status === "failed" ? "nodeFailed" : "nodeCompleted"])
    })

  it("releases its permit for the next node", async () => {
    const { events, dagLayer } = makeEventTracker()
    const semaphore = Semaphore.makeUnsafe(1)
    const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, makePromptLayer(reply("done")))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(first.fiber)
          const second = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(second.fiber)
        }),
      ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
    )

    expect(events.filter((event) => event.type === "nodeCompleted")).toHaveLength(2)
  })
})

describe("spawnNode terminalization during spawn window", () => {
  it("does NOT publish spurious NodeFailed when node was cancelled mid-spawn", async () => {
    const events: TrackedEvent[] = []
    let cancelCalled = false
    const dagLayer = Layer.mock(Dag.Service, {
      store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.fail(new TerminalViolationError("node-1", "failed", "running")),
      nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
        Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID })),
      ),
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
      ),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () => Effect.die(new Error("prompt should NOT be called after terminalization")),
      cancel: () =>
        Effect.sync(() => {
          cancelCalled = true
        }),
    })

    const semaphore = Semaphore.makeUnsafe(1)
    const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(semaphore, makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
    )

    expect(events.filter((e) => e.type === "nodeFailed")).toEqual([])
    expect(events.filter((e) => e.type === "nodeCompleted")).toEqual([])
    expect(cancelCalled).toBe(true)
  })

  it("cancels the child session when nodeStarted fails after session creation", async () => {
    const events: TrackedEvent[] = []
    let cancelCalled = false
    let promptCalled = false
    const dagLayer = Layer.mock(Dag.Service, {
      store: { tryClaimAdoption: () => Effect.succeed(true) } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => Effect.fail(new Error("nodeStarted write failed")),
      nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
        Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID })),
      ),
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
      ),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      prompt: () =>
        Effect.sync(() => {
          promptCalled = true
          return reply("unexpected")
        }),
      cancel: () =>
        Effect.sync(() => {
          cancelCalled = true
        }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer))) as Effect.Effect<never>,
    )

    expect(promptCalled).toBe(false)
    expect(findEvent(events, "nodeFailed")?.reason).toContain("nodeStarted write failed")
    expect(cancelCalled).toBe(true)
  })
})
