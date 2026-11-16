// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Dual-runner fixture (Issue #1029, PR0).
 *
 * Two DAG runtimes in ONE test process that behave like two engine processes
 * sharing one database: each runner (R1, R2) owns an independent layer graph,
 * so each has its own SQLite connection (WAL, one shared file), its own
 * EventV2 bus and EventV2Bridge, DagStore, Dag (and with it the in-process
 * workflow `KeyedMutex`), DagMessages, SessionStatus, SessionInbox and DagLoop
 * with its `InstanceState`. What one runner publishes reaches the other only
 * through the database, exactly as between processes.
 *
 * What it models:
 *   - Identity: every runner carries a `pid:nonce` `RunnerIdentity`. R1 is this
 *     process (`EngineProcess.runner`), R2 another live process (our parent's
 *     pid); `DualRunnerOptions` injects others, built with `makeRunnerIdentity`
 *     (same pid with another nonce is an earlier life of the process, a pid
 *     nothing runs under is a dead one, `runnerAlive` judges them). Nothing in
 *     the DAG reads the identity yet; the lease primitives of PR1 take a runner
 *     id explicitly, so a test passes `runner.identity.id` (and a `now` from the
 *     TestClock) per side. Code that reads the process singleton instead runs
 *     inside `withEngineRunner(identity, effect)`.
 *   - Stall / zombie: `runner.hold(...)` parks every matching durable publish of
 *     ONE runner until released. The hold sits in front of the bus, so the
 *     runner stops BEFORE the publish opens its transaction. A held
 *     `NodeStarted` is exactly a publisher that passed its `guardNode` read and
 *     froze before its publish, the window that the in-process workflow lock
 *     cannot close across processes. Only publishes that are not inside a
 *     `DagMessages` fence can be held: with `mailbox` on, completing or failing a
 *     running node and cancel/complete/fail/replan/extend/recover publish inside
 *     an open IMMEDIATE transaction, and parking one there would keep SQLite's
 *     write lock and block the other runner's connection on the single JS thread
 *     (until its 5 s busy timeout). A hold that would do so dies with an error
 *     instead. `freeze()` parks everything, so arm it only once the runner's own
 *     fibers have nothing left to write.
 *   - Time: the fixture adds no delays of its own. Run the test under TestClock
 *     (`testEffect(...).effect` or `Effect.provide(TestClock.layer())`) and
 *     `TestClock.adjust` moves both runners' clocks together, a wall-clock jump
 *     as seen by the whole machine.
 *
 * What it does not model (module singletons shared by both runners, because
 * they are one process): `EngineProcess` (cancellation epochs, inbox drain
 * routes, scheduler slots, child-run registry) and `GlobalBus`. The DAG races
 * under test depend on none of them.
 *
 * Effects of a runner must run inside its context: `Dag.create`,
 * `DagLocation.ownsWorkflow` and friends resolve `Database`/`InstanceRef` from
 * the ambient context. `runner.run(effect)` provides it, and `runner.dag`,
 * `runner.store`, `runner.loop` are the same services with every call bound
 * through it.
 */

import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { asc, eq } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Scope } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AgentScheduler } from "@/session/agent-scheduler"
import { EngineProcess, runnerAlive, type RunnerIdentity } from "@/session/engine-process"
import { SessionInbox } from "@/session/inbox"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { withIdleAdmission } from "../../lib/session-prompt"
import { mockSessionPromptWithStub, type StubChildren } from "../../lib/child-runs"
import type { SessionPrompt } from "@/session/prompt"

export const PROJECT_ID = "project-1"
export const PARENT_SESSION_ID = "ses_parent"

/**
 * `pid:nonce`, the vocabulary of every `runner_id` column; `runnerAlive` judges
 * it. The defaults are an earlier life of this process: same pid, a new nonce.
 */
export function makeRunnerIdentity(input: { readonly pid?: number; readonly nonce?: string } = {}): RunnerIdentity {
  const pid = input.pid ?? process.pid
  const nonce = input.nonce ?? randomUUID()
  return { pid, nonce, id: `${pid}:${nonce}` }
}

/** A pid no process runs under, so `runnerAlive` calls its identity dead. */
export function deadRunnerIdentity(): RunnerIdentity {
  for (let pid = 4_000_000; pid > 3_000_000; pid--) {
    const identity = makeRunnerIdentity({ pid })
    if (!runnerAlive(identity.id)) return identity
  }
  throw new Error("no unused pid found")
}

/**
 * Run an effect with `EngineProcess.runner` swapped for `identity`. The
 * singleton is process-wide, so use it around the work of one runner, not
 * around fibers that interleave with the other runner's.
 */
export const withEngineRunner = <A, E, R>(identity: RunnerIdentity, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = EngineProcess.runner
      Object.assign(EngineProcess, { runner: identity })
      return previous
    }),
    () => effect,
    (previous) => Effect.sync(() => void Object.assign(EngineProcess, { runner: previous })),
  )

/** A required leaf node: no dependencies, reports nothing to the parent. */
export function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: false,
  }
}

/** What a child session looks like to `Session.messages`: the transcript both runners read. */
export type ChildState = "active" | "completed" | "failed"

/** One child prompt a runner started and keeps in flight until the test releases it with the reply text. */
export interface PromptGate {
  readonly sessionID: string
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

/** The publish a hold is looking at. */
export interface PublishView {
  readonly type: string
  readonly data: unknown
}

export interface HoldOptions {
  /** Park only the first matching publish (default), or every matching one until released. */
  readonly once?: boolean
}

/** A parked publisher: `reached` fires when a publish is parked, `release` lets it go on. */
export interface Hold {
  readonly reached: Effect.Effect<void>
  readonly release: Effect.Effect<void>
}

export interface Runner {
  readonly name: "R1" | "R2"
  readonly identity: RunnerIdentity
  readonly database: Database.Interface
  /** This runner's own bus. Events of the other runner never arrive here. */
  readonly events: EventV2.Interface
  readonly store: DagStore.Interface
  readonly dag: Dag.Interface
  readonly loop: DagLoop.Interface
  /** Child sessions this runner created, in order. */
  readonly created: string[]
  /** Sessions this runner's `SessionPrompt.cancel` was asked to stop. */
  readonly cancelled: string[]
  /** Child prompts in flight on this runner; `nextPrompt` takes the next one. */
  readonly prompts: Queue.Queue<PromptGate>
  /** The child-run seam of this runner's `SessionPrompt` stub (run registrations, settlements, cancels). */
  readonly childRuns: StubChildren
  /** Run an effect inside this runner's service graph and instance. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, RunnerServices>) => Effect.Effect<A, E>
  /** Start the runner the way bootstrap does: DagLoop startup recovery, then the inbox. */
  readonly init: Effect.Effect<void>
  /** Wait for the next child prompt this runner starts. */
  readonly nextPrompt: (message: string) => Effect.Effect<PromptGate, Error>
  /** Park durable publishes of this runner; see the module comment for the window this models and which publishes are safe to hold. */
  readonly hold: (match: (publish: PublishView) => boolean, options?: HoldOptions) => Effect.Effect<Hold>
  /** Park every durable publish of this runner until released: a stalled (SIGSTOPped) process. */
  readonly freeze: () => Effect.Effect<Hold>
  /** Close this runner's layer scope: a graceful exit with its finalizers. */
  readonly stop: Effect.Effect<void>
}

export interface DualRunner {
  readonly r1: Runner
  readonly r2: Runner
  /** The shared SQLite file. */
  readonly file: string
  /** What both runners' `Session.messages` read. A runner's child prompt sets "active" while it runs and "completed" once released; a test may set any state. */
  readonly children: Map<string, ChildState>
  /** The durable event log of one workflow, versionless type names, in sequence order. */
  readonly log: (dagID: string) => Effect.Effect<ReadonlyArray<{ readonly seq: number; readonly type: string }>>
}

export interface DualRunnerOptions {
  /**
   * Wire `DagMessages`, whose `guard` re-checks the attempt inside the settlement transaction.
   * Production always has it; the older single-runner tests leave it out. Default true.
   */
  readonly mailbox?: boolean
  /** Default: this process's own identity (`EngineProcess.runner`). */
  readonly r1?: RunnerIdentity
  /** Default: another live process, our parent's pid with a fresh nonce. */
  readonly r2?: RunnerIdentity
}

const cwd = process.cwd()

const instanceContext = {
  directory: cwd,
  worktree: cwd,
  root: cwd,
  project: {
    id: Project.ID.make(PROJECT_ID),
    worktree: AbsolutePath.make(cwd),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
}

function sessionInfo(id: string, parentID?: string): Session.Info {
  return {
    id: SessionID.make(id),
    slug: id,
    projectID: Project.ID.make(PROJECT_ID),
    directory: cwd,
    title: id,
    version: "test",
    agent: "build",
    permission: [],
    model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
    ...(parentID ? { parentID: SessionID.make(parentID) } : {}),
    time: { created: 0, updated: 0 },
  }
}

function transcript(sessionID: string, state: ChildState, text = ""): SessionV1.WithParts[] {
  const messageID = MessageID.ascending()
  const info: SessionV1.Assistant = {
    id: messageID,
    role: "assistant",
    sessionID: SessionID.make(sessionID),
    parentID: MessageID.ascending(),
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd, root: cwd },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: Model.ID.make("test-model"),
    providerID: Provider.ID.make("test"),
    time: { created: 0 },
    // `makeSessionStatusChecker`: no finish is a turn in flight ("active"),
    // an error finish is "failed", a stop is "completed".
    ...(state === "active" ? {} : { finish: state === "failed" ? "error" : "stop" }),
  }
  const parts: SessionV1.Part[] =
    state === "completed" && text
      ? [{ id: PartID.ascending(), sessionID: SessionID.make(sessionID), messageID, type: "text", text }]
      : []
  return [{ info, parts }]
}

interface Gate {
  /** Park the publish when a hold matches it; `inTransaction` tells whether it runs inside an open SQLite transaction. */
  readonly before: (publish: PublishView, inTransaction: Effect.Effect<boolean>) => Effect.Effect<void>
  readonly hold: Runner["hold"]
}

function makeGate(): Gate {
  const holds: Array<{
    readonly match: (publish: PublishView) => boolean
    readonly once: boolean
    readonly reached: Deferred.Deferred<void>
    readonly released: Deferred.Deferred<void>
    spent: boolean
  }> = []
  return {
    before: (publish, inTransaction) =>
      Effect.gen(function* () {
        const held = holds.find((item) => !item.spent && item.match(publish))
        if (!held) return
        // Parking inside a transaction would keep SQLite's write lock and freeze the other runner's connection.
        if (yield* inTransaction)
          yield* Effect.die(
            new Error(
              `a hold on ${publish.type} would park inside an open SQLite transaction (a DagMessages fence) and keep its write lock; hold before the command instead`,
            ),
          )
        if (held.once) held.spent = true
        yield* Deferred.succeed(held.reached, undefined)
        yield* Deferred.await(held.released)
      }),
    hold: (match, options) =>
      Effect.gen(function* () {
        const held = {
          match,
          once: options?.once ?? true,
          reached: yield* Deferred.make<void>(),
          released: yield* Deferred.make<void>(),
          spent: false,
        }
        holds.push(held)
        return {
          reached: Deferred.await(held.reached),
          release: Deferred.succeed(held.released, undefined).pipe(
            Effect.tap(() => Effect.sync(() => void (held.spent = true))),
            Effect.asVoid,
          ),
        }
      }),
  }
}

/** The runner's bridge with the stall point in front of every durable publish. */
function gatedBridge(gate: Gate) {
  return Layer.effect(
    EventV2Bridge.Service,
    Effect.gen(function* () {
      const real = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const inTransaction = Effect.serviceOption(db.$client.transactionService).pipe(Effect.map(Option.isSome))
      const publish: EventV2.Interface["publish"] = (definition, data, options) =>
        gate
          .before({ type: definition.type, data }, inTransaction)
          .pipe(Effect.andThen(real.publish(definition, data, options)))
      const publishMany: EventV2.Interface["publishMany"] = (entries, options) =>
        Effect.forEach(
          entries,
          (entry) => gate.before({ type: entry.definition.type, data: entry.data }, inTransaction),
          {
            discard: true,
          },
        ).pipe(Effect.andThen(real.publishMany(entries, options)))
      return EventV2Bridge.Service.of({ ...real, publish, publishMany })
    }),
  )
}

/** Wrap every function of a service so the effects it returns run in the runner's context. */
function bind<S extends object>(
  service: S,
  provide: (effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>,
): S {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args)
        return Effect.isEffect(result) ? provide(result) : result
      }
    },
  })
}

interface GraphInput {
  readonly name: Runner["name"]
  readonly file: string
  readonly mailbox: boolean
  readonly children: Map<string, ChildState>
  readonly gate: Gate
  readonly created: string[]
  readonly cancelled: string[]
  readonly prompts: Queue.Queue<PromptGate>
  /** The mocked `Session.create` writes through this runner's own connection; set once the graph is built. */
  readonly handle: { db?: Database.Interface["db"] }
}

/** One runner's layer graph: the real DAG services over a mocked session/prompt/agent edge. */
function runnerGraph(input: GraphInput) {
  const database = Database.layerFromPath(input.file)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = gatedBridge(input.gate).pipe(
    Layer.provide(EventV2Bridge.layer.pipe(Layer.provide(events))),
    Layer.provide(database),
  )
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const messages = input.mailbox ? DagMessages.layer.pipe(Layer.provide(database)) : Layer.empty
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(messages))
  // As in production the shared inbox is part of the graph the loop is built in.
  const inbox = SessionInbox.layer.pipe(Layer.provide(bridge), Layer.provide(status))
  const base = Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    messages,
    dag,
    status,
    AgentScheduler.defaultLayer,
    inbox,
  )

  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (id) => Effect.succeed(sessionInfo(id, id === PARENT_SESSION_ID ? undefined : PARENT_SESSION_ID)),
    create: (value) =>
      Effect.gen(function* () {
        const id = `ses_${input.name.toLowerCase()}_child_${input.created.length + 1}`
        input.created.push(id)
        // `DagMessages.guard` binds a settlement to the child session row.
        yield* input.handle
          .db!.insert(SessionTable)
          .values({
            id: SessionID.make(id),
            project_id: Project.ID.make(PROJECT_ID),
            parent_id: SessionID.make(PARENT_SESSION_ID),
            slug: id,
            directory: cwd,
            title: value?.title ?? id,
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        return sessionInfo(id, PARENT_SESSION_ID)
      }),
    messages: (value) => {
      const state = input.children.get(value.sessionID)
      return Effect.succeed(state ? transcript(value.sessionID, state) : [])
    },
  })

  const childPrompt = Effect.fn("test.DualRunner.childPrompt")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const release = yield* Deferred.make<string>()
    input.children.set(sessionID, "active")
    yield* Queue.offer(input.prompts, { sessionID, title: sessionID, release })
    const text = yield* Deferred.await(release)
    input.children.set(sessionID, "completed")
    return transcript(sessionID, "completed", text)[0]
  })
  const { layer: prompt, stub: childRuns } = mockSessionPromptWithStub(
    withIdleAdmission({
      cancel: (sessionID) => Effect.sync(() => void input.cancelled.push(sessionID as string)),
      prompt: childPrompt,
      // Parent wakes stay pending: the races under test observe scheduling, not delivery.
      deliver: () => Effect.succeed(Option.none()),
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
    list: () => Effect.succeed([{ name: "build", mode: "all", permission: [], options: {} }]),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return { layer: Layer.merge(base, loop), childRuns }
}

/** What a runner's context provides; `Runner.run` takes effects that need no more than this. */
export type RunnerServices = Layer.Success<ReturnType<typeof runnerGraph>["layer"]>

interface RunnerBuild {
  readonly children: Map<string, ChildState>
  readonly file: string
  readonly name: Runner["name"]
  readonly identity: RunnerIdentity
  readonly mailbox: boolean
}

const buildRunner = (input: RunnerBuild): Effect.Effect<Runner, never, Scope.Scope> =>
  Effect.gen(function* () {
    const gate = makeGate()
    const created: string[] = []
    const cancelled: string[] = []
    const prompts = yield* Queue.unbounded<PromptGate>()
    const handle: GraphInput["handle"] = {}
    const { layer, childRuns } = runnerGraph({ ...input, gate, created, cancelled, prompts, handle })

    // Each runner builds in its own root memo map: nothing is shared between the two graphs.
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope).pipe(Effect.orDie)
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideContext(context), Effect.provideService(InstanceRef, instanceContext))
    const run = <A, E>(effect: Effect.Effect<A, E, RunnerServices>): Effect.Effect<A, E> => provide(effect)

    const service = <I, S>(key: Context.Key<I, S>): S => Context.getUnsafe(context, key)
    const bound = <I, S extends object>(key: Context.Key<I, S>) => bind(service(key), provide)
    handle.db = service(Database.Service).db
    const loopService = bound(DagLoop.Service)
    const inboxService = service(SessionInbox.Service)
    return {
      name: input.name,
      identity: input.identity,
      database: service(Database.Service),
      events: service(EventV2.Service),
      store: bound(DagStore.Service),
      dag: bound(Dag.Service),
      loop: loopService,
      created,
      cancelled,
      prompts,
      childRuns,
      run,
      init: run(loopService.init().pipe(Effect.andThen(inboxService.init()))),
      nextPrompt: (message) =>
        Queue.take(prompts).pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Error(message)),
              onSome: Effect.succeed,
            }),
          ),
        ),
      hold: gate.hold,
      freeze: () => gate.hold(() => true, { once: false }),
      stop: Scope.close(scope, Exit.void),
    } satisfies Runner
  })

/**
 * Two runners over one fresh database file. The parent session every
 * workflow hangs off (`PARENT_SESSION_ID`, project `PROJECT_ID`, owner
 * directory = the test process directory) is seeded once.
 */
export const makeDualRunner = (options: DualRunnerOptions = {}): Effect.Effect<DualRunner, never, Scope.Scope> =>
  Effect.gen(function* () {
    // The directory is removed last: the runners (declared after it) close first.
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dag-dual-runner-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    )
    const file = path.join(directory, "dual.sqlite")
    const children = new Map<string, ChildState>()
    const mailbox = options.mailbox ?? true
    const r1 = yield* buildRunner({
      children,
      file,
      name: "R1",
      identity: options.r1 ?? EngineProcess.runner,
      mailbox,
    })
    const r2 = yield* buildRunner({
      children,
      file,
      name: "R2",
      identity: options.r2 ?? makeRunnerIdentity({ pid: process.ppid }),
      mailbox,
    })
    yield* r1.database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.make(PROJECT_ID), worktree: AbsolutePath.make(cwd), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* r1.database.db
      .insert(SessionTable)
      .values({
        id: SessionID.make(PARENT_SESSION_ID),
        project_id: Project.ID.make(PROJECT_ID),
        slug: "parent",
        directory: cwd,
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const log: DualRunner["log"] = (dagID) =>
      r1.database.db
        .select({ seq: EventTable.seq, type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, dagID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(
          Effect.orDie,
          // Stored types carry their schema version: `dag.node.failed.1`.
          Effect.map((rows) => rows.map((row) => ({ seq: row.seq, type: row.type.replace(/\.\d+$/, "") }))),
        )
    return { r1, r2, file, children, log }
  })

/**
 * R1 is up and drives a workflow (by default one required node, `n1`): its child
 * prompt is in flight, so the node is durably `running` with R1's child session.
 */
export const driveOnR1 = (dual: DualRunner, config: { readonly name?: string; readonly nodes?: NodeConfig[] } = {}) =>
  Effect.gen(function* () {
    yield* dual.r1.init
    const dagID = yield* dual.r1.dag.create({
      projectID: PROJECT_ID,
      sessionID: PARENT_SESSION_ID,
      title: config.name ?? "dual runner",
      config: { name: config.name ?? "dual-runner", nodes: config.nodes ?? [node("n1")] },
    })
    const gate = yield* dual.r1.nextPrompt("R1 did not start the child prompt of n1")
    return { dagID, gate }
  })
