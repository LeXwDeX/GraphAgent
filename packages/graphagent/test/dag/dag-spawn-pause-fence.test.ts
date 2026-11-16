// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Mirrors the
// dag-structured-output.test.ts harness idiom (and dag-location-guards.test.ts
// suppression precedent): mocked Agent/Session/prompt layers and the typed
// reply fixture use type-only shims for branded IDs — converting them would
// fork the shared harness shape without changing behavior.
import { describe, expect, it } from "bun:test"
import { Clock, Effect, Layer, Fiber, Option } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { Dag } from "@/dag/dag"
import { DagBudget } from "@/dag/budget"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import type { DagStore } from "@graphagent/core/dag/store"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mockSessionPrompt } from "../lib/child-runs"
import { pollWithTimeout } from "../lib/effect"

type TrackedEvent = { type: string; nodeID: string }

// #379 regression: control(pause) must hold a queued node's spawn fiber at the
// pause fence — no child session, no terminal event — and control(resume)
// (workflow status back to "running") must let the fiber proceed and complete.

function makeHarness(
  workflowStatus: (workflowID: string) => string,
  directory: string | (() => string) = process.cwd(),
  agentWait?: Promise<void>,
  schedulerLayer: Layer.Layer<AgentScheduler.Service> = AgentScheduler.defaultLayer,
) {
  const events: TrackedEvent[] = []
  const failUnrecoverableReasons: string[] = []
  const started: Array<{ nodeID: string; deadlineMs: number }> = []
  const storeState = { failReads: 0, reads: 0 }
  let createCalls = 0
  const storeStub: Partial<DagStore.Interface> = {
    getWorkflow: Effect.fn("s")((workflowID: string) =>
      Effect.suspend(() => {
        storeState.reads++
        if (storeState.failReads > 0) {
          storeState.failReads--
          return Effect.die(new Error("injected workflow read failure"))
        }
        return Effect.sync(() =>
          makeWorkflowRow({
            id: workflowID,
            status: workflowStatus(workflowID),
            directory: typeof directory === "function" ? directory() : directory,
          }),
        )
      }),
    ),
    getNode: Effect.fn("s")((_workflowID: string, nodeID: string) =>
      Effect.sync(() => makeNodeRow({ id: nodeID, status: "queued" })),
    ),
  }
  const dagLayer = Layer.mock(Dag.Service, {
    store: storeStub as DagStore.Interface,
    nodeQueued: Effect.fn("s")(() => Effect.void),
    nodeStarted: Effect.fn("s")((_dagID: string, nodeID: string, _childSessionID: string, deadlineMs?: number) =>
      Effect.sync(() => {
        started.push({ nodeID, deadlineMs: deadlineMs ?? 0 })
      }),
    ),
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
  const promptLayer = mockSessionPrompt({
    prompt: () => Effect.succeed(reply()),
  })
  return {
    events,
    started,
    storeState,
    failUnrecoverableReasons,
    createCalls: () => createCalls,
    fullLayer: Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer, schedulerLayer),
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

/** The per-workflow child-run schedule the loop hands to `spawnNode`. */
function workflowSchedule(workflowID = "wf-1", cap = 1) {
  return { limit: { kind: "workflow" as const, workflowID }, cap }
}

describe("spawnNode budget admission (#1031 M5)", () => {
  it("denies the child session before creation and exhausts the workflow", async () => {
    const harness = makeHarness(() => "running")
    let exhausted = 0
    const budget = Layer.succeed(
      DagBudget.Service,
      DagBudget.Service.of({
        state: () => Effect.die("unused"),
        check: () =>
          Effect.fail(new DagBudget.BudgetExhaustedError({ sessionID: "ses_parent", used: 1200, budget: 1000 })),
        exhaust: () =>
          Effect.sync(() => {
            exhausted++
            return 1
          }),
        onBudgetChanged: () => Effect.succeed(0),
        init: () => Effect.void,
      }),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(workflowSchedule(), makeSpawnInput())
          yield* Fiber.await(result.fiber).pipe(Effect.timeoutOption("2 seconds"))
          expect(harness.createCalls()).toBe(0)
          expect(exhausted).toBe(1)
          // The node stays owned by the durable exhaustion sweep: no spurious
          // nodeFailed from the spawn path itself.
          expect(harness.events.filter((event) => event.type === "nodeFailed")).toEqual([])
        }),
      ).pipe(Effect.provide(Layer.mergeAll(harness.fullLayer, budget))) as Effect.Effect<never>,
    )
  })
})

describe("spawnNode pause fence (#379)", () => {
  it("holds a queued node at the fence while the workflow is paused, then spawns after resume", async () => {
    let paused = true
    const harness = makeHarness(() => (paused ? "paused" : "running"))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(workflowSchedule(), makeSpawnInput())
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
      const harness = makeHarness(() => (paused ? "paused" : "running"), root)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(workflowSchedule(), makeSpawnInput())
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
      const harness = makeHarness(() => "running", root, agentWait)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const spawning = yield* spawnNode(workflowSchedule(), makeSpawnInput()).pipe(Effect.forkScoped)
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
      const harness = makeHarness(() => "running", root)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scheduler = yield* AgentScheduler.Service
            // Hold the workflow's only child slot so the spawn stays queued in
            // the scheduler, reproducing the old zero-permit semaphore wait.
            const held = yield* scheduler.childSlot({ kind: "workflow", workflowID: "wf-1" }, 1)
            const result = yield* spawnNode(workflowSchedule(), makeSpawnInput())
            yield* Effect.sleep(50)
            rmSync(root, { recursive: true, force: true })
            yield* held.release
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
      const harness = makeHarness(() => "running", root)
      harness.storeState.failReads = 10
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // The fiber must not materialize a child when the post-wait read
            // never recovers. Its exact failure channel is the caller loop's
            // nodeFailed seam; this direct harness asserts the safety boundary.
            const result = yield* spawnNode(workflowSchedule(), makeSpawnInput(root))
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
        () => currentDirectory,
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const result = yield* spawnNode(workflowSchedule(), makeSpawnInput(directoryA))
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
    const harness = makeHarness(() => status)
    // The lease check reads the lease together with its workflow, so a workflow
    // that ended holds none (`DagLease.held`).
    const leaseHeld = Effect.sync(() => status !== "cancelled")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(workflowSchedule(), { ...makeSpawnInput(), leaseHeld })
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

  it("keeps a node queued past timeout_ms and anchors its budget at permit acquisition", async () => {
    const harness = makeHarness(() => "running")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* AgentScheduler.Service
          // Hold the workflow's only child slot past the node's timeout_ms.
          // Queue time is not execution time, so the spawn must keep waiting
          // instead of failing the permit wait without spawning.
          const held = yield* scheduler.childSlot({ kind: "workflow", workflowID: "wf-1" }, 1)
          const result = yield* spawnNode(workflowSchedule(), { ...makeSpawnInput(), timeoutMs: 200 })
          yield* Effect.sleep(400)
          expect(harness.createCalls()).toBe(0)
          expect(harness.events).toEqual([])
          expect(harness.started).toEqual([])

          const releasedAt = yield* Clock.currentTimeMillis
          yield* held.release
          yield* Fiber.await(result.fiber).pipe(Effect.timeout("5 seconds"))
          expect(harness.createCalls()).toBe(1)
          expect(harness.events.find((event) => event.type === "nodeCompleted")).toBeDefined()
          // The deadline is anchored when the permit is granted (after the
          // release), not when the spawn was dispatched.
          expect(harness.started).toHaveLength(1)
          expect(harness.started[0]?.deadlineMs).toBeGreaterThanOrEqual(releasedAt + 200)
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
  })

  it("a paused workflow releases the only global slot so another workflow progresses", async () => {
    // One shared child slot for both workflows: without the pause release the
    // paused workflow would starve the other one until resume.
    const limits: AgentSchedulerState.SchedulerLimits = {
      ...AgentSchedulerState.DEFAULT_LIMITS,
      childGlobal: 1,
      taskReserve: 1,
    }
    const scheduler = AgentScheduler.make(AgentSchedulerState.makeState(limits), () => Effect.succeed(limits))
    let pausedA = true
    let grantedA = false
    const observed: AgentScheduler.Interface = {
      ...scheduler,
      childSlot: (limit, cap, options) =>
        scheduler.childSlot(limit, cap, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (limit.kind === "workflow" && limit.workflowID === "wf-a") grantedA = true
            }),
          ),
        ),
    }
    const harness = makeHarness(
      (workflowID) => (workflowID === "wf-a" && pausedA ? "paused" : "running"),
      process.cwd(),
      undefined,
      Layer.succeed(AgentScheduler.Service, observed),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = yield* spawnNode(workflowSchedule("wf-a"), {
            ...makeSpawnInput(),
            dagID: "wf-a",
            nodeID: "a",
            node: makeNodeRow({ id: "a" }),
          })
          // The paused node took the slot once, then gave it back while it
          // waits for resume: the global pool is idle and no child exists.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              if (!grantedA) return undefined
              const snapshot = yield* scheduler.capacity()
              return snapshot.children.running === 0 ? (true as const) : undefined
            }),
            "the paused workflow never released the only child slot",
          )
          expect(harness.createCalls()).toBe(0)

          // Another session's workflow now takes the freed slot and completes.
          const b = yield* spawnNode(workflowSchedule("wf-b"), {
            ...makeSpawnInput(),
            dagID: "wf-b",
            nodeID: "b",
            node: makeNodeRow({ id: "b" }),
            parentSessionID: "ses_parent_b",
          })
          yield* Fiber.await(b.fiber).pipe(Effect.timeout("5 seconds"))
          expect(harness.events).toContainEqual({ type: "nodeCompleted", nodeID: "b" })
          expect((yield* scheduler.capacity()).children.running).toBe(0)

          // Resume lets the paused node run once the other workflow settled.
          pausedA = false
          yield* Fiber.await(a.fiber).pipe(Effect.timeout("5 seconds"))
          expect(harness.events).toContainEqual({ type: "nodeCompleted", nodeID: "a" })
          expect(harness.createCalls()).toBe(2)
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )
  })
})

describe("spawnNode lease re-check (ADR-0008 decision 2)", () => {
  /** A lease check that answers from a script (the last answer repeats) and counts its calls. */
  const scripted = (...answers: boolean[]) => {
    const calls = { value: 0 }
    const held = Effect.sync(() => answers[Math.min(calls.value++, answers.length - 1)] ?? true)
    return { calls, held }
  }

  const run = (harness: ReturnType<typeof makeHarness>, input: NodeSpawnInput) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(workflowSchedule(), input)
          yield* Fiber.await(result.fiber).pipe(Effect.timeout("5 seconds"))
        }),
      ).pipe(Effect.provide(harness.fullLayer)) as Effect.Effect<never>,
    )

  it("creates the child session when the lease is held at both checks", async () => {
    const harness = makeHarness(() => "running")
    const lease = scripted(true)

    await run(harness, { ...makeSpawnInput(), leaseHeld: lease.held })

    expect(harness.createCalls()).toBe(1)
    expect(harness.events.find((event) => event.type === "nodeCompleted")).toBeDefined()
    // The fence ahead of the workspace checks and the read right before the child session.
    expect(lease.calls.value).toBe(2)
  })

  it("creates no child session and writes no node event when the lease is gone at the fence", async () => {
    const harness = makeHarness(() => "running")
    const lease = scripted(false)

    await run(harness, { ...makeSpawnInput(), leaseHeld: lease.held })

    expect(harness.createCalls()).toBe(0)
    expect(harness.events).toEqual([])
    expect(harness.started).toEqual([])
    expect(harness.failUnrecoverableReasons).toEqual([])
    expect(lease.calls.value).toBe(1)
  })

  it("creates no child session when the lease is lost while the attempt is being prepared", async () => {
    const harness = makeHarness(() => "running")
    const lease = scripted(true, false)

    await run(harness, { ...makeSpawnInput(), leaseHeld: lease.held })

    expect(harness.createCalls()).toBe(0)
    expect(harness.events).toEqual([])
    expect(harness.started).toEqual([])
    expect(lease.calls.value).toBe(2)
  })
})
