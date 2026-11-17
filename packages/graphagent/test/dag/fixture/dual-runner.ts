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
 *     nothing runs under is a dead one, `runnerAlive` judges them). The identity
 *     is provided to the runner's graph as `RunnerLease.Identity`, which is what
 *     its DagLoop claims leases as; the singleton `EngineProcess.runner` is the
 *     same for both runners, so nothing in the loop may read it. Code that does
 *     read the singleton runs inside `withEngineRunner(identity, effect)`.
 *   - Lease: every runner graph provides `DagLease`, which the runner's DagLoop
 *     claims and renews through (the stall point below sits in front of every
 *     operation, so a stalled process renews nothing). `runner.lease` is the same
 *     primitives without the stall point, for a test to inspect or drive the
 *     table; `leaseRow` reads it raw, whatever the workflow's status.
 *   - Fence: every runner write of a runner's DagLoop carries the lease token of
 *     its runtime entry (ADR-0008 decision 4), and the fence in front of the
 *     command's transaction answers it. `runner.fenced` records each answer (the
 *     write committed, was refused because the lease no longer names the token,
 *     or got past the fence and was rejected by the guard), so a test waits for a
 *     zombie's refusal on that signal and not on a sleep. Intent writes carry no
 *     token and are not in it. The record sits behind the hold below: a write
 *     parked at the command's entry is not in it yet.
 *   - Stall / zombie: `runner.hold(...)` parks every matching durable write of
 *     ONE runner until released. Every `Dag` command runs in one IMMEDIATE
 *     transaction (`DagTransact`, ADR-0008 decision 3), and parking inside it
 *     would keep SQLite's write lock and block the other runner's connection on
 *     the single JS thread (until its 5 s busy timeout). So the hold sits at the
 *     command entry, ahead of the in-process workflow lock and of the
 *     transaction: it matches the event the command publishes (`dag.node.started`
 *     for `nodeStarted`) and parks the call. That is a writer which decided to
 *     write and then stalled, and which, once released, runs its guard against
 *     whatever the other runner did meanwhile. A write window between a guard
 *     read and its publish no longer exists to be modeled: they share the
 *     transaction. Publishes that are not Dag commands (the session events, and
 *     `Dag.create`'s batch) are held in front of the bus; one that would park
 *     inside an open transaction dies with an error instead. `freeze()` parks
 *     everything, lease claims, renewals and releases included (a SIGSTOPped
 *     process renews nothing), so arm it only once the runner's own fibers have
 *     nothing left to write.
 *   - Time: the fixture adds no delays of its own. Run the test under TestClock
 *     (`testEffect(...).effect` or `Effect.provide(TestClock.layer())`) and
 *     `TestClock.adjust` moves both runners' clocks together, a wall-clock jump
 *     as seen by the whole machine. A wait is bounded in real time, not in
 *     rounds of the clock (`STALL_TOLERANCE`): a round costs a fraction of a
 *     millisecond when the runners' fibers have nothing to run, so a count of
 *     them ends long before a runner that is only slow (a loaded machine) is
 *     done.
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
import { asc, eq, sql } from "drizzle-orm"
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Layer, Option, Queue, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@graphagent/core/database/database"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
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
import { RunnerLease } from "@/dag/runtime/runner-lease"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AgentScheduler } from "@/session/agent-scheduler"
import { EngineProcess, ExclusiveRegistry, runnerAlive, type RunnerIdentity } from "@/session/engine-process"
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

/**
 * What a child session looks like to `Session.messages`: the transcript both
 * runners read. "defect" is a session store that dies on read, which aborts a
 * recovery that has to judge the child (`makeSessionStatusChecker`).
 */
export type ChildState = "active" | "completed" | "failed" | "defect"

/** One child prompt a runner started and keeps in flight until the test releases it with the reply text. */
export interface PromptGate {
  readonly sessionID: string
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

/** The write a hold is looking at: a publish, or the event a `Dag` command is about to publish. */
export interface PublishView {
  readonly type: string
  readonly data: unknown
}

export interface HoldOptions {
  /** Park only the first matching publish (default), or every matching one until released. */
  readonly once?: boolean
}

export type LeaseOperation = "claim" | "renew" | "release" | "held"

/** One lease operation of a runner's DagLoop that ran to its end, and what it answered. */
export interface LeaseCall {
  readonly operation: LeaseOperation
  readonly dagID: string
  /** `claim` and `held` answer the lease (or `undefined` when there is none); `renew` and `release` whether they applied. */
  readonly answer: DagLease.Lease | boolean | undefined
}

/**
 * One write of a runner's DagLoop that carried a lease token (ADR-0008 decision 4: a runner write), as the
 * fence in front of its transaction answered it. Intent writes carry no token and are not recorded.
 */
export interface FencedWrite {
  readonly dagID: string
  readonly token: DagLease.Token
  /** "committed": the transaction ran to its end. "refused": the lease no longer names the token (`StaleRunnerError`). "rejected": the fence let it through and the guard (or the body) failed. */
  readonly outcome: "committed" | "refused" | "rejected"
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
  /** The lease primitives of this runner's graph, without the stall point: for a test to inspect or drive the table. */
  readonly lease: DagLease.Interface
  /**
   * The lease operations this runner's DagLoop ran to their end, in order, with
   * their answers: what a test waits on to know the loop reached a decision (a
   * claim that was refused, a renewal that went through) instead of sleeping
   * for it. A call that was parked and never let go, or that was made to fail
   * (`failLease`), is not in it; `lease` calls are not either.
   */
  readonly leaseCalls: ReadonlyArray<LeaseCall>
  /**
   * The writes this runner's DagLoop made under its lease token, in the order their
   * transactions ended, with the fence's answer. What a test waits on to know a
   * zombie's write was refused (or accepted) without sleeping for it. The hold of
   * `hold` sits ahead of this record: a parked write is not in it yet.
   */
  readonly fenced: ReadonlyArray<FencedWrite>
  /** The exclusive registry this runner's DagLoop registers its workflows in (a dag registration keeps goals off the parent session). */
  readonly exclusive: ExclusiveRegistry.Interface
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
  /**
   * Wait for the next child prompt this runner starts: the signal to wait on for what a runner's fibers do on
   * the way there (an adoption takes real time, which no number of clock rounds waits for). It gives up after
   * `STALL_TOLERANCE` of real time, on the TestClock too, and fails with `message`; an effect is read at that
   * moment, for the state a failure should report (`describeRunner`).
   */
  readonly nextPrompt: (message: string | Effect.Effect<string>) => Effect.Effect<PromptGate, Error>
  /** Park durable publishes of this runner; see the module comment for the window this models and which publishes are safe to hold. */
  readonly hold: (match: (publish: PublishView) => boolean, options?: HoldOptions) => Effect.Effect<Hold>
  /** Park every durable publish and every lease operation of this runner until released: a stalled (SIGSTOPped) process. */
  readonly freeze: () => Effect.Effect<Hold>
  /** The next `times` calls of one lease operation of this runner's DagLoop die, as a database failure (`SQLITE_BUSY` past the busy timeout) does. */
  readonly failLease: (operation: LeaseOperation, times: number) => void
  /** Close this runner's layer scope: a graceful exit with its finalizers. Holds and freezes let go first, so a finalizer never waits on one. */
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
  /**
   * The holder stalled past its TTL: its lease row says it ran out (`expires_at`
   * 0), so any runner may claim it. For a test on the live clock, where a stall
   * is arbitrarily long without time passing; a TestClock jump of that size
   * would also time out the workflow lock a parked write holds (`Dag`'s
   * `WORKFLOW_LOCK_TIMEOUT`), and the zombie would never write.
   */
  readonly expireLease: (dagID: string) => Effect.Effect<void>
  /** The raw `dag_runner` row of one workflow, whatever the workflow's status (`DagLease.held` hides a terminal workflow's). */
  readonly leaseRow: (
    dagID: string,
  ) => Effect.Effect<{ readonly runnerID: string; readonly epoch: number; readonly expiresAt: number } | undefined>
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

/**
 * How long a wait for a runner's fibers may take in real time before it gives up. Every wait returns as soon as
 * what it waits for is there, so the bound costs nothing when things go well and only decides how long a real
 * failure takes to report (the same figure, and the same reason, as in `dag-input-mapping-runtime.test.ts`).
 */
const STALL_TOLERANCE = "20 seconds"

const isTestClock = (clock: Clock.Clock): clock is TestClock.TestClock => "withLive" in clock

/**
 * `effect` on the real clock. On the TestClock a timeout ends only when the test moves the clock, which a wait for
 * a signal does not, so a bound on real work has to be set on the real one; a test on the live clock needs no switch.
 */
const onRealClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const clock = fiber.getRef(Clock.Clock)
    return isTestClock(clock) ? clock.withLive(effect) : effect
  })

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

function transcript(sessionID: string, state: Exclude<ChildState, "defect">, text = ""): SessionV1.WithParts[] {
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
  /** Park the write when a hold matches it; `inTransaction` tells whether it runs inside an open SQLite transaction. */
  readonly before: (publish: PublishView, inTransaction: Effect.Effect<boolean>) => Effect.Effect<void>
  readonly hold: Runner["hold"]
  /**
   * The runner is going away: nothing parks any more. Its finalizers (the
   * DagLoop releases its leases) must not wait for a hold the test never let go of.
   */
  readonly close: () => void
}

function makeGate(): Gate {
  const holds: Array<{
    readonly match: (publish: PublishView) => boolean
    readonly once: boolean
    readonly reached: Deferred.Deferred<void>
    readonly released: Deferred.Deferred<void>
    spent: boolean
  }> = []
  let closing = false
  return {
    close: () => void (closing = true),
    before: (publish, inTransaction) =>
      Effect.gen(function* () {
        if (closing) return
        const held = holds.find((item) => !item.spent && item.match(publish))
        if (!held) return
        // Parking inside a transaction would keep SQLite's write lock and freeze the other runner's connection.
        if (yield* inTransaction)
          yield* Effect.die(
            new Error(
              `a hold on ${publish.type} would park inside an open SQLite transaction (a DagTransact or DagMessages transaction) and keep its write lock; hold before the command instead`,
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

/**
 * The runner's Dag with the stall point at the command entry, ahead of the
 * workflow lock and of the command's transaction (see the module comment). A
 * hold matches the event the command publishes first (`dag.node.started` for
 * `nodeStarted`); `data` carries the command's arguments.
 */
function gatedDag(gate: Gate) {
  return Layer.effect(
    Dag.Service,
    Effect.gen(function* () {
      const real = yield* Dag.Service
      const { db } = yield* Database.Service
      const inTransaction = Effect.serviceOption(db.$client.transactionService).pipe(Effect.map(Option.isSome))
      const held =
        <Args extends ReadonlyArray<unknown>, A, E, R>(type: string, run: (...args: Args) => Effect.Effect<A, E, R>) =>
        (...args: Args): Effect.Effect<A, E, R> =>
          gate
            .before({ type, data: { dagID: args[0], args } }, inTransaction)
            .pipe(Effect.andThen(Effect.suspend(() => run(...args))))
      return Dag.Service.of({
        ...real,
        pause: held("dag.workflow.paused", real.pause),
        pauseForBudget: held("dag.workflow.paused", real.pauseForBudget),
        pauseForCheckpoint: held("dag.workflow.paused", real.pauseForCheckpoint),
        resume: held("dag.workflow.resumed", real.resume),
        step: held("dag.workflow.stepped", real.step),
        cancel: held("dag.workflow.cancelled", real.cancel),
        complete: held("dag.workflow.completed", real.complete),
        fail: held("dag.workflow.failed", real.fail),
        failUnrecoverable: held("dag.workflow.failed", real.failUnrecoverable),
        settleCompletion: held("dag.workflow.completed", real.settleCompletion),
        replan: held("dag.workflow.replanned", real.replan),
        extend: held("dag.workflow.replanned", real.extend),
        recover: held("dag.workflow.replanned", real.recover),
        retarget: held("dag.workflow.replanned", real.retarget),
        requeueNodes: held("dag.node.requeued", real.requeueNodes),
        nodeQueued: held("dag.node.queued", real.nodeQueued),
        nodeStarted: held("dag.node.started", real.nodeStarted),
        nodeCompleted: held("dag.node.completed", real.nodeCompleted),
        nodeFailed: held("dag.node.failed", real.nodeFailed),
        nodeSkipped: held("dag.node.skipped", real.nodeSkipped),
        nodeCancelled: held("dag.node.cancelled", real.nodeCancelled),
        nodeRestarted: held("dag.node.restarted", real.nodeRestarted),
        nodeTimeoutEscalated: held("dag.node.timeout_escalated", real.nodeTimeoutEscalated),
        nodeExtendTimeout: held("dag.node.deadline_extended", real.nodeExtendTimeout),
        extendTimeout: held("dag.node.deadline_extended", real.extendTimeout),
      })
    }),
  )
}

/**
 * The runner's `DagTransact` with a record of every write that carried a lease
 * token (a runner write), appended to `writes` once its transaction ended. The
 * record sits outside the transaction: it adds nothing to what the fence reads
 * or writes, and it is how a test sees that a zombie's write was refused.
 */
function recordedTransact(writes: FencedWrite[]) {
  return Layer.effect(
    DagTransact.Service,
    Effect.gen(function* () {
      const real = yield* DagTransact.Service
      return DagTransact.Service.of({
        transact: (dagID, token, body) => {
          const run = real.transact(dagID, token, body)
          if (token === undefined) return run
          return run.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                const failure = Exit.isFailure(exit)
                  ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                  : undefined
                if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return
                writes.push({
                  dagID,
                  token,
                  outcome: Exit.isSuccess(exit)
                    ? "committed"
                    : failure instanceof DagTransact.StaleRunnerError
                      ? "refused"
                      : "rejected",
                })
              }),
            ),
          )
        },
      })
    }),
  )
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

/**
 * The runner's lease primitives with the stall point in front of every
 * operation: a frozen process claims, renews and releases nothing. `faults`
 * arms a number of upcoming calls of an operation that die like a database
 * failure does (a defect, never a `false`). Every call that ran to its end is
 * appended to `calls` with its answer. `handle.lease` receives the primitives
 * without the stall point, the faults and the record.
 */
function gatedLease(gate: Gate, faults: Map<LeaseOperation, number>, calls: LeaseCall[], handle: GraphInput["handle"]) {
  return Layer.effect(
    DagLease.Service,
    Effect.gen(function* () {
      const real = yield* DagLease.Service
      handle.lease = real
      const through = <A extends LeaseCall["answer"]>(
        operation: LeaseOperation,
        dagID: string,
        effect: Effect.Effect<A>,
      ) =>
        gate.before({ type: `dag.lease.${operation}`, data: { dagID } }, Effect.succeed(false)).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const remaining = faults.get(operation) ?? 0
              if (remaining <= 0) return effect
              faults.set(operation, remaining - 1)
              return Effect.die(new Error(`injected ${operation} failure: database is locked`))
            }),
          ),
          Effect.tap((answer) => Effect.sync(() => void calls.push({ operation, dagID, answer }))),
        )
      return DagLease.Service.of({
        claim: (input) => through("claim", input.dagID, real.claim(input)),
        renew: (input) => through("renew", input.dagID, real.renew(input)),
        release: (input) => through("release", input.dagID, real.release(input)),
        held: (dagID) => through("held", dagID, real.held(dagID)),
      })
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
  readonly identity: RunnerIdentity
  readonly faults: Map<LeaseOperation, number>
  readonly leaseCalls: LeaseCall[]
  readonly fenced: FencedWrite[]
  readonly created: string[]
  readonly cancelled: string[]
  readonly prompts: Queue.Queue<PromptGate>
  /** The mocked `Session.create` writes through this runner's own connection; set once the graph is built. The lease is the graph's primitives without the stall point. */
  readonly handle: { db?: Database.Interface["db"]; lease?: DagLease.Interface }
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
  // The write fence the commands run in, on this runner's own connection. It reads the real lease
  // primitives: it is part of the command, not an operation of the loop, so it has no stall point.
  // It records the writes that carry a token (`Runner.fenced`).
  const fenceLease = DagLease.layer.pipe(Layer.provide(database))
  const transact = recordedTransact(input.fenced).pipe(
    Layer.provide(DagTransact.layer.pipe(Layer.provide(Layer.merge(database, fenceLease)))),
  )
  const dag = gatedDag(input.gate).pipe(
    Layer.provide(
      Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(messages), Layer.provide(transact)),
    ),
    Layer.provide(database),
  )
  // As in production the shared inbox is part of the graph the loop is built in.
  const inbox = SessionInbox.layer.pipe(Layer.provide(bridge), Layer.provide(status))
  // The loop claims and renews through the lease of its own graph, as the runner it names.
  const lease = gatedLease(input.gate, input.faults, input.leaseCalls, input.handle).pipe(
    Layer.provide(DagLease.layer.pipe(Layer.provide(database))),
  )
  const identity = Layer.succeed(RunnerLease.Identity, input.identity)
  const base = Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    messages,
    transact,
    dag,
    status,
    AgentScheduler.defaultLayer,
    inbox,
    lease,
    identity,
    // The loop builds this same layer reference itself; a build shares one instance, so a test can see its registrations.
    ExclusiveRegistry.defaultLayer,
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
      if (state === "defect") return Effect.die(new Error(`session store defect reading ${value.sessionID}`))
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
    const faults = new Map<LeaseOperation, number>()
    const leaseCalls: LeaseCall[] = []
    const fenced: FencedWrite[] = []
    const created: string[] = []
    const cancelled: string[] = []
    const prompts = yield* Queue.unbounded<PromptGate>()
    const handle: GraphInput["handle"] = {}
    const { layer, childRuns } = runnerGraph({
      ...input,
      gate,
      faults,
      leaseCalls,
      fenced,
      created,
      cancelled,
      prompts,
      handle,
    })

    // Each runner builds in its own root memo map: nothing is shared between the two graphs.
    const scope = yield* Scope.make()
    const stop = Effect.sync(gate.close).pipe(Effect.andThen(Scope.close(scope, Exit.void)))
    yield* Effect.addFinalizer(() => stop)
    const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope).pipe(Effect.orDie)
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideContext(context), Effect.provideService(InstanceRef, instanceContext))
    const run = <A, E>(effect: Effect.Effect<A, E, RunnerServices>): Effect.Effect<A, E> => provide(effect)

    const service = <I, S>(key: Context.Key<I, S>): S => Context.getUnsafe(context, key)
    const bound = <I, S extends object>(key: Context.Key<I, S>) => bind(service(key), provide)
    handle.db = service(Database.Service).db
    // Building the graph ran `gatedLease`, which left the primitives behind.
    const lease = handle.lease
    if (!lease) return yield* Effect.die(new Error("the runner graph did not build its DagLease"))
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
      lease,
      leaseCalls,
      fenced,
      exclusive: service(ExclusiveRegistry.Service),
      created,
      cancelled,
      prompts,
      childRuns,
      run,
      init: run(loopService.init().pipe(Effect.andThen(inboxService.init()))),
      nextPrompt: (message) =>
        Queue.take(prompts).pipe(
          Effect.timeoutOption(STALL_TOLERANCE),
          onRealClock,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                (typeof message === "string" ? Effect.succeed(message) : message).pipe(
                  Effect.flatMap((text) => Effect.fail(new Error(text))),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      hold: gate.hold,
      freeze: () => gate.hold(() => true, { once: false }),
      failLease: (operation, times) => void faults.set(operation, times),
      stop,
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
    // Reads go through R2's connection: R1's closes with `R1.stop`, and a test reads after it.
    const log: DualRunner["log"] = (dagID) =>
      r2.database.db
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
    const leaseRow: DualRunner["leaseRow"] = (dagID) =>
      r2.database.db
        .get<{ runner_id: string; epoch: number; expires_at: number }>(
          sql`SELECT runner_id, epoch, expires_at FROM dag_runner WHERE dag_id = ${dagID}`,
        )
        .pipe(
          Effect.orDie,
          Effect.map((row) =>
            row === undefined ? undefined : { runnerID: row.runner_id, epoch: row.epoch, expiresAt: row.expires_at },
          ),
        )
    const expireLease: DualRunner["expireLease"] = (dagID) =>
      r2.database.db
        .run(sql`UPDATE dag_runner SET expires_at = 0 WHERE dag_id = ${dagID}`)
        .pipe(Effect.orDie, Effect.asVoid)
    return { r1, r2, file, children, log, leaseRow, expireLease }
  })

/** Rounds of `pollOnTestClock` that move the clock, 20 ms of virtual time each: 10 s at most. */
const CLOCK_ROUNDS = 500

/**
 * `pollWithTimeout` for tests on the TestClock, where sleeping never ends: it
 * advances the clock a little between checks (20 ms of virtual time per round,
 * 500 rounds at most), so what it waits for must not depend on the lease's
 * clock moving by more than that.
 *
 * It is bounded in real time (`STALL_TOLERANCE`, or `patience`), not in rounds,
 * and every round also gives the runners' fibers a millisecond of real time (10
 * ms once the clock rounds are used up): an idle round takes a few hundred
 * microseconds, while what the fibers do between two checks (an adoption takes
 * tens of milliseconds, several times that on a loaded machine) is real work
 * that no count of rounds waits for. `message` is what a wait that gave up
 * reports; an effect is read at that moment, for the state a failure should
 * report (`describeRunner`).
 */
export const pollOnTestClock = <A>(
  check: Effect.Effect<A | undefined>,
  message: string | Effect.Effect<string>,
  options: { readonly patience?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    const patience = Duration.toMillis(Duration.fromInputUnsafe(options.patience ?? STALL_TOLERANCE))
    const started = performance.now()
    let round = 0
    for (; ; round++) {
      const found = yield* check
      if (found !== undefined) return found
      if (performance.now() - started >= patience) break
      if (round < CLOCK_ROUNDS) yield* TestClock.adjust("20 millis")
      yield* TestClock.withLive(Effect.sleep(round < CLOCK_ROUNDS ? "1 millis" : "10 millis"))
    }
    const reason = typeof message === "string" ? message : yield* message
    const waited = Math.round(performance.now() - started)
    return yield* Effect.fail(
      new Error(
        `${reason}\n  (gave up after ${waited} ms of real time and ${Math.min(round, CLOCK_ROUNDS)} clock rounds)`,
      ),
    )
  })

const showAnswer = (answer: LeaseCall["answer"]) =>
  answer === undefined
    ? "none"
    : typeof answer === "boolean"
      ? String(answer)
      : `${answer.runnerID} epoch ${answer.epoch}`

/**
 * What a wait that gave up says about one workflow and one runner: the workflow's
 * status, its lease row, and what the runner's loop did about it: its lease calls
 * (a `claim` answered "none" was refused, by another runner's live lease or
 * because the workflow had ended; no `claim` at all was never tried), the child
 * sessions it created and the writes it made under its token. It is what tells
 * a runner that is slow from one that was refused.
 */
export const describeRunner = (dual: DualRunner, runner: Runner, dagID: string) =>
  Effect.gen(function* () {
    // Reads go through R2's connection: R1's closes with `R1.stop`.
    const workflow = yield* dual.r2.store.getWorkflow(dagID)
    const row = yield* dual.leaseRow(dagID)
    const calls = runner.leaseCalls.filter((call) => call.dagID === dagID)
    const writes = runner.fenced.filter((write) => write.dagID === dagID)
    const list = (items: ReadonlyArray<string>) => (items.length === 0 ? "none" : items.join(", "))
    return [
      `workflow ${dagID}: ${workflow?.status ?? "not found"}`,
      `lease row: ${row === undefined ? "none" : `${row.runnerID} epoch ${row.epoch}, expires ${row.expiresAt}`} (clock ${yield* Clock.currentTimeMillis})`,
      `${runner.name} lease calls: ${list(calls.map((call) => `${call.operation} -> ${showAnswer(call.answer)}`))}`,
      `${runner.name} created: ${list(runner.created)}`,
      `${runner.name} fenced writes: ${list(writes.map((write) => write.outcome))}`,
    ].join("\n  ")
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
