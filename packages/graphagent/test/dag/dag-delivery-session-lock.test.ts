// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// #1344: DAG delivery is the `dag.delivery` source of the shared inbox, so the
// inbox's per-session drain is the only serialization of one session's claims.
// Before, a DAG event (node terminal, pause, move) delivered through a local
// drain with its own in-flight reservation, outside that lock; it could run
// while another source (goal.continue, a reminder) held a claim on the same
// session. These probes pin the shared lock from both sides, with the real
// DagLoop and a real inbox: a DAG wake never overlaps another source's claim on
// the same session, and whichever side ends first lets the other continue.
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, type Scope } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { AgentScheduler } from "@/session/agent-scheduler"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionInbox, type InboxSource } from "@/session/inbox"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { withIdleAdmission } from "../lib/session-prompt"
import { mockSessionPrompt } from "../lib/child-runs"
import { transactLayer } from "./fixture/transact"

const PARENT = "ses_parent"
const OTHER = "ses_other"

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ type: "text", text }] as never,
  }
}

function node(id: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

// Real-time waits: a "nothing happens" probe has to let the engine's own
// (event-driven) delivery path run, so it cannot ride a virtual clock.
const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const takeReal = <A>(queue: Queue.Queue<A>, ms = 3_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const item = yield* Queue.poll(queue)
      if (Option.isSome(item)) return item.value
      yield* realSleep(10)
    }
    return undefined
  })
const until = (check: () => boolean, ms = 3_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline) yield* realSleep(10)
    return check()
  })
/** How long a probe waits before it calls an event "not happening". */
const QUIET = 250

interface ChildGate {
  readonly sessionID: string
  readonly release: Deferred.Deferred<string>
}
interface WakeGate {
  readonly text: string
  readonly release: Deferred.Deferred<void>
}

/** A source that holds `session`'s lock inside its claim until `gate` opens. */
function holdingSource(input: {
  readonly session: string
  readonly entered: Queue.Queue<string>
  readonly gate: Deferred.Deferred<void>
}): InboxSource {
  return {
    id: "reminder",
    // Ahead of dag.delivery (5): the pass reaches this claim first.
    priority: 1,
    mode: "join_or_start",
    hint: () => true,
    claim: (sessionID) =>
      sessionID !== input.session
        ? Effect.succeed(false)
        : Queue.offer(input.entered, sessionID).pipe(Effect.andThen(Deferred.await(input.gate)), Effect.as(false)),
  }
}

/** A source behind dag.delivery (5) that only records which sessions it was asked to claim. */
function probeSource(claims: string[]): InboxSource {
  return {
    id: "reminder",
    priority: 10,
    mode: "join_or_start",
    hint: () => true,
    claim: (sessionID) =>
      Effect.sync(() => {
        claims.push(sessionID)
        return false
      }),
  }
}

function graph(queues: {
  readonly childPrompts: Queue.Queue<ChildGate>
  readonly parentPrompts: Queue.Queue<WakeGate>
}) {
  let created = 0
  const deliver = Effect.fn("test.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === PARENT) {
      const release = yield* Deferred.make<void>()
      const text = value.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      yield* Queue.offer(queues.parentPrompts, { text, release })
      yield* Deferred.await(release)
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(queues.childPrompts, { sessionID, release })
    return reply(sessionID, yield* Deferred.await(release))
  })

  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status, AgentScheduler.defaultLayer)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () =>
      Effect.succeed({
        id: SessionID.make(PARENT),
        slug: "parent",
        role: "root",
        projectID: Project.ID.make("project-1"),
        directory: process.cwd(),
        title: "parent",
        agent: "build",
        model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
        version: "test",
        time: { created: 0, updated: 0 },
      }),
    create: () => Effect.sync(() => ({ id: `ses_child_${++created}` }) as never),
    messages: () => Effect.succeed([]),
  })
  const prompt = mockSessionPrompt(
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: deliver,
      deliver: (value) => deliver(value).pipe(Effect.map(Option.some)),
    }),
  )
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
        tools: {},
        hooks: {},
      }),
  })
  // The inbox DagLoop registers its delivery with; merging the same layer
  // object below hands the test that identical instance.
  const inbox = SessionInbox.layer.pipe(Layer.provide(bridge), Layer.provide(status))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
    Layer.provide(inbox),
  )
  return Layer.mergeAll(base, loop, inbox)
}

interface Probe {
  readonly dag: Dag.Interface
  readonly store: DagStore.Interface
  readonly inbox: SessionInbox.Interface
  readonly childPrompts: Queue.Queue<ChildGate>
  readonly parentPrompts: Queue.Queue<WakeGate>
}

const run = <A>(body: (probe: Probe) => Effect.Effect<A, unknown, Scope.Scope>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const childPrompts = yield* Queue.unbounded<ChildGate>()
      const parentPrompts = yield* Queue.unbounded<WakeGate>()
      return yield* Effect.gen(function* () {
        const db = yield* Database.Service
        yield* db.db
          .insert(ProjectTable)
          .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db.db
          .insert(SessionTable)
          .values({
            id: SessionID.make(PARENT),
            project_id: Project.ID.make("project-1"),
            slug: "parent",
            directory: AbsolutePath.make(process.cwd()),
            title: "Parent",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const loop = yield* DagLoop.Service
        yield* loop.init()
        return yield* body({
          dag: yield* Dag.Service,
          store: yield* DagStore.Service,
          inbox: yield* SessionInbox.Service,
          childPrompts,
          parentPrompts,
        })
      }).pipe(
        Effect.provide(graph({ childPrompts, parentPrompts })),
        Effect.provideService(InstanceRef, {
          directory: process.cwd(),
          worktree: process.cwd(),
          project: { id: "project-1" },
        } as never),
        Effect.scoped,
      )
    }),
  )

/** Run one workflow to its terminal state; its terminal event is what asks delivery for a wake. */
const complete = (probe: Probe, title: string) =>
  Effect.gen(function* () {
    const dagID = yield* probe.dag.create({
      projectID: "project-1",
      sessionID: PARENT,
      title,
      config: { name: title, nodes: [node(title.toLowerCase())] },
    })
    const child = yield* takeReal(probe.childPrompts)
    expect(child).toBeDefined()
    yield* Deferred.succeed(child!.release, `${title} done`)
    for (let i = 0; i < 100 && (yield* probe.store.getWorkflow(dagID))?.status !== "completed"; i++)
      yield* realSleep(10)
    expect((yield* probe.store.getWorkflow(dagID))?.status).toBe("completed")
    return dagID
  })

describe("DAG delivery and the other sources of one session share the inbox's session lock", () => {
  it("a DAG wake does not run while another source holds a claim on the session, and runs once it ends", () =>
    run((probe) =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<string>()
        const gate = yield* Deferred.make<void>()
        yield* probe.inbox.register(holdingSource({ session: PARENT, entered, gate }))
        // The other source's claim starts first and holds the session.
        yield* probe.inbox.nudge(SessionID.make(PARENT)).pipe(Effect.forkScoped)
        expect(yield* takeReal(entered)).toBe(PARENT)

        // The workflow ends while that claim is held; its terminal event asks
        // delivery for a wake, and the session's lock is not free.
        const dagID = yield* complete(probe, "First")
        yield* realSleep(QUIET)
        expect(Option.isNone(yield* Queue.poll(probe.parentPrompts))).toBe(true)
        expect((yield* probe.store.getWorkflow(dagID))?.wakeReported).toBe(false)

        // The claim ends: the same pass reaches the DAG source and delivers.
        yield* Deferred.succeed(gate, undefined)
        const wake = yield* takeReal(probe.parentPrompts)
        expect(wake?.text).toContain("First")
        yield* Deferred.succeed(wake!.release, undefined)
        expect((yield* probe.store.getWorkflow(dagID))?.wakeReported).toBe(true)
      }),
    ))

  it("another source's claim does not run while a DAG wake is being delivered, and runs once it ends", () =>
    run((probe) =>
      Effect.gen(function* () {
        const claims: string[] = []
        yield* probe.inbox.register(probeSource(claims))
        const dagID = yield* complete(probe, "First")

        // The wake turn is admitted and runs; the DAG delivery holds the session.
        const wake = yield* takeReal(probe.parentPrompts)
        expect(wake?.text).toContain("First")
        yield* probe.inbox.nudge(SessionID.make(PARENT)).pipe(Effect.forkScoped)
        yield* realSleep(QUIET)
        expect(claims.filter((id) => id === PARENT)).toEqual([])

        // The wake turn ends and the DAG delivery gives the session back: the
        // nudge that arrived meanwhile becomes one more pass over every source.
        yield* Deferred.succeed(wake!.release, undefined)
        expect(yield* until(() => claims.includes(PARENT))).toBe(true)
        expect((yield* probe.store.getWorkflow(dagID))?.wakeReported).toBe(true)
      }),
    ))

  it("holds the lock per session: a claim parked on another session does not delay a DAG wake", () =>
    run((probe) =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<string>()
        const gate = yield* Deferred.make<void>()
        yield* probe.inbox.register(holdingSource({ session: OTHER, entered, gate }))
        yield* probe.inbox.nudge(SessionID.make(OTHER)).pipe(Effect.forkScoped)
        expect(yield* takeReal(entered)).toBe(OTHER)

        const dagID = yield* complete(probe, "First")
        const wake = yield* takeReal(probe.parentPrompts)
        expect(wake?.text).toContain("First")
        yield* Deferred.succeed(wake!.release, undefined)
        expect((yield* probe.store.getWorkflow(dagID))?.wakeReported).toBe(true)
        yield* Deferred.succeed(gate, undefined)
      }),
    ))
})
