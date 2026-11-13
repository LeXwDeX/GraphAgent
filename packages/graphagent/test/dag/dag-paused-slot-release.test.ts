// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Mirrors the dag-spawn-pause-fence.test.ts harness
// idiom: mocked Dag/Agent/Session/prompt layers and the typed reply fixture use type-only shims for branded IDs.
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { DagStore } from "@graphagent/core/dag/store"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { Session } from "@/session/session"
import { it } from "../lib/effect"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import { mockSessionPrompt } from "../lib/child-runs"

// Issue #1021 acceptance: a paused workflow does not occupy a child slot.
// `spawnNode` releases its slot while the workflow reads `paused` — both while
// a queued node waits at the pause fence and while a running node waits for
// continuation admission — and takes a fresh one on resume. The pool here has
// ONE child slot for the whole process, so a held slot would starve everything
// else: with workflow A paused, workflow B's node and a foreground task must
// both still get the slot, and A must finish once it resumes.

const A = "wf-a"
const B = "wf-b"

/** One child-run slot for the whole process; the floor keeps a workflow slot available. */
const limits: AgentSchedulerState.SchedulerLimits = {
  ...AgentSchedulerState.DEFAULT_LIMITS,
  childGlobal: 1,
  taskReserve: 1,
}

type Status = "running" | "paused"

function reply(finish: "stop" | "length"): SessionV1.WithParts {
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
      finish,
    },
    parts: [{ type: "text", text: "Task completed" }],
  } as SessionV1.WithParts
}

interface Options {
  /** Workflow A's first prompt ends at the output cap and pauses the workflow before returning. */
  readonly pauseDuringContinuation?: boolean
}

function makeHarness(options: Options = {}) {
  const state = AgentSchedulerState.makeState(limits)
  const scheduler = AgentScheduler.make(state, () => Effect.succeed(limits))
  const statuses = new Map<string, Status>([
    [A, options.pauseDuringContinuation ? "running" : "paused"],
    [B, "running"],
  ])
  const reads = new Map<string, number>()
  const prompts = new Map<string, number>()
  const created = new Map<string, number>()
  const completed: string[] = []
  const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

  const store: Partial<DagStore.Interface> = {
    tryClaimAdoption: () => Effect.succeed(true),
    getWorkflow: (dagID) =>
      Effect.sync(() => {
        bump(reads, dagID)
        return makeWorkflowRow({ id: dagID, status: statuses.get(dagID) ?? "running", directory: process.cwd() })
      }),
    getNode: (workflowID, nodeID) =>
      Effect.succeed(
        makeNodeRow({ id: nodeID, workflowId: workflowID, status: "running", childSessionId: "ses_child" }),
      ),
  }
  const dag = Layer.mock(Dag.Service, {
    store: store as DagStore.Interface,
    nodeQueued: Effect.fn("s")(() => Effect.void),
    nodeStarted: Effect.fn("s")(() => Effect.void),
    failUnrecoverable: Effect.fn("s")(() => Effect.succeed("failed" as const)),
    nodeCompleted: Effect.fn("s")((dagID: string) => Effect.sync(() => void completed.push(dagID))),
    nodeFailed: Effect.fn("s")((dagID: string, _nodeID: string, reason: string) =>
      Effect.sync(() => void completed.push(`${dagID}:failed:${reason}`)),
    ),
    nodeSkipped: Effect.fn("s")(() => Effect.void),
  })
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
    list: () => Effect.succeed([]),
    defaultAgent: () => Effect.succeed("build"),
  })
  const session = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
    create: (input) =>
      Effect.sync(() => {
        bump(created, String(input?.title))
        return { id: "ses_child" as never } as never
      }),
    list: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
  })
  const prompt = mockSessionPrompt({
    prompt: (input) =>
      Effect.sync(() => {
        // The node prompt is its workflow ID. The only other prompt is A's own
        // continuation (the output-cap nudge), which belongs to A.
        const text = input.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
        const owner = text === B ? B : A
        bump(prompts, owner)
        // First prompt of A: stop at the output cap while the workflow is paused,
        // so the node must wait for continuation admission before it may go on.
        if (options.pauseDuringContinuation && owner === A && prompts.get(owner) === 1) {
          statuses.set(A, "paused")
          return reply("length")
        }
        return reply("stop")
      }),
  })
  return {
    scheduler,
    statuses,
    reads,
    prompts,
    created,
    completed,
    /** What the harness saw so far, for failure messages. */
    describe: () =>
      JSON.stringify({
        statuses: Object.fromEntries(statuses),
        reads: Object.fromEntries(reads),
        prompts: Object.fromEntries(prompts),
        completed,
        running: state.children.inflight,
      }),
    /** Child slots in use right now. */
    running: () => state.children.inflight,
    layer: Layer.mergeAll(dag, agent, session, prompt, Layer.succeed(AgentScheduler.Service, scheduler)),
  }
}

/**
 * The node's prompt text is its workflow ID, so the harness can tell the two
 * apart, and so is its name, which becomes the child session title.
 */
function nodeInput(dagID: string): NodeSpawnInput {
  return {
    dagID,
    nodeID: "node-1",
    node: makeNodeRow({ workflowId: dagID, name: dagID }),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: dagID }],
  }
}

const schedule = (dagID: string) => ({ limit: { kind: "workflow" as const, workflowID: dagID }, cap: 1 })

/** Wait on a published signal in real time: the virtual clock is frozen on purpose. */
const until = (done: () => boolean, message: () => string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (!done()) {
      if (Date.now() > deadline) yield* Effect.die(new Error(message()))
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
    }
  })

/** Advance the virtual 250ms poll until the fiber settles (bounded). */
const advanceUntilSettled = (fiber: Fiber.Fiber<unknown, unknown>, message: () => string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40 && fiber.pollUnsafe() === undefined; attempt++) {
      yield* TestClock.adjust("250 millis")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
    }
    if (fiber.pollUnsafe() === undefined) yield* Effect.die(new Error(message()))
    yield* Fiber.await(fiber)
  })

/** Take a foreground-task slot the way the task tool does, hold it for one turn, release it. */
const foregroundTask = (scheduler: AgentScheduler.Interface, acquired: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* scheduler.childSlot({ kind: "task", parentSessionID: "ses_parent" }, limits.childGlobal)
      acquired.push("task")
      yield* Effect.yieldNow
    }),
  )

describe("a paused workflow does not occupy a child slot (#1021)", () => {
  it.effect("a node held at the pause fence gives its slot back to another workflow and a foreground task", () => {
    const harness = makeHarness()
    const { scheduler } = harness
    const acquired: string[] = []
    return Effect.gen(function* () {
      // A is paused: its fiber takes the only slot, sees the pause at the fence,
      // gives the slot back and polls. Two reads of its row (fence + poll) can
      // only happen after the release.
      const a = yield* spawnNode(schedule(A), nodeInput(A))
      yield* until(
        () => (harness.reads.get(A) ?? 0) >= 2,
        () => `workflow A never reached its pause hold ${harness.describe()}`,
      )
      expect((yield* scheduler.capacity()).children.running).toBe(0)
      expect((yield* scheduler.capacity({ kind: "workflow", workflowID: A })).limit?.used).toBe(0)

      // The pool has one slot and A holds none of it: B's node and a foreground
      // task both run to completion while A stays paused.
      const b = yield* spawnNode(schedule(B), nodeInput(B))
      const task = yield* foregroundTask(scheduler, acquired).pipe(Effect.forkChild)
      yield* until(
        () => harness.completed.length > 0 && acquired.length > 0,
        () => `B and the task did not both get a slot ${harness.describe()}`,
      )
      yield* Fiber.join(b.fiber)
      yield* Fiber.join(task)
      expect(harness.completed).toEqual([B])
      expect(acquired).toEqual(["task"])
      // A is parked at the fence: it never created its child session.
      expect([...harness.created.keys()]).toEqual([`${B} (DAG node)`])
      expect(a.fiber.pollUnsafe()).toBeUndefined()
      expect((yield* scheduler.capacity()).children.running).toBe(0)

      // Resume: A takes a fresh slot and finishes; nothing leaks.
      harness.statuses.set(A, "running")
      yield* advanceUntilSettled(a.fiber, () => `the resumed node never settled ${harness.describe()}`)
      expect(harness.completed).toEqual([B, A])
      expect([...harness.created.keys()]).toEqual([`${B} (DAG node)`, `${A} (DAG node)`])
      const settled = yield* scheduler.capacity()
      expect(settled.children.running).toBe(0)
      expect(settled.children.dagRunning).toBe(0)
    }).pipe(Effect.provide(harness.layer))
  })

  it.effect("a running node held in continuation admission gives its slot back too", () => {
    const harness = makeHarness({ pauseDuringContinuation: true })
    const { scheduler } = harness
    const acquired: string[] = []
    return Effect.gen(function* () {
      // A runs, ends its first turn at the output cap and the workflow pauses
      // before the continuation prompt: the slot must be handed back.
      const a = yield* spawnNode(schedule(A), nodeInput(A))
      yield* until(
        () => (harness.prompts.get(A) ?? 0) >= 1,
        () => `workflow A never ran its first turn ${harness.describe()}`,
      )
      // After its first turn A sits in the continuation hold, and that hold
      // holds no slot: the pool drains to zero while A has neither settled nor
      // sent its continuation prompt.
      yield* until(
        () => harness.running() === 0,
        () => `workflow A kept its slot through the continuation hold ${harness.describe()}`,
      )
      expect(harness.prompts.get(A)).toBe(1)
      expect(harness.completed).toEqual([])

      const b = yield* spawnNode(schedule(B), nodeInput(B))
      const task = yield* foregroundTask(scheduler, acquired).pipe(Effect.forkChild)
      yield* until(
        () => harness.completed.length > 0 && acquired.length > 0,
        () => `B and the task did not both get a slot ${harness.describe()}`,
      )
      yield* Fiber.join(b.fiber)
      yield* Fiber.join(task)
      expect(harness.completed).toEqual([B])
      expect(a.fiber.pollUnsafe()).toBeUndefined()
      expect(harness.prompts.get(A)).toBe(1)

      // Resume: the continuation prompt runs on a freshly acquired slot.
      harness.statuses.set(A, "running")
      yield* advanceUntilSettled(a.fiber, () => `the resumed node never settled ${harness.describe()}`)
      expect(harness.prompts.get(A)).toBe(2)
      expect(harness.completed).toEqual([B, A])
      expect((yield* scheduler.capacity()).children.running).toBe(0)
    }).pipe(Effect.provide(harness.layer))
  })
})
