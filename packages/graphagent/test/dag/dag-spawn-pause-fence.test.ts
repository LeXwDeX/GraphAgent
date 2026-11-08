// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Mirrors the
// dag-structured-output.test.ts harness idiom (and dag-location-guards.test.ts
// suppression precedent): mocked Agent/Session/prompt layers and the typed
// reply fixture use type-only shims for branded IDs — converting them would
// fork the shared harness shape without changing behavior.
import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber, Option } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import type { DagStore } from "@graphagent/core/dag/store"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

type TrackedEvent = { type: string; nodeID: string }

// #379 regression: control(pause) must hold a queued node's spawn fiber at the
// pause fence — no child session, no terminal event — and control(resume)
// (workflow status back to "running") must let the fiber proceed and complete.

function makeHarness(
  workflowStatus: () => string,
  claimAdoption: () => boolean,
  directory: string | (() => string) = process.cwd(),
  agentWait?: Promise<void>,
) {
  const events: TrackedEvent[] = []
  const failUnrecoverableReasons: string[] = []
  const storeState = { failReads: 0, reads: 0 }
  let createCalls = 0
  const storeStub: Partial<DagStore.Interface> = {
    tryClaimAdoption: () => Effect.sync(() => claimAdoption()),
    getWorkflow: () =>
      Effect.suspend(() => {
        storeState.reads++
        if (storeState.failReads > 0) {
          storeState.failReads--
          return Effect.die(new Error("injected workflow read failure"))
        }
        return Effect.sync(() =>
          makeWorkflowRow({
            status: workflowStatus(),
            directory: typeof directory === "function" ? directory() : directory,
          }),
        )
      }),
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => makeNodeRow({ id: nodeID, status: "queued" })),
    ),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")(() => Effect.void),
    nodeStarted: Effect.fn("s")(() => Effect.void),
    failUnrecoverable: Effect.fn("s")((_dagID: string, reason: string) =>
      Effect.sync(() => {
        failUnrecoverableReasons.push(reason)
        return "failed" as const
      }),
    ),
    nodeCompleted: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID })),
    ),
    nodeFailed: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID })),
    ),
    nodeSkipped: Effect.fn("s")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID })),
    ),
  })
  const agentLayer = Layer.mock(Agent.Service, {
    get: () =>
      (agentWait ? Effect.promise(() => agentWait) : Effect.void).pipe(
        Effect.as({
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
      ),
    list: () => Effect.succeed([]),
    defaultAgent: () => Effect.succeed("build"),
  })
  const sessionLayer = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
    create: () =>
      Effect.sync(() => {
        createCalls++
        return { id: "ses_child" as never } as never
      }),
    list: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
  })
  const promptLayer = Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(reply()),
  })
  return {
    events,
    storeState,
    failUnrecoverableReasons,
    createCalls: () => createCalls,
    fullLayer: Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer),
  }
}

function reply(): SessionV1.WithParts {
  return {
    info: {
      id: "msg_reply",
      role: "assistant",
      parentID: "msg_parent",
      sessionID: "ses_child",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test",
      time: { created: 0 },
      finish: "stop",
    },
    parts: [{ type: "text", text: "Task completed" }],
  } as SessionV1.WithParts
}

function makeSpawnInput(directory?: string): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
    ...(directory ? { directory } : {}),
  }
}

describe("spawnNode pause fence (#379)", () => {
  it("holds a queued node at the fence while the workflow is paused, then spawns after resume", async () => {
    let paused = true
    const harness = makeHarness(
      () => (paused ? "paused" : "running"),
      () => true,
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          // Two+ poll cycles past the initial read: the fiber must still be
          // held — no child session, no terminal transition.
          yield* Effect.sleep(600)
          expect(harness.createCalls()).toBe(0)
          expect(harness.events).toHaveLength(0)
          paused = false
          yield* Fiber.await(result.fiber)
          expect(harness.createCalls()).toBe(1)
          expect(harness.events.find((e) => e.type === "nodeCompleted")).toBeDefined()
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
  })

  it("#948: fails the workflow before spawning when the directory disappears during the pause hold", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-pause-workspace-")))
    let paused = true
    try {
      const harness = makeHarness(
        () => (paused ? "paused" : "running"),
        () => true,
        root,
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
            yield* Effect.sleep(300)
            expect(harness.createCalls()).toBe(0)
            rmSync(root, { recursive: true, force: true })
            paused = false
            yield* Fiber.await(result.fiber)
            expect(harness.createCalls()).toBe(0)
            expect(harness.failUnrecoverableReasons).toHaveLength(1)
            expect(harness.failUnrecoverableReasons[0]).toContain("workspace_missing")
            expect(harness.events.filter((event) => event.type === "nodeFailed")).toEqual([])
          }),
        ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: fails the workflow before spawning when the directory disappears during model resolution", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-model-workspace-")))
    let releaseAgent = () => {}
    const agentWait = new Promise<void>((resolve) => {
      releaseAgent = resolve
    })
    try {
      const harness = makeHarness(
        () => "running",
        () => true,
        root,
        agentWait,
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const spawning = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput()).pipe(Effect.forkScoped)
            yield* Effect.sleep(50)
            rmSync(root, { recursive: true, force: true })
            releaseAgent()
            const result = yield* Fiber.join(spawning)
            const settled = yield* Fiber.await(result.fiber).pipe(Effect.timeoutOption("5 seconds"))
            expect({
              settled: Option.isSome(settled),
              createCalls: harness.createCalls(),
              failures: harness.failUnrecoverableReasons,
              events: harness.events,
            }).toEqual({
              settled: true,
              createCalls: 0,
              failures: [expect.stringContaining("workspace_missing")],
              events: [],
            })
            expect(harness.createCalls()).toBe(0)
            expect(harness.failUnrecoverableReasons).toHaveLength(1)
            expect(harness.failUnrecoverableReasons[0]).toContain("workspace_missing")
            expect(harness.events.filter((event) => event.type === "nodeFailed")).toEqual([])
          }),
        ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: fails the workflow before spawning when the directory disappears during the permit wait", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-permit-workspace-")))
    try {
      const harness = makeHarness(
        () => "running",
        () => true,
        root,
      )
      const semaphore = Semaphore.makeUnsafe(0)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(semaphore, makeSpawnInput())
            yield* Effect.sleep(50)
            rmSync(root, { recursive: true, force: true })
            yield* semaphore.release(1)
            const settled = yield* Fiber.await(result.fiber).pipe(Effect.timeoutOption("5 seconds"))
            expect(Option.isSome(settled)).toBe(true)
            expect(harness.createCalls()).toBe(0)
            expect(harness.failUnrecoverableReasons).toHaveLength(1)
            expect(harness.failUnrecoverableReasons[0]).toContain("workspace_missing")
            expect(harness.events.filter((event) => event.type === "nodeFailed")).toEqual([])
          }),
        ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: fails closed when the post-wait workflow read keeps failing", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-read-failure-")))
    try {
      const harness = makeHarness(() => "running", () => true, root)
      harness.storeState.failReads = 10
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // The fiber must not materialize a child when the post-wait read
            // never recovers. Its exact failure channel is the caller loop's
            // nodeFailed seam; this direct harness asserts the safety boundary.
            const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput(root))
            yield* Fiber.await(result.fiber).pipe(Effect.timeout("5 seconds"))
            expect(harness.createCalls()).toBe(0)
            expect(harness.events).toContainEqual({ type: "nodeFailed", nodeID: "node-1" })
          }),
        ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: the old owner does not create a child after the workflow moves during the wait", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-move-wait-")))
    const directoryA = path.join(root, "a")
    const directoryB = path.join(root, "b")
    mkdirSync(directoryA, { recursive: true })
    mkdirSync(directoryB, { recursive: true })
    let currentDirectory = directoryA
    let paused = true
    try {
      const harness = makeHarness(
        () => (paused ? "paused" : "running"),
        () => true,
        () => currentDirectory,
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput(directoryA))
            yield* Effect.sleep(300)
            expect(harness.createCalls()).toBe(0)
            currentDirectory = directoryB
            paused = false
            yield* Fiber.await(result.fiber).pipe(Effect.timeout("5 seconds"))
            expect(harness.createCalls()).toBe(0)
            expect(harness.events.filter((event) => event.type === "nodeFailed")).toEqual([])
          }),
        ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("exits without creating a session when the workflow terminalizes during the pause hold", async () => {
    let status = "paused"
    const harness = makeHarness(
      () => status,
      () => false,
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), makeSpawnInput())
          yield* Effect.sleep(300)
          expect(harness.createCalls()).toBe(0)
          status = "cancelled"
          yield* Fiber.await(result.fiber)
          expect(harness.createCalls()).toBe(0)
          expect(harness.events).toHaveLength(0)
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
  })

  it("fails a node whose queue budget already elapsed before admission", async () => {
    const harness = makeHarness(
      () => "running",
      () => true,
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), { ...makeSpawnInput(), timeoutMs: 0 })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
    expect(harness.createCalls()).toBe(0)
    expect(harness.events).toEqual([{ type: "nodeFailed", nodeID: "node-1" }])
  })
})
