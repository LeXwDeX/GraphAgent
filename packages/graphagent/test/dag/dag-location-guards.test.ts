// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The two-instance
// harness deliberately mirrors dag-loop-guards.test.ts: mocked service layers
// and seeded row fixtures use `as never` type shims (mock objects implement
// only the interface slice the scenario exercises). The shims are type-only;
// converting them would fork the template's shape without changing behavior.
/**
 * DAG-LOC-01 round 2 — execution-location RED probes.
 *
 * The DAG runtime guards key ownership on the PROJECT ID only
 * (`wf.projectId !== ctx.project.id` in DagLoop.recoverWorkflow,
 * recoverOrphanPending, the WorkflowStarted handler, and the startup wake
 * sweep; the idle-Status wake path has no ownership guard at all). Two
 * instances of the SAME project in DIFFERENT directories (sibling worktrees
 * of one project) therefore both pass every guard: a foreign directory can
 * adopt, recover-cancel, wake, and spawn for a session it does not own.
 *
 * Invariant under test: the execution-location key must be the DIRECTORY.
 * Only the instance whose directory owns the session/workflow may act.
 *
 * Probe map (round 1 scenario → probe):
 *   S1 adoption                → R1
 *   S2 running recovery        → R2 (the severe one)
 *   S5 idle wake               → R3
 *   S4 startup wake sweep      → R4
 *   deletion teardown          → R5
 *   identity-migration teardown→ R6
 *   static contract            → R7
 *
 * Harness: two-instance extension of the dag-loop-guards.test.ts runGuardTest
 * template. ONE shared layer graph (store, event bus, dag service) plus ONE
 * DagLoop layer whose per-directory InstanceState is created by two init
 * calls under two InstanceRefs — the same structure a multi-directory server
 * uses. Observables (prompt queues, cancels, interrupts) are routed by the
 * AMBIENT instance directory, so each probe can tell which instance acted.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Logger, Scope } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { SessionV1 as SessionV1Events } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { SessionProjector } from "@graphagent/core/session/projector"
import { WorkflowTable, WorkflowNodeTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Location } from "@graphagent/schema/location"
import { SessionEvent } from "@graphagent/schema/session-event"
import { SessionStatusEvent } from "@graphagent/schema/session-status-event"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { makeDeadlineWatcher } from "@/dag/runtime/spawn"
import { DagLocation } from "@/dag/location"
import { Goal } from "@/goal/goal"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Provider } from "@/provider/provider"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { makeNodeRow } from "./fixtures"
import { eq } from "drizzle-orm"
import { EventTable } from "@graphagent/core/event/sql"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PROJECT_ID = "project-1"
// #948 requires execution directories to exist. Keep this harness on real
// worktree-shaped directories so every adoption/spawn path exercises the same
// existence check production now performs (a /wtA that does not exist would
// be correctly terminalized as workspace_missing).
const directoryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-location-guards-")))
const DIR_A = path.join(directoryRoot, "wtA")
const DIR_B = path.join(directoryRoot, "wtB")
mkdirSync(DIR_A, { recursive: true })
mkdirSync(DIR_B, { recursive: true })
afterAll(() => rmSync(directoryRoot, { recursive: true, force: true }))
const SES_A = "sesA"
const SES_B = "sesB"

interface PromptGate {
  readonly title: string
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<string>
}

function node(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id: "n1",
    name: "Node 1",
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: "work" },
    ...overrides,
  }
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("1 second"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
  } as never
}

/**
 * Publish the durable SessionEvent.Moved that the control-plane's move-session
 * publishes. The session projector's Moved projection re-stamps every workflow
 * row of the session in the SAME transaction (payload-sourced, no SessionTable
 * read) — the #269 atomic-adoption transition under test.
 */
function moveSession(bridge: EventV2.Interface, sessionID: string, directory: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* bridge
      .publish(SessionEvent.Moved, {
        sessionID: sessionID as never,
        location: Location.Ref.make({ directory: directory as never }),
        timestamp: yield* DateTime.now,
      })
      .pipe(Effect.orDie)
  })
}

// ---------------------------------------------------------------------------
// Two-instance harness (extension of dag-loop-guards.test.ts guardLayer /
// runGuardTest): two InstanceRefs, DISTINCT directories, SAME project id.
// ---------------------------------------------------------------------------

interface TwoInstanceInput {
  readonly directoryA: string
  readonly directoryB: string
  /** Ambient-directory → prompt gates; each instance's loop delivers to its own queue. */
  readonly childPrompts: Map<string, Queue.Queue<PromptGate>>
  /** Ambient-directory → cancel log; promptSvc.cancel routes by caller directory. */
  readonly cancels: Map<string, string[]>
  /** Records interrupts of a parked child prompt (deletion-teardown probe). */
  readonly promptInterrupts: string[]
  /** Seeded per-child-session messages read by the recovery status checker. */
  readonly messagesBySession: Map<string, SessionV1.WithParts[]>
  /** Injected one-shot defects for DagStore.getWorkflow (parity with the template). */
  readonly failGetWorkflow?: { remaining: number }
  /**
   * Admit and run delivered wakes instead of returning `none` from
   * prepareIfIdle. Used by the notification-ownership probe; default off so
   * every other probe keeps its no-delivery baseline.
   */
  readonly deliverWakes?: boolean
   /**
    * Optional deterministic park on DagStore.getNodes. When present, every
    * getNodes call sets `parked.value = true` and then awaits `wait` before
    * delegating to the real store — letting a probe interleave a mutation
    * (e.g. Session.remove) inside a recovery sequence. `calls` counts every
    * gated getNodes invocation so a probe can tell HOW MANY distinct
    * adoption/recovery sequences reached the seam (H1 adopt-exactly-once).
    */
   readonly parkGetNodes?: {
    readonly wait: Promise<void>
    readonly parked: { value: boolean }
    readonly calls: { value: number }
  }
  /**
   * Optional deterministic park on SessionPrompt.prepareIfIdle (the wake
   * delivery admission seam). When present, each prepareIfIdle call bumps
   * `calls`; before `released.value` it parks the admission's result effect
   * on `wait` so a probe can interleave Session.remove mid-delivery. After
   * release, prepareIfIdle returns none (the call itself still proves the
   * idle subscription survived).
   */
   readonly parkWakeDelivery?: {
     readonly wait: Promise<void>
     readonly parked: { value: boolean }
     readonly released: { value: boolean }
     readonly calls: { value: number }
   }
   /**
    * Optional deterministic park on DagStore.tryClaimAdoption (the #270 atomic
    * admission fence). Each claim bumps `calls`; the first `skip` claims pass
    * through unparked (e.g. the adoption claim), every later claim sets
    * `parked.value = true` and parks on `wait` before delegating — letting a
    * probe interleave Session.remove between the passed admission and the
    * in-flight spawn's child-session creation (the deletion-race probe C7).
    */
   readonly parkAdoptionClaim?: {
     readonly wait: Promise<void>
     readonly parked: { value: boolean }
     readonly calls: { value: number }
     readonly skip: number
   }
 }

function twoInstanceLayer(input: TwoInstanceInput) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const realStore = DagStore.layer.pipe(Layer.provide(database))
  const needsStoreWrapper = Boolean(input.failGetWorkflow) || Boolean(input.parkGetNodes) || Boolean(input.parkAdoptionClaim)
  const store = needsStoreWrapper
    ? Layer.effect(
        DagStore.Service,
        Effect.gen(function* () {
          const real = yield* DagStore.Service
          return DagStore.Service.of({
            ...real,
            getWorkflow: (id) =>
              Effect.suspend(() => {
                if (input.failGetWorkflow && input.failGetWorkflow.remaining > 0) {
                  input.failGetWorkflow.remaining--
                  return Effect.die(new Error("injected transient db failure"))
                }
                return real.getWorkflow(id)
              }),
            getNodes: (id) =>
              Effect.suspend(() => {
                const gate = input.parkGetNodes
                if (!gate) return real.getNodes(id)
                gate.calls.value++
                gate.parked.value = true
                return Effect.promise(() => gate.wait).pipe(Effect.flatMap(() => real.getNodes(id)))
              }),
            tryClaimAdoption: (id) =>
              Effect.suspend(() => {
                const gate = input.parkAdoptionClaim
                if (!gate) return real.tryClaimAdoption(id)
                gate.calls.value++
                if (gate.calls.value <= gate.skip) return real.tryClaimAdoption(id)
                gate.parked.value = true
                return Effect.promise(() => gate.wait).pipe(Effect.flatMap(() => real.tryClaimAdoption(id)))
              }),
          })
        }),
      ).pipe(Layer.provide(realStore))
    : realStore
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  // The session projector runs the SessionEvent.Moved projection (session row
  // + workflow directory re-stamp — the #269 atomic-adoption transition), so
  // publishing Moved through the bridge converges the workflow stamps in the
  // same durable transaction, exactly as production.
  const sessionProjector = SessionProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const base = Layer.mergeAll(database, events, bridge, store, projector, sessionProjector, dag, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    // The notification-only ownership check reads the parent session's
    // durable directory; route it by session id, not by the caller (a sibling
    // may ask for the other directory's session).
    get: (id) =>
      Effect.succeed({
        id,
        directory: String(id) === SES_B ? input.directoryB : input.directoryA,
        permission: [],
        agent: "build",
      } as never),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: (value) =>
      Effect.sync(() => {
        const sessionID = (value as { sessionID?: string }).sessionID
        return sessionID ? (input.messagesBySession.get(sessionID) ?? []) : []
      }),
    // Mimics the real remove contract: the durable session row is deleted (the
    // FK cascade wipes workflow + node rows) and SessionV1.Event.Deleted is
    // published for teardown subscribers.
    remove: ((sessionID: Session.Interface["remove"] extends (sessionID: infer A) => unknown ? A : never) =>
      Effect.gen(function* () {
        const db = yield* Database.Service
        const rows = yield* db.db.select().from(SessionTable)
          .where(eq(SessionTable.id, sessionID as never))
          .all().pipe(Effect.orDie)
        const row = rows[0]
        yield* db.db.delete(SessionTable).where(eq(SessionTable.id, sessionID as never)).run().pipe(Effect.orDie)
        const bridgeSvc = yield* EventV2Bridge.Service
        // Same shape the real remove publishes (SessionV1.Event.Deleted with
        // the session's info); the schema requires id/slug/projectID/
        // directory/title/version/time.
        yield* bridgeSvc.publish(SessionV1Events.Event.Deleted, {
          sessionID: sessionID as never,
          info: {
            id: row?.id ?? sessionID,
            slug: row?.slug ?? "deleted",
            projectID: row?.project_id ?? PROJECT_ID,
            directory: row?.directory ?? input.directoryA,
            title: row?.title ?? "Deleted session",
            version: row?.version ?? "test",
            time: { created: Date.now(), updated: Date.now() },
          } as never,
        }).pipe(Effect.orDie)
      })) as unknown as Session.Interface["remove"],
  })
  const queueFor = (dir: string | undefined) =>
    input.childPrompts.get(dir ?? input.directoryA) ?? input.childPrompts.get(input.directoryA)!
  const cancelsFor = (dir: string | undefined) =>
    input.cancels.get(dir ?? input.directoryA) ?? input.cancels.get(input.directoryA)!
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    // Route the observation by the CALLING instance's directory (the ambient
    // InstanceRef of the loop handler fiber), so each probe can attribute the
    // delivery to instance A or B.
    const dir = (yield* InstanceRef)?.directory
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(queueFor(dir), {
      title: childTitles.get(sessionID) ?? sessionID,
      input: value,
      release,
    })
    const text = yield* Deferred.await(release).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          input.promptInterrupts.push(sessionID)
        }),
      ),
    )
    return reply(sessionID, text)
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    cancel: (sessionID) =>
      Effect.gen(function* () {
        const dir = (yield* InstanceRef)?.directory
        cancelsFor(dir).push(sessionID as string)
      }),
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
    // Wake-delivery admission seam (C2). tryDeliverWake delivers through
    // admitIfIdle → prepareIfIdle, not promptIfIdle. Without a gate this
    // returns none (no admission); with parkWakeDelivery it parks the result
    // effect on the gate so a probe can race Session.remove mid-delivery.
    prepareIfIdle: (value, persistAdmission) =>
      Effect.sync(() => {
        const gate = input.parkWakeDelivery
        if (!gate) {
          if (!input.deliverWakes) return Option.none()
          return Option.some({ activate: Effect.void, result: deliver(value), abort: Effect.void })
        }
        gate.calls.value++
        if (gate.released.value) return Option.none()
        gate.parked.value = true
        const result = Effect.promise(() => gate.wait).pipe(
          Effect.flatMap(() =>
            Effect.die(new Error(`session ${(value as { sessionID?: string }).sessionID} removed during wake delivery`)),
          ),
        )
        return Option.some({ activate: Effect.void, result, abort: Effect.void })
      }).pipe(Effect.tap((prepared) => Option.isSome(prepared) ? persistAdmission ?? Effect.void : Effect.void)),
  })
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  const sweep = DagSupervisionSweep.layerWithoutDeps.pipe(
    Layer.provide(base),
    Layer.provide(prompt),
    Layer.provide(SessionAutomationLease.defaultLayer),
  )
  // The session mock is also surfaced to the test body (Session.remove for
  // the deletion-teardown probe); mergeAll memoizes by layer identity, so the
  // instance the loop sees is the same one the test drives.
  return Layer.mergeAll(base, loop, session, sweep)
}

interface TwoInstanceServices {
  readonly dag: Dag.Interface
  readonly loop: DagLoop.Interface
  readonly sweep: DagSupervisionSweep.Interface
  readonly store: DagStore.Interface
  readonly database: Database.Interface
  readonly bridge: EventV2.Interface
  readonly session: Session.Interface
  /** Boot the loop under instance A's directory. */
  readonly initA: Effect.Effect<void>
  /** Boot the loop under instance B's directory. */
  readonly initB: Effect.Effect<void>
  readonly childPromptsA: Queue.Queue<PromptGate>
  readonly childPromptsB: Queue.Queue<PromptGate>
  readonly cancelsA: string[]
  readonly cancelsB: string[]
  readonly promptInterrupts: string[]
  readonly messagesBySession: Map<string, SessionV1.WithParts[]>
}

function runTwoInstanceGuardTest<A>(
  options: {
    readonly projectID?: string
    readonly directoryA?: string
    readonly directoryB?: string
    readonly sessionA?: string
    readonly sessionB?: string
    readonly deliverWakes?: boolean
    readonly failGetWorkflow?: { remaining: number }
    readonly parkGetNodes?: {
      readonly wait: Promise<void>
      readonly parked: { value: boolean }
      readonly calls: { value: number }
    }
    readonly parkWakeDelivery?: {
      readonly wait: Promise<void>
      readonly parked: { value: boolean }
      readonly released: { value: boolean }
      readonly calls: { value: number }
    }
    readonly parkAdoptionClaim?: {
      readonly wait: Promise<void>
      readonly parked: { value: boolean }
      readonly calls: { value: number }
      readonly skip: number
    }
  },
  test: (services: TwoInstanceServices) => Effect.Effect<A, Error>,
  beforeInit?: (services: { readonly database: Database.Interface }) => Effect.Effect<void>,
) {
  const projectID = options.projectID ?? PROJECT_ID
  const directoryA = options.directoryA ?? DIR_A
  const directoryB = options.directoryB ?? DIR_B
  const sessionA = options.sessionA ?? SES_A
  const sessionB = options.sessionB ?? SES_B
  return Effect.gen(function* () {
    const childPromptsA = yield* Queue.unbounded<PromptGate>()
    const childPromptsB = yield* Queue.unbounded<PromptGate>()
    const cancelsA: string[] = []
    const cancelsB: string[] = []
    const promptInterrupts: string[] = []
    const messagesBySession = new Map<string, SessionV1.WithParts[]>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const sweep = yield* DagSupervisionSweep.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      const bridge = yield* EventV2Bridge.Service
      const session = yield* Session.Service
      // ONE project row; TWO sessions in the SAME project but DISTINCT
      // directories — sibling worktrees of one project.
      yield* database.db.insert(ProjectTable).values({
        id: projectID as never,
        worktree: directoryA as never,
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      for (const [id, dir, slug, title] of [
        [sessionA, directoryA, "a", "Parent A"],
        [sessionB, directoryB, "b", "Parent B"],
      ] as const) {
        yield* database.db.insert(SessionTable).values({
          id: id as never,
          project_id: projectID as never,
          slug,
          directory: dir as never,
          title,
          version: "test",
        }).run().pipe(Effect.orDie)
      }
      if (beforeInit) yield* beforeInit({ database })
      const refB = {
        directory: directoryB,
        worktree: directoryB,
        project: { id: projectID },
      } as never
      return yield* test({
        dag,
        loop,
        sweep,
        store,
        database,
        bridge,
        session,
        // initA uses the ambient InstanceRef (directory A, provided below);
        // initB shadows it with B's InstanceRef.
        initA: loop.init(),
        initB: loop.init().pipe(Effect.provideService(InstanceRef, refB)),
        childPromptsA,
        childPromptsB,
        cancelsA,
        cancelsB,
        promptInterrupts,
        messagesBySession,
      })
    }).pipe(
      Effect.provide(twoInstanceLayer({
        directoryA,
        directoryB,
        childPrompts: new Map([
          [directoryA, childPromptsA],
          [directoryB, childPromptsB],
        ]),
        cancels: new Map([
          [directoryA, cancelsA],
          [directoryB, cancelsB],
        ]),
        promptInterrupts,
        messagesBySession,
        deliverWakes: options.deliverWakes,
        failGetWorkflow: options.failGetWorkflow,
        parkGetNodes: options.parkGetNodes,
        parkWakeDelivery: options.parkWakeDelivery,
        parkAdoptionClaim: options.parkAdoptionClaim,
      })),
      Effect.provideService(InstanceRef, {
        directory: directoryA,
        worktree: directoryA,
        project: { id: projectID },
      } as never),
      Effect.scoped,
    )
  })
}

/** Seed a terminal (failed) workflow owned by sesA with an unreported wake. */
function seedTerminalWorkflow(
  services: { readonly database: Database.Interface },
  wakeReported: boolean,
) {
  return services.database.db.insert(WorkflowTable).values({
    id: "wake-wf",
    project_id: PROJECT_ID as never,
    session_id: SES_A as never,
    directory: DIR_A as never,
    target_fingerprint: { kind: "none" },
    title: "Terminal workflow for sesA",
    status: "failed",
    config: "{}",
    seq: 5,
    wake_reported: wakeReported,
  }).run().pipe(Effect.orDie, Effect.as(undefined))
}

// ---------------------------------------------------------------------------
// Behavior probes R1–R6
// ---------------------------------------------------------------------------

describe("DAG execution-location guards (DAG-LOC-01)", () => {
  it("R1/S1: a booted sibling instance does not adopt a workflow created for another directory's session", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, initB, childPromptsB }) =>
          Effect.gen(function* () {
            // Instance B is booted; instance A is not (booting A would race
            // the first-wave spawn on the shared dag service and mask B's
            // independent adoption defect). The workflow is created for A's
            // session — stamped with A's directory /wtA.
            yield* initB
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "A's workflow",
              config: { name: "r1", nodes: [node()] },
            })
            yield* Effect.sleep("400 millis")
            const foreignChild = Option.getOrElse(yield* Queue.poll(childPromptsB), () => null)
            expect(foreignChild).toBe(null)
            const nodes = yield* store.getNodes(dagID)
            expect(nodes).toHaveLength(1)
            expect(nodes[0]?.status).toBe("pending")
          }),
      ),
    )
  })

  it("R2/S2: a sibling directory's startup recovery does not cancel the owner's live child", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, initA, initB, childPromptsA, cancelsB, messagesBySession }) =>
          Effect.gen(function* () {
            // A boots first and owns the workflow: it adopts through the
            // WorkflowStarted handler (no reconciliation) and spawns n1.
            yield* initA
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "A's running workflow",
              config: { name: "r2", nodes: [node()] },
            })
            const child = yield* takeWithin(childPromptsA, "owner did not start its node")
            const childSessionID = child.input.sessionID as string
            // The child's last durable message is a non-terminal assistant
            // part: the session is live and executing under A's directory.
            messagesBySession.set(childSessionID, [reply(childSessionID, "still working")])
            // B boots and its startup scan reconciles every running workflow.
            // B must not touch a workflow owned by another directory.
            yield* initB
            const nodes = yield* store.getNodes(dagID)
            const workflow = yield* store.getWorkflow(dagID)
            expect(cancelsB).toHaveLength(0)
            expect(nodes[0]?.status).toBe("running")
            expect(workflow?.status).toBe("running")
          }),
      ),
    )
  })

  it("R3/S5: a sibling instance ignores an idle Status event for another directory's session", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ database, bridge, initB, childPromptsB }) =>
          Effect.gen(function* () {
            yield* initB
            // Re-arm the terminal workflow's wake AFTER B's startup sweep has
            // passed over it, so the delivery below can only come from the
            // idle-Status subscription path.
            yield* database.db.update(WorkflowTable)
              .set({ wake_reported: false })
              .where(eq(WorkflowTable.id, "wake-wf"))
              .run().pipe(Effect.orDie)
            yield* bridge.publish(SessionStatusEvent.Status, {
              sessionID: SES_A as never,
              status: { type: "idle" },
            }).pipe(Effect.orDie)
            const delivered = yield* Queue.take(childPromptsB).pipe(Effect.timeoutOption("1 second"))
            expect(Option.getOrElse(delivered, () => null)).toBe(null)
          }),
        (services) => seedTerminalWorkflow(services, true),
      ),
    )
  })

  it("R4/S4: a sibling instance's startup sweep does not deliver another directory's session wakes", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ initB, childPromptsB }) =>
          Effect.gen(function* () {
            yield* initB
            // The unreported terminal workflow for sesA exists BEFORE B boots;
            // B's startup wake sweep must leave it alone.
            const delivered = yield* Queue.take(childPromptsB).pipe(Effect.timeoutOption("1 second"))
            expect(Option.getOrElse(delivered, () => null)).toBe(null)
          }),
        (services) => seedTerminalWorkflow(services, false),
      ),
    )
  })

  it("R5: Session.remove drops the in-memory entry before a later stimulus can act on it", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, bridge, session, initA, childPromptsA, promptInterrupts }) =>
          Effect.gen(function* () {
            yield* initA
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "Delete me",
              config: { name: "r5", nodes: [node()] },
            })
            yield* takeWithin(childPromptsA, "node did not start")
            // Remove the parent session. The FK cascade wipes the workflow and
            // node rows; the in-memory runtime entry must go with them.
            yield* session.remove(SES_A as never)
            expect(yield* store.getWorkflow(dagID)).toBeUndefined()
            // The deletion teardown is event-driven (SessionV1.Event.Deleted is
            // fanned out async): wait for its interrupt of the parked child to
            // be recorded so `before` is sampled on a settled teardown.
            yield* pollWithTimeout(
              Effect.sync(() => (promptInterrupts.length > 0 ? true : undefined)),
              "deletion teardown never interrupted the parked child",
              "1 second",
            )
            const before = promptInterrupts.length
            // Workflow-terminal stimulus on the deleted workflow. The terminal
            // handler is gated on runtimes.has(dagID): if the entry was dropped
            // at deletion the handler never fires and the parked child prompt
            // fiber is left untouched by this stimulus.
            yield* bridge.publish(DagEvent.WorkflowCancelled, {
              dagID: dagID as never,
              timestamp: yield* DateTime.now,
            }).pipe(Effect.orDie)
            // Negative window: give the stimulus handler time to (wrongly) act,
            // then assert it added no further interrupts. (pollWithTimeout is a
            // positive-wait tool — its timeout errors the effect rather than
            // returning a fallback, so a "nothing must happen" window is
            // asserted with sleep + snapshot instead.)
            yield* Effect.sleep("300 millis")
            expect(promptInterrupts.slice(before)).toEqual([])
          }),
      ),
    )
  })

  it("R6: an identity migration invalidates the in-memory entry", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, database, initA, childPromptsA }) =>
          Effect.gen(function* () {
            yield* initA
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "Migrate me",
              config: { name: "r6", nodes: [node()] },
            })
            yield* takeWithin(childPromptsA, "node did not start")
            // Identity migration: repaint the workflow's project id (old →
            // new). The in-memory entry must not keep driving the migrated
            // workflow.
            yield* database.db.update(WorkflowTable)
              .set({ project_id: "project-new" as never })
              .where(eq(WorkflowTable.id, dagID as never))
              .run().pipe(Effect.orDie)
            // Node-completion stimulus: the stale entry must not publish a
            // workflow transition (here: running → completed) for a workflow
            // whose durable identity moved away.
            yield* dag.nodeCompleted(dagID, "n1", { ok: true })
            // The node itself completes (the durable event projects), which
            // proves the stimulus was delivered to the runtime.
            expect((yield* store.getNode(dagID, "n1"))?.status).toBe("completed")
            // Negative window: give the completion path time to (wrongly)
            // publish a workflow transition, then assert the workflow is still
            // running. (pollWithTimeout is a positive-wait tool — its timeout
            // errors the effect rather than returning a fallback, so the
            // negative assertion is a sleep + snapshot.)
            yield* Effect.sleep("300 millis")
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          }),
        ({ database }) =>
          database.db.insert(ProjectTable).values({
            id: "project-new" as never,
            worktree: process.cwd() as never,
            sandboxes: [],
          }).run().pipe(Effect.orDie, Effect.as(undefined)),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// R7 — static contract
// ---------------------------------------------------------------------------

describe("DAG execution-location static contract (DAG-LOC-01 R7)", () => {
  const graphagentDagSrc = path.resolve(import.meta.dir, "../../src/dag")
  const coreDagSrc = path.resolve(import.meta.dir, "../../../../packages/core/src/dag")

  function readDagSources(root: string): Array<{ file: string; source: string }> {
    const out: Array<{ file: string; source: string }> = []
    if (!existsSync(root)) throw new Error(`dag source root missing: ${root}`)
    for (const entry of readdirSync(root, { recursive: true })) {
      const full = path.join(root, String(entry))
      if (!full.endsWith(".ts")) continue
      out.push({ file: full, source: readFileSync(full, "utf8") })
    }
    return out
  }

  it("keys every adoption/wake guard on the directory and never on the session directory column", () => {
    const sources = [...readDagSources(graphagentDagSrc), ...readDagSources(coreDagSrc)]
    expect(sources.length).toBeGreaterThan(20)

    // Negative half: the dag sources must not read the session's directory
    // column (session.directory / SessionTable.directory) — the execution-
    // location key belongs on the workflow row itself, stamped at create.
    // #948's notification-only gate goes through Session.Service.get instead:
    // it may decide who DELIVERS a terminal-only wake, never who may execute.
    const sessionDirRefs = sources
      .filter(({ source }) => /session\.directory|SessionTable\.directory/.test(source))
      .map(({ file }) => file)
    expect(sessionDirRefs).toEqual([])

    const loopFile = sources.find((s) => s.file.endsWith("graphagent/src/dag/runtime/loop.ts"))
    expect(loopFile).toBeDefined()
    const deliveryFile = sources.find((s) => s.file.endsWith("graphagent/src/dag/runtime/delivery.ts"))
    expect(deliveryFile).toBeDefined()

    // Positive half: every adoption/wake ownership gate must carry a
    // directory-level check. The four adoption sites live in the loop and the
    // wake-delivery path lives in the D7 delivery module; both are located by
    // their semantic anchors so the probe survives refactors that keep the
    // handler boundaries.
    const regions: Array<{ name: string; source: string; from: string; to: string }> = [
      {
        name: "recoverWorkflow (startup recovery adoption)",
        source: loopFile!.source,
        from: "const recoverWorkflow = Effect.fn(",
        to: "// Orphan-pending recovery",
      },
      {
        name: "recoverOrphanPending (orphan-pending sweep)",
        source: loopFile!.source,
        from: "const recoverOrphanPending = Effect.fn(",
        to: "yield* events.subscribe(DagEvent.WorkflowStarted)",
      },
      {
        name: "WorkflowStarted handler (first-wave adoption)",
        source: loopFile!.source,
        from: "yield* events.subscribe(DagEvent.WorkflowStarted)",
        to: "for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped, DagEvent.NodeAborted])",
      },
      {
        name: "startup wake sweep",
        source: loopFile!.source,
        from: "const pendingWakeSessions =",
        to: "return {}",
      },
      {
        name: "DagDelivery.deliverWake (idle-Status wake delivery path)",
        source: deliveryFile!.source,
        from: 'const deliverWake = Effect.fn("DagDelivery.deliverWake")',
        to: "// The in-flight reservation must have a finite lifetime",
      },
    ]
    const unguarded: string[] = []
    for (const region of regions) {
      const start = region.source.indexOf(region.from)
      const end = region.source.indexOf(region.to, start)
      if (start === -1 || end === -1) {
        unguarded.push(`${region.name}: anchor not found (from="${region.from}" to="${region.to}")`)
        continue
      }
      // Scan CODE lines only — the guard must be an executable directory
      // comparison, not a mention in an adjacent comment.
      const codeLines = region.source
        .slice(start, end)
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
      if (!codeLines.some((line) => /directory/.test(line))) {
        unguarded.push(`${region.name}: no directory-level ownership check in handler body`)
      }
    }
    expect(unguarded).toEqual([])
  })

  // #238 probe ⑤ (R7-ext): the directory stamp is WRITE-ONCE EXCEPT the single
  // whitelisted SessionEvent.Moved re-stamp (#269 — an invariant UPDATE mandated
  // by #269's own wording, not a weakening), and every revalidation site that
  // acts on a possibly-stale in-memory entry carries the ownership authority.
  it("R7-ext: the stamp is write-once and every revalidation site carries the authority", () => {
    const sources = [...readDagSources(graphagentDagSrc), ...readDagSources(coreDagSrc)]
    expect(sources.length).toBeGreaterThan(20)
    const codeLines = (source: string) =>
      source.split("\n").filter((line) => !line.trim().startsWith("//"))

    // (a) TWO-WRITER WHITELIST (amended for #269 — an invariant UPDATE, not a
    // weakening): the directory stamp is WRITE-ONCE except for exactly ONE
    // sanctioned re-stamp. The ONLY directory writers are
    //   1. the dag projector's WorkflowCreated INSERT (create-time stamp,
    //      onConflictDoNothing — a replay can never rewrite an existing stamp),
    //   2. the session projector's SessionEvent.Moved re-stamp (#269 — the stamp
    //      moves WITH the session in one transaction, payload-sourced, no
    //      SessionTable read).
    // Negative half (unchanged): no `.set({ directory })` anywhere in the dag
    // trees — a dag-side re-stamp would violate create-time-pins-ownership.
    const writesDirectory = sources
      .filter(({ source }) => /\.set\(\{[\s\S]{0,300}?\bdirectory\s*:/.test(source))
      .map(({ file }) => file)
    expect(writesDirectory).toEqual([])
    // Positive whitelist half: the Moved re-stamp MUST exist in the session
    // projector (outside the dag trees) and MUST be the payload-sourced
    // WorkflowTable re-stamp (event.data.location.directory). Mandated by #269's
    // "the directory stamp must move WITH the session in one transaction" — so
    // this probe pins it; removing the re-stamp is a regression here.
    const sessionProjectorSource = readFileSync(
      path.resolve(import.meta.dir, "../../../../packages/core/src/session/projector.ts"),
      "utf8",
    )
    expect(
      /\.update\(WorkflowTable\)[\s\S]{0,400}?\.set\(\{\s*directory:\s*event\.data\.location\.directory/.test(
        sessionProjectorSource,
      ),
    ).toBe(true)

    // (b) Revalidation sites. Each region must carry an executable ownership
    // authority call (ownsWorkflow / ownsSession), located by semantic anchors
    // so the probe survives refactors that keep the site boundaries.
    const loopFile = sources.find((s) => s.file.endsWith("graphagent/src/dag/runtime/loop.ts"))
    expect(loopFile).toBeDefined()
    const loopSource = loopFile!.source
    const spawnFile = sources.find((s) => s.file.endsWith("graphagent/src/dag/runtime/spawn.ts"))
    expect(spawnFile).toBeDefined()

    const regions: Array<{ name: string; source: string; from: string; to: string; authority: RegExp }> = [
      {
        name: "spawnReady (pre-spawn ownership revalidation + inert-entry eviction)",
        source: loopSource,
        from: "const spawnReady = Effect.fn(",
        to: "const checkCompletion = Effect.fn(",
        authority: /ownsWorkflow\(/,
      },
      {
        name: "checkCompletion (terminal-transition ownership revalidation)",
        source: loopSource,
        from: "const checkCompletion = Effect.fn(",
        to: "const checkSessionStatus = makeSessionStatusChecker",
        authority: /ownsWorkflow\(/,
      },
      {
        name: "makeDeadlineWatcher (deadline-supervision ownership revalidation)",
        source: spawnFile!.source,
        from: "export function makeDeadlineWatcher(",
        to: "export function spawnNode(",
        authority: /ownsWorkflow\(/,
      },
    ]
    const unguarded: string[] = []
    for (const region of regions) {
      const start = region.source.indexOf(region.from)
      const end = region.source.indexOf(region.to, start)
      if (start === -1 || end === -1) {
        unguarded.push(`${region.name}: anchor not found (from="${region.from}" to="${region.to}")`)
        continue
      }
      if (!codeLines(region.source.slice(start, end)).some((line) => region.authority.test(line))) {
        unguarded.push(`${region.name}: no ownership-authority call in handler body`)
      }
    }

    // The goal-side idle guard lives in src/goal/loop.ts (outside the dag
    // trees) and keys on the session row via Goal.ownsSession.
    const goalLoopSource = readFileSync(path.resolve(import.meta.dir, "../../src/goal/loop.ts"), "utf8")
    if (!codeLines(goalLoopSource).some((line) => /ownsSession\(/.test(line))) {
      unguarded.push("GoalLoop idle-Status guard: no Goal.ownsSession call")
    }
    expect(unguarded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// P2 follow-up probes (review findings against the round-3 slice)
// ---------------------------------------------------------------------------

/**
 * Goal-side harness: real Database + real Goal + real EventV2Bridge +
 * real SessionStatus with the GoalLoop layer on top, Session/Prompt/Provider
 * mocked. The judge LLM is injected (GoalLoopJudgeLLM) and routed by the
 * AMBIENT instance directory so a probe can attribute each judge call to
 * instance A or B — the same routing trick the dag two-instance harness uses.
 */
function goalLoopLayer(input: {
  readonly judgeCalls: Map<string, number[]>
  readonly continuationCalls: Map<string, number[]>
  readonly messagesBySession: Map<string, SessionV1.WithParts[]>
  /** Ambient Database output for the merged graph; defaults to the shared one. */
  readonly ambientDatabase?: Layer.Layer<Database.Service>
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const goal = Goal.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(database),
    Layer.provide(status),
  )
  const judge = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.gen(function* () {
          const dir = (yield* InstanceRef)?.directory ?? ""
          const list = input.judgeCalls.get(dir) ?? []
          list.push(1)
          input.judgeCalls.set(dir, list)
          return JSON.stringify({ done: false, reason: "continue" })
        }),
    }),
  )
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    messages: (value) =>
      Effect.sync(() => input.messagesBySession.get((value as { sessionID?: string }).sessionID ?? "") ?? []),
  })
  const promptWithIdle = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      prompt: () => Effect.succeed(reply("goal-parent", "continuation dispatched")),
      promptIfIdle: (value) =>
        Effect.gen(function* () {
          const dir = (yield* InstanceRef)?.directory ?? ""
          const list = input.continuationCalls.get(dir) ?? []
          list.push(1)
          input.continuationCalls.set(dir, list)
          return Option.some(reply(String(value.sessionID), "continuation dispatched"))
        }),
    }),
  )
  const provider = Layer.mock(Provider.Service, {})
  const loop = GoalLoop.layer.pipe(
    Layer.provide(session),
    Layer.provide(promptWithIdle),
    Layer.provide(provider),
    Layer.provide(judge),
    Layer.provide(goal),
    Layer.provide(status),
    Layer.provide(bridge),
  )
  return Layer.mergeAll(input.ambientDatabase ?? database, bridge, goal, loop)
}

describe("DAG-LOC-01 P2 follow-ups", () => {
  it("P2-A: a sibling instance does not drive another directory's goal-only session", async () => {
    const judgeCalls = new Map<string, number[]>()
    const continuationCalls = new Map<string, number[]>()
    const logs: string[] = []
    const collector = Logger.make((opts) => logs.push(String(opts.message)))
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const goal = yield* Goal.Service
        const loop = yield* GoalLoop.Service
        const bridge = yield* EventV2Bridge.Service
        yield* database.db.insert(ProjectTable).values({
          id: PROJECT_ID as never,
          worktree: DIR_A as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        for (const [id, dir, slug] of [
          [SES_A, DIR_A, "a"],
          [SES_B, DIR_B, "b"],
        ] as const) {
          yield* database.db.insert(SessionTable).values({
            id: id as never,
            project_id: PROJECT_ID as never,
            slug,
            directory: dir as never,
            title: id,
            version: "test",
          }).run().pipe(Effect.orDie)
        }
        // A goal-only session: no workflow rows, so the workflow-keyed DAG
        // authority is vacuous — only the goal-side session-row check can
        // tell the instances apart (P2-A).
        yield* goal.set(SES_A as never, "ship the feature", 10)
        // Boot BOTH instances (A ambient, B via refB).
        yield* loop.init()
        yield* loop.init().pipe(Effect.provideService(InstanceRef, {
          directory: DIR_B,
          worktree: DIR_B,
          project: { id: PROJECT_ID },
        } as never))
        yield* Effect.yieldNow
        yield* bridge.publish(SessionStatusEvent.Status, {
          sessionID: SES_A as never,
          status: { type: "idle" },
        }).pipe(Effect.orDie)
        // A owns /wtA and drives the goal; B must never judge it.
        yield* pollWithTimeout(
          Effect.sync(() => ((judgeCalls.get(DIR_A)?.length ?? 0) > 0 ? true : undefined)),
          "owner instance did not drive the goal-only session",
          "2 seconds",
        )
        yield* Effect.sleep("300 millis")
        expect(judgeCalls.get(DIR_B) ?? []).toEqual([])
      }).pipe(
        Effect.withLogger(collector),
        Effect.provide(goalLoopLayer({
          judgeCalls,
          continuationCalls,
          messagesBySession: new Map([[SES_A, [reply(SES_A, "making progress")]]]),
        })),
        Effect.provideService(InstanceRef, {
          directory: DIR_A,
          worktree: DIR_A,
          project: { id: PROJECT_ID },
        } as never),
        Effect.scoped,
      ),
    )
    expect(continuationCalls.get(DIR_A) ?? []).not.toHaveLength(0)
    expect(continuationCalls.get(DIR_B) ?? []).toEqual([])
    expect(logs).not.toContain("goal afterIdle failed")
  })

  it("P2-F: creating a workflow for a foreign session stamps the SESSION's directory", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store }) =>
          Effect.gen(function* () {
            // Ambient instance is A; the target session belongs to B's
            // directory. The stamp must come from the durable SESSION row,
            // not the requesting instance (P2-F) — otherwise A stamps /wtA
            // and B's loops never adopt the workflow.
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_B,
              title: "B's workflow created via A",
              config: { name: "p2f", nodes: [node()] },
            })
            const wf = yield* store.getWorkflow(dagID)
            expect(wf?.directory).toBe(DIR_B)
          }),
      ),
    )
  })

  it("#948: recovery terminalizes a workflow whose execution directory disappeared", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-recovery-missing-")))
    const directory = path.join(root, "linked-worktree")
    mkdirSync(directory, { recursive: true })
    try {
      await Effect.runPromise(
        runTwoInstanceGuardTest(
          { directoryA: directory },
          ({ dag, store, initA, childPromptsA }) =>
            Effect.gen(function* () {
              // Created while the directory still exists, as a real linked
              // worktree workflow would be. No loop is booted yet, so the
              // WorkflowStarted event has no subscriber and the row stays
              // running with a pending node.
              const dagID = yield* dag.create({
                projectID: PROJECT_ID,
                sessionID: SES_A,
                title: "worktree recovery",
                config: { name: "w1", nodes: [node()] },
              })
              rmSync(directory, { recursive: true, force: true })

              yield* initA

              const workflow = yield* store.getWorkflow(dagID)
              expect(workflow?.status).toBe("failed")
              expect(yield* store.getWorkflowFailureReason!(dagID)).toContain("workspace_missing")
              // Exactly one durable terminal wake row — the parent is not
              // notified once per pending node.
              expect((yield* store.getUnreportedWakeWorkflows(SES_A)).map((row) => row.id)).toEqual([dagID])
              // Recovery must not reach reconciliation/spawn with a dead path.
              expect(Option.isNone(yield* Queue.poll(childPromptsA))).toBe(true)
            }),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: spawn stops when the execution directory disappears mid-run", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-spawn-missing-")))
    const directory = path.join(root, "linked-worktree")
    mkdirSync(directory, { recursive: true })
    try {
      await Effect.runPromise(
        runTwoInstanceGuardTest(
          { directoryA: directory },
          ({ dag, store, initA, childPromptsA }) =>
            Effect.gen(function* () {
              yield* initA
              const dagID = yield* dag.create({
                projectID: PROJECT_ID,
                sessionID: SES_A,
                title: "worktree spawn",
                config: { name: "w2", nodes: [node({ id: "n1" }), node({ id: "n2", depends_on: ["n1"] })] },
              })
              yield* takeWithin(childPromptsA, "n1 did not start")
              rmSync(directory, { recursive: true, force: true })
              // Completing n1 makes n2 ready. The scheduling round must check
              // the shared verdict before rendering or spawning n2.
              yield* dag.nodeCompleted(dagID, "n1", { ok: true })
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const workflow = yield* store.getWorkflow(dagID)
                  return workflow?.status === "failed" ? (true as const) : undefined
                }),
                "workflow did not fail after its execution directory disappeared",
              )
              expect(yield* store.getWorkflowFailureReason!(dagID)).toContain("workspace_missing")
              expect(Option.isNone(yield* Queue.poll(childPromptsA))).toBe(true)
            }),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: failUnrecoverable revalidates a workspace moved to a valid directory inside the lock", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-move-fail-")))
    const directory = path.join(root, "linked-worktree")
    mkdirSync(directory, { recursive: true })
    try {
      await Effect.runPromise(
        runTwoInstanceGuardTest(
          { directoryA: directory },
          ({ dag, store, bridge }) =>
            Effect.gen(function* () {
              const dagID = yield* dag.create({
                projectID: PROJECT_ID,
                sessionID: SES_A,
                title: "moved before fail",
                config: { name: "move-fail", nodes: [node()] },
              })
              // The caller's observation is now stale: the workspace is gone,
              // but a concurrent Moved re-stamps the row to DIR_B before the
              // terminal transition commits.
              rmSync(directory, { recursive: true, force: true })
              yield* moveSession(bridge, SES_A, DIR_B)

              expect(yield* dag.failUnrecoverable(dagID, "workspace_missing: stale")).toBe("ignored")
              expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
              expect(yield* store.getWorkflowFailureReason!(dagID)).toBeUndefined()
            }),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: missing workspace terminalization interrupts parked sibling children", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-sibling-abort-")))
    const directory = path.join(root, "linked-worktree")
    mkdirSync(directory, { recursive: true })
    try {
      await Effect.runPromise(
        runTwoInstanceGuardTest(
          { directoryA: directory },
          ({ dag, store, initA, childPromptsA, promptInterrupts, cancelsA }) =>
            Effect.gen(function* () {
              yield* initA
              const dagID = yield* dag.create({
                projectID: PROJECT_ID,
                sessionID: SES_A,
                title: "sibling abort",
                config: { name: "siblings", nodes: [node({ id: "n1" }), node({ id: "n2" })] },
              })
              const prompts = [
                yield* takeWithin(childPromptsA, "n1 did not start"),
                yield* takeWithin(childPromptsA, "n2 did not start"),
              ]
              const nodes = yield* store.getNodes(dagID)
              const siblingSessionID = nodes.find((row) => row.id === "n2")?.childSessionId
              if (!siblingSessionID) throw new Error("n2 did not start a child session")
              expect(prompts.map((prompt) => prompt.input.sessionID as string)).toContain(siblingSessionID)

              rmSync(directory, { recursive: true, force: true })
              // Completing n1 drives a scheduling round; the missing-workspace
              // check must fail the workflow while the runtime entry still
              // exists, so the terminal handler can abort n2's parked child.
              yield* dag.nodeCompleted(dagID, "n1", { ok: true })
              yield* pollWithTimeout(
                Effect.sync(() => (promptInterrupts.includes(siblingSessionID) ? true : undefined)),
                "terminal handler did not interrupt the parked sibling child",
                "2 seconds",
              )
              expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
              expect(yield* store.getWorkflowFailureReason!(dagID)).toContain("workspace_missing")
              expect(cancelsA).toContain(siblingSessionID)
            }),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#948: a terminal wake reaches the parent directory and does not block a later valid workflow", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { deliverWakes: true },
        ({ store, initA, initB, childPromptsA, childPromptsB }) =>
          Effect.gen(function* () {
            // Boot the sibling first. It sees the same terminal-only session
            // (ownsSession ignores terminal rows) but the notification gate
            // must reject it: the parent session belongs to A.
            yield* initB
            yield* Effect.sleep("300 millis")
            expect(Option.isNone(yield* Queue.poll(childPromptsB))).toBe(true)

            yield* initA
            const wake = yield* takeWithin(childPromptsA, "parent did not receive the terminal wake")
            const text = wake.input.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n")
            expect(text).toContain("Earlier terminal workflow")
            expect(text).toContain("Valid later workflow")
            yield* Deferred.succeed(wake.release, "acknowledged")

            yield* pollWithTimeout(
              Effect.gen(function* () {
                const unreported = yield* store.getUnreportedWakeWorkflows(SES_A)
                return unreported.length === 0 ? true : undefined
              }),
              "terminal wake was not acknowledged for both workflows",
            )
            // Replay after the durable acknowledgement: no duplicate wake.
            yield* Effect.sleep("300 millis")
            expect(Option.isNone(yield* Queue.poll(childPromptsA))).toBe(true)
          }),
        ({ database }) =>
          Effect.gen(function* () {
            yield* database.db.insert(WorkflowTable).values([
              {
                id: "wake-null",
                project_id: PROJECT_ID as never,
                session_id: SES_A as never,
                directory: DIR_A as never,
                target_fingerprint: { kind: "none" },
                title: "Earlier terminal workflow",
                status: "failed",
                config: "{}",
                seq: 1,
                wake_reported: false,
              },
              {
                id: "wake-valid",
                project_id: PROJECT_ID as never,
                session_id: SES_A as never,
                directory: DIR_A as never,
                target_fingerprint: { kind: "none" },
                title: "Valid later workflow",
                status: "failed",
                config: "{}",
                seq: 2,
                wake_reported: false,
              },
            ]).run().pipe(Effect.orDie)
          }),
      ),
    )
  })

  it("#948: a sweep-terminalized unusable workflow notifies the parent without a runtime entry", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { deliverWakes: true },
        ({ store, sweep, initA, childPromptsA }) =>
          Effect.gen(function* () {
            yield* initA
            // No idle event is injected: the only trigger is the terminal
            // event published by the host-level sweep for a workflow the live
            // loop never adopted (no runtime entry).
            yield* sweep.sweepOnce()
            expect((yield* store.getWorkflow("dag-wake-swept-unusable"))?.status).toBe("failed")

            const wake = yield* takeWithin(childPromptsA, "parent did not receive the swept workflow wake")
            const text = wake.input.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n")
            expect(text).toContain("Swept unusable workflow")
            yield* Deferred.succeed(wake.release, "acknowledged")
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const unreported = yield* store.getUnreportedWakeWorkflows(SES_A)
                return unreported.length === 0 ? true : undefined
              }),
              "swept workflow wake was not acknowledged",
            )
            yield* Effect.sleep("300 millis")
            expect(Option.isNone(yield* Queue.poll(childPromptsA))).toBe(true)
          }),
        ({ database }) =>
          database.db.insert(WorkflowTable).values({
            id: "dag-wake-swept-unusable",
            project_id: PROJECT_ID as never,
            session_id: SES_A as never,
            directory: DIR_A as never,
            execution_directory: path.join(directoryRoot, "gone-workflow") as never,
            target_fingerprint: { kind: "none" },
            title: "Swept unusable workflow",
            status: "running",
            config: "{}",
            seq: 1,
            wake_reported: false,
          }).run().pipe(Effect.orDie, Effect.as(undefined)),
      ),
    )
  })

  it("P2-C: after an identity repaint, the stale instance spawns no further children", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, database, initA, childPromptsA }) =>
          Effect.gen(function* () {
            yield* initA
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "Repaint spawn gate",
              config: { name: "p2c", nodes: [node({ id: "n1" }), node({ id: "n2", depends_on: ["n1"] })] },
            })
            yield* takeWithin(childPromptsA, "n1 did not start")
            // Identity migration: repaint the workflow's project id. The
            // stale in-memory entry must stop scheduling (spawnReady
            // revalidation, P2-C) — settling n1 makes n2 ready, and without
            // the gate the stale instance would materialize a child for the
            // migrated workflow.
            yield* database.db.update(WorkflowTable)
              .set({ project_id: "project-new" as never })
              .where(eq(WorkflowTable.id, dagID as never))
              .run().pipe(Effect.orDie)
            yield* dag.nodeCompleted(dagID, "n1", { ok: true })
            const second = yield* Queue.take(childPromptsA).pipe(Effect.timeoutOption("1 second"))
            expect(Option.isNone(second)).toBe(true)
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            expect((yield* store.getNode(dagID, "n2"))?.status).toBe("pending")
          }),
        ({ database }) =>
          database.db.insert(ProjectTable).values({
            id: "project-new" as never,
            worktree: process.cwd() as never,
            sandboxes: [],
          }).run().pipe(Effect.orDie, Effect.as(undefined)),
      ),
    )
  })

  it("P2-B: a store defect in the goal guard degrades to a skipped evaluation, not a dead loop", async () => {
    const judgeCalls = new Map<string, number[]>()
    const continuationCalls = new Map<string, number[]>()
    const logs: string[] = []
    const collector = Logger.make((opts) => logs.push(String(opts.message)))
    const fail = { armed: true }
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const goal = yield* Goal.Service
        const loop = yield* GoalLoop.Service
        const bridge = yield* EventV2Bridge.Service
        yield* database.db.insert(ProjectTable).values({
          id: PROJECT_ID as never,
          worktree: DIR_A as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: SES_A as never,
          project_id: PROJECT_ID as never,
          slug: "a",
          directory: DIR_A as never,
          title: SES_A,
          version: "test",
        }).run().pipe(Effect.orDie)
        yield* goal.set(SES_A as never, "ship the feature", 10)
        yield* loop.init()
        yield* Effect.yieldNow
        // First idle: the guard's session-row read defects. The handler must
        // absorb it (P2-B) — otherwise the runForEach subscription dies and
        // the NEXT idle event is never evaluated.
        yield* bridge.publish(SessionStatusEvent.Status, {
          sessionID: SES_A as never,
          status: { type: "idle" },
        }).pipe(Effect.orDie)
        // Second idle: with the subscription alive, the goal is driven.
        yield* bridge.publish(SessionStatusEvent.Status, {
          sessionID: SES_A as never,
          status: { type: "idle" },
        }).pipe(Effect.orDie)
        yield* pollWithTimeout(
          Effect.sync(() => ((judgeCalls.get(DIR_A)?.length ?? 0) > 0 ? true : undefined)),
          "goal loop did not evaluate the idle event after the store defect (subscription died)",
          "2 seconds",
        )
        expect(fail.armed).toBe(false)
      }).pipe(
        Effect.withLogger(collector),
        Effect.provide(goalLoopLayer({
          judgeCalls,
          continuationCalls,
          messagesBySession: new Map([[SES_A, [reply(SES_A, "making progress")]]]),
          ambientDatabase: Layer.effect(
            Database.Service,
            Effect.gen(function* () {
              const real = yield* Database.Service
              // One-shot defect on the first durable SELECT (the guard's
              // session-row read): throws synchronously, i.e. a defect that
              // Effect.ignore would NOT absorb.
              const proxy = new Proxy(real.db, {
                get(target, prop) {
                  if (prop === "select" && fail.armed) {
                    fail.armed = false
                    return () => {
                      throw new Error("injected transient store defect")
                    }
                  }
                  return Reflect.get(target, prop)
                },
              })
              return Database.Service.of({ db: proxy })
            }),
          ).pipe(Layer.provide(Database.layerFromPath(":memory:"))),
        })),
        Effect.provideService(InstanceRef, {
          directory: DIR_A,
          worktree: DIR_A,
          project: { id: PROJECT_ID },
        } as never),
        Effect.scoped,
      ),
    )
    expect(continuationCalls.get(DIR_A) ?? []).not.toHaveLength(0)
    expect(logs).not.toContain("goal afterIdle failed")
  })

  it("P2-D: an empty-directory workflow is never owned and raises no per-process skip warning", async () => {
    const lines: string[] = []
    const collector = Logger.make((opts) => {
      lines.push(String(opts.message))
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(ProjectTable).values({
          id: PROJECT_ID as never,
          worktree: DIR_A as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: SES_A as never,
          project_id: PROJECT_ID as never,
          slug: "a",
          directory: DIR_A as never,
          title: SES_A,
          version: "test",
        }).run().pipe(Effect.orDie)
        // An empty stamp cannot be produced by create, but the projector keeps
        // a stored event without the field NOT NULL by writing "". Ownership
        // and execution stay fail-closed for that row.
        yield* database.db.insert(WorkflowTable).values({
          id: "p2d-empty-wf",
          project_id: PROJECT_ID as never,
          session_id: SES_A as never,
          directory: "",
          target_fingerprint: { kind: "none" },
          title: "Empty stamp",
          status: "running",
          config: "{}",
          seq: 1,
        }).run().pipe(Effect.orDie)
        yield* DagLocation.ownsWorkflow("p2d-empty-wf", DIR_A).pipe(Effect.ignore)
        yield* DagLocation.ownsWorkflow("p2d-empty-wf", DIR_A).pipe(Effect.ignore)
        const warnings = lines.filter((line) => line.includes("NULL execution-location directory"))
        expect(warnings).toHaveLength(0)
        expect(DagLocation.resolveExecution({ directory: "" })).toEqual({
          _tag: "invalid",
          directory: "",
          reason: "workflow has no recorded execution directory",
        })
        expect(DagLocation.resolveExecution({ directory: DIR_A })).toEqual({ _tag: "ok", directory: DIR_A })
        expect(DagLocation.resolveExecution({ directory: path.join(directoryRoot, "gone") })._tag).toBe("missing")
      }).pipe(
        Effect.withLogger(collector),
        Effect.provide(Database.layerFromPath(":memory:")),
        Effect.provideService(InstanceRef, {
          directory: DIR_A,
          worktree: DIR_A,
          project: { id: PROJECT_ID },
        } as never),
        Effect.scoped,
      ),
    )
  })

  it("P2-watcher: a transient store defect in the ownership revalidation does not end deadline supervision", async () => {
    const fail = { armed: true }
    let escalations = 0
    // Deterministic defect placement through the direct-call seam (the same
    // seam as the R13 watcher tests): readNode is a mock with no Database
    // traffic, so the watcher's ONLY real store query is the
    // ownership-revalidation read — the one-shot select defect lands exactly
    // there (review P2, makeDeadlineWatcher).
    const storeLayer = Layer.mock(DagStore.Service)({
      getNode: () =>
        Effect.succeed(
          makeNodeRow({
            id: "n1",
            workflowId: "p2w",
            name: "n1",
            status: "running",
            deadlineMs: 1,
            timeoutExtensions: 0,
            childSessionId: "ses_child_1",
          }),
        ),
    })
    const dagLayer = Layer.unwrap(
      Effect.map(DagStore.Service, (store) =>
        Layer.mock(Dag.Service)({
          store,
          nodeTimeoutEscalated: () =>
            Effect.sync(() => {
              escalations++
            }),
        }),
      ),
    ).pipe(Layer.provide(storeLayer))
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      cancel: () => Effect.void,
    })
    const databaseLayer = Layer.effect(
      Database.Service,
      Effect.gen(function* () {
        const real = yield* Database.Service
        // One-shot defect on the first durable SELECT: throws synchronously
        // (a defect the plain `yield*` cannot absorb) and disarms so the
        // revalidation's retry reads the real row.
        const proxy = new Proxy(real.db, {
          get(target, prop) {
            if (prop === "select" && fail.armed) {
              fail.armed = false
              return () => {
                throw new Error("injected transient store defect")
              }
            }
            return Reflect.get(target, prop)
          },
        })
        return Database.Service.of({ db: proxy })
      }),
    ).pipe(Layer.provide(Database.layerFromPath(":memory:")))
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(ProjectTable).values({
          id: PROJECT_ID as never,
          worktree: process.cwd() as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: SES_A as never,
          project_id: PROJECT_ID as never,
          slug: "a",
          directory: process.cwd() as never,
          title: SES_A,
          version: "test",
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(WorkflowTable).values({
          id: "p2w",
          project_id: PROJECT_ID as never,
          session_id: SES_A as never,
          title: "P2 watcher revalidation",
          status: "running",
          config: "{}",
          seq: 1,
          directory: process.cwd() as never,
          target_fingerprint: { kind: "none" },
        }).run().pipe(Effect.orDie)
        const scope = yield* Scope.Scope
        const watcher = yield* makeDeadlineWatcher({ dagID: "p2w", nodeID: "n1", timeoutMs: 300 }).pipe(
          Effect.forkIn(scope),
        )
        // The node is past its deadline; the watcher must still escalate
        // after the transient defect — proof supervision survived. Without
        // the retry the defect dies through the outer catchCause, which
        // completes the fiber, and the escalation never happens.
        yield* pollWithTimeout(
          Effect.sync(() => (escalations > 0 ? true : undefined)),
          "watcher ended deadline supervision after a transient ownership-revalidation store defect (review P2 regression)",
        )
        expect(fail.armed).toBe(false)
        yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
      }).pipe(
        Effect.provide(dagLayer),
        Effect.provide(promptLayer),
        Effect.provide(databaseLayer),
        Effect.provideService(InstanceRef, {
          directory: process.cwd(),
          worktree: process.cwd(),
          project: { id: PROJECT_ID },
        } as never),
        Effect.scoped,
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// #238 evidence probes C1–C6 (TOCTOU / teardown-idempotency / negative barriers)
// ---------------------------------------------------------------------------

describe("DAG-LOC-01 issue #238 evidence probes", () => {
  it("C1: concurrent live adoption — only the stamped directory adopts", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, initA, initB, childPromptsA, childPromptsB }) =>
          Effect.gen(function* () {
            // Boot BOTH instances before the workflow exists so each live
            // WorkflowStarted subscription is already armed when adoption
            // fires — no timing dependence on which boot wins.
            yield* initA
            yield* initB
            // Session-sourced stamp: SES_A lives in DIR_A, so the row is
            // stamped DIR_A regardless of which instance creates it.
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "concurrent live adoption",
              config: { name: "c1", nodes: [node()] },
            })
            expect((yield* store.getWorkflow(dagID))?.directory).toBe(DIR_A)
            // The owner adopts and spawns its first wave...
            const owner = yield* takeWithin(childPromptsA, "owner instance did not adopt and spawn")
            expect(owner.input.sessionID).toBeDefined()
            // ...and the sibling instance must NOT adopt within the window.
            yield* Effect.sleep("300 millis")
            expect(Option.getOrElse(yield* Queue.poll(childPromptsB), () => null)).toBe(null)
          }),
      ),
    )
  })

  it("C3: an entry orphaned by cascade-in-window deletion acts on no later stimulus", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, database, bridge, initA, childPromptsA }) =>
          Effect.gen(function* () {
            yield* initA
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "cascade-window orphan",
              config: { name: "c3", nodes: [node({ id: "n1" }), node({ id: "n2", depends_on: ["n1"] })] },
            })
            yield* takeWithin(childPromptsA, "n1 did not start")
            // Simulate the P2-E cascade-in-window: delete the workflow row
            // directly (FK cascade wipes the node rows) WITHOUT publishing a
            // SessionV1.Event.Deleted, so the Deleted sweep can never reach
            // the live in-memory entry.
            yield* database.db.delete(WorkflowTable)
              .where(eq(WorkflowTable.id, dagID as never))
              .run().pipe(Effect.orDie)
            expect(yield* store.getWorkflow(dagID)).toBeUndefined()
            // Stimulus 1: settle n1 via a direct bus publish (dag.nodeCompleted's
            // guard rejects a missing node). The orphaned entry must not spawn n2.
            yield* bridge.publish(DagEvent.NodeCompleted, {
              dagID: dagID as never,
              nodeID: "n1" as never,
              output: { ok: true },
              durationMs: 0 as never,
              timestamp: yield* DateTime.now,
            }).pipe(Effect.orDie)
            expect(Option.isNone(yield* Queue.take(childPromptsA).pipe(Effect.timeoutOption("1 second")))).toBe(true)
            // Stimulus 2: a follow-up completion also no-ops — the entry is
            // inert (every action path revalidates ownership against the
            // missing row), so nothing is ever spawned for a deleted workflow.
            yield* bridge.publish(DagEvent.NodeCompleted, {
              dagID: dagID as never,
              nodeID: "n2" as never,
              output: { ok: true },
              durationMs: 0 as never,
              timestamp: yield* DateTime.now,
            }).pipe(Effect.orDie)
            expect(Option.isNone(yield* Queue.take(childPromptsA).pipe(Effect.timeoutOption("1 second")))).toBe(true)
          }),
      ),
    )
  })

  it("C4: a moved session's workflow stamps move WITH the session — exactly one live owner, the new durable directory (#269 resolution)", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, bridge }) =>
          Effect.gen(function* () {
            // wf1 created while SES_A lives in DIR_A → stamped DIR_A.
            const wf1 = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "before move",
              config: { name: "c4a", nodes: [node()] },
            })
            expect((yield* store.getWorkflow(wf1))?.directory).toBe(DIR_A)
            // Move the session to DIR_B via the durable SessionEvent.Moved. The
            // session projector re-stamps every workflow row of the session in
            // the SAME transaction (payload-sourced, no SessionTable read), so
            // the stamp moves WITH the session — no mixed-stamp window.
            yield* moveSession(bridge, SES_A, DIR_B)
            // The pre-move workflow's stamp MOVED WITH the session (write-once
            // except the whitelisted Moved re-stamp).
            expect((yield* store.getWorkflow(wf1))?.directory).toBe(DIR_B)
            // wf2 created after the move → session-sourced stamp = DIR_B.
            const wf2 = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "after move",
              config: { name: "c4b", nodes: [node()] },
            })
            expect((yield* store.getWorkflow(wf2))?.directory).toBe(DIR_B)
            // Resolution (acceptance #269): the session's rows agree on ONE
            // directory, so exactly one instance owns it — the session's NEW
            // durable directory. The old directory loses ownership (the wedge is
            // resolved, not pinned), and the two directories never own
            // simultaneously (no cross-directory double-adoption).
            expect(yield* DagLocation.ownsSession(SES_A, DIR_B)).toBe(true)
            expect(yield* DagLocation.ownsSession(SES_A, DIR_A)).toBe(false)
            // Per-workflow ownership converges the same way: every workflow is
            // owned by DIR_B only.
            expect(yield* DagLocation.ownsWorkflow(wf1, DIR_B)).toBe(true)
            expect(yield* DagLocation.ownsWorkflow(wf1, DIR_A)).toBe(false)
            expect(yield* DagLocation.ownsWorkflow(wf2, DIR_B)).toBe(true)
            expect(yield* DagLocation.ownsWorkflow(wf2, DIR_A)).toBe(false)
          }),
      ),
    )
  })

  it("C8: a moved session's wedged wake is delivered by the NEW owner immediately — no idle event, no restart (#269 bounded-time resolution)", async () => {
    const parked = { value: false }
    const released = { value: false } // never released: the parked admission stays parked; scope cleanup interrupts it
    const calls = { value: 0 }
    const wait = new Promise<void>(() => {})
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { parkWakeDelivery: { wait, parked, released, calls } },
        ({ bridge, database, initA, initB }) =>
          Effect.gen(function* () {
            yield* initA
            yield* initB
            // Re-arm the seeded terminal wake AFTER both startup sweeps passed
            // over it (seeded wake_reported=true), so the ONLY later trigger is
            // the Moved subscription's re-fork (no idle event, no restart).
            yield* database.db.update(WorkflowTable)
              .set({ wake_reported: false })
              .where(eq(WorkflowTable.id, "c8-wake"))
              .run().pipe(Effect.orDie)
            // Move SES_A → DIR_B. The Moved projection re-stamps the wake row to
            // DIR_B (exactly one owner), and the NEW owner's Moved subscription
            // re-forks tryDeliverWake — the wake delivers immediately (bounded
            // time), no wake stays wedged behind the old mixed stamps.
            yield* moveSession(bridge, SES_A, DIR_B)
            yield* pollWithTimeout(
              Effect.sync(() => (parked.value && calls.value === 1 ? true : undefined)),
              "moved wake was not delivered to the new owner within bounded time (expected exactly one delivery attempt from the new directory)",
            )
            // Exactly one delivery: after the re-stamp the old directory's
            // ownsSession is false, so only the NEW owner re-forks the drain —
            // no cross-directory double delivery.
            expect(calls.value).toBe(1)
          }),
        ({ database }) =>
          Effect.gen(function* () {
            yield* database.db.insert(WorkflowTable).values({
              id: "c8-wake",
              project_id: PROJECT_ID as never,
              session_id: SES_A as never,
              directory: DIR_A as never,
              target_fingerprint: { kind: "none" },
              title: "terminal wake c8",
              status: "failed",
              config: "{}",
              seq: 1,
              wake_reported: true,
            }).run().pipe(Effect.orDie)
          }),
      ),
    )
  })

  it("C7: a deletion committed after a passed admission check fences the in-flight spawn — no post-deletion child survives (#270 deletion race)", async () => {
    const parked = { value: false }
    const calls = { value: 0 }
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { parkAdoptionClaim: { wait, parked, calls, skip: 1 } },
        ({ dag, database, initA, cancelsA, childPromptsA }) =>
          Effect.gen(function* () {
            yield* initA
            // A ready-node workflow: the adoption claim (skipped by the gate) runs
            // first, then spawnReady admits the node and the SECOND claim — the
            // window-2 spawn-admission fence — parks just before the child session
            // would materialize.
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "deletion race",
              config: { name: "c7", nodes: [node()] },
            })
            yield* pollWithTimeout(
              Effect.sync(() => (parked.value ? true : undefined)),
              "the spawn admission claim never parked",
            )
            // Deletion committed AFTER the ownership/admission check passed: drop
            // the workflow row directly (FK cascade wipes the nodes) WITHOUT
            // publishing SessionV1.Event.Deleted, so no in-memory sweep interrupts
            // the parked admission — the fence must hold purely because the atomic
            // claim re-reads the row.
            yield* database.db.delete(WorkflowTable)
              .where(eq(WorkflowTable.id, dagID as never))
              .run().pipe(Effect.orDie)
            // Release: the claim conditional UPDATE matches no row (cascade already
            // removed it) → the spawn aborts BEFORE sessions.create — nothing a
            // deleted workflow may run survives the admission window.
            release()
            yield* Effect.sleep("400 millis")
            // Fenced: no post-deletion spawn survived — no child prompt ran and no
            // child session was created-then-cancelled.
            expect(Option.isNone(yield* Queue.take(childPromptsA).pipe(Effect.timeoutOption("500 millis")))).toBe(true)
            expect(cancelsA).toEqual([])
          }),
      ),
    )
  })

  it("C5: replaying a deleted workflow's journal does not resurrect the read-model", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, store, database, bridge, session }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "serialize me",
              config: { name: "c5", nodes: [node()] },
            })
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            // Serialize the dag aggregate journal BEFORE deletion.
            const rows = yield* database.db.select().from(EventTable)
              .where(eq(EventTable.aggregate_id, dagID))
              .orderBy(EventTable.seq)
              .all().pipe(Effect.orDie)
            const serialized = rows.map((r) => ({
              id: r.id,
              type: r.type,
              seq: r.seq,
              aggregateID: r.aggregate_id,
              data: r.data,
            }))
            expect(serialized.length).toBeGreaterThan(0)
            // Remove the session: FK cascade wipes the workflow/node read-model
            // rows, but the dag aggregate's durable events + sequence survive.
            yield* session.remove(SES_A as never)
            expect(yield* store.getWorkflow(dagID)).toBeUndefined()
            // Replay the journal through EventV2 replay: the durable-seq dedup
            // (input.seq <= latest) skips projection, so the read-model stays
            // deleted — a crash-recovery replay cannot resurrect a torn-down
            // workflow.
            yield* bridge.replayAll(serialized)
            expect(yield* store.getWorkflow(dagID)).toBeUndefined()
          }),
      ),
    )
  })

  it("C2: Session.remove racing an in-flight wake is absorbed and the idle subscription survives", async () => {
    const parked = { value: false }
    const released = { value: false }
    const calls = { value: 0 }
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = () => {
        released.value = true
        resolve()
      }
    })
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { parkWakeDelivery: { wait, parked, released, calls } },
        ({ database, bridge, session, initA }) =>
          Effect.gen(function* () {
            yield* initA
            // Re-arm BOTH stamped terminal wakes after the startup sweep passed
            // over them (they were seeded wake_reported=true), so the delivery
            // below can only come from the idle-Status path.
            for (const id of ["wake-wf-a", "wake-wf-b"]) {
              yield* database.db.update(WorkflowTable)
                .set({ wake_reported: false })
                .where(eq(WorkflowTable.id, id))
                .run().pipe(Effect.orDie)
            }
            // Idle SES_A → wake delivery parks inside prepareIfIdle.
            yield* bridge.publish(SessionStatusEvent.Status, {
              sessionID: SES_A as never,
              status: { type: "idle" },
            }).pipe(Effect.orDie)
            yield* pollWithTimeout(
              Effect.sync(() => (parked.value ? true : undefined)),
              "wake delivery never parked in prepareIfIdle",
            )
            expect(calls.value).toBe(1)
            // Race: delete SES_A while the delivery is parked — FK cascade wipes
            // the wake rows out from under the in-flight delivery.
            yield* session.remove(SES_A as never)
            // Release: the parked result fails; tryDeliverWake's catchCause must
            // absorb it (no defect) and the finally must free wakeInFlight.
            release()
            yield* Effect.sleep("200 millis")
            // Subscription survival: an idle for a DIFFERENT session still reaches
            // prepareIfIdle (calls bumps again) — proof the idle wake subscription
            // is alive after the raced deletion.
            yield* bridge.publish(SessionStatusEvent.Status, {
              sessionID: SES_B as never,
              status: { type: "idle" },
            }).pipe(Effect.orDie)
            yield* pollWithTimeout(
              Effect.sync(() => (calls.value >= 2 ? true : undefined)),
              "idle wake subscription died after the Session.remove race",
            )
            expect(calls.value).toBe(2)
          }),
        ({ database }) =>
          Effect.gen(function* () {
            for (const [id, sessionID] of [
              ["wake-wf-a", SES_A],
              ["wake-wf-b", SES_B],
            ] as const) {
              yield* database.db.insert(WorkflowTable).values({
                id,
                project_id: PROJECT_ID as never,
                session_id: sessionID as never,
                directory: DIR_A as never,
                target_fingerprint: { kind: "none" },
                title: `terminal wake ${id}`,
                status: "failed",
                config: "{}",
                seq: 1,
                wake_reported: true,
              }).run().pipe(Effect.orDie)
            }
          }),
      ),
    )
  })

  it("C6: recoverOrphanPending racing Session.remove is absorbed without killing init", async () => {
    const parked = { value: false }
    const calls = { value: 0 }
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { parkGetNodes: { wait, parked, calls } },
        ({ database, session, store, initA }) =>
          Effect.gen(function* () {
            // An all-pending orphan under A: a create that crashed mid-way.
            // It is stamped DIR_A so instance A's recoverOrphanPending owns it.
            yield* database.db.insert(WorkflowTable).values({
              id: "c6-orphan",
              project_id: PROJECT_ID as never,
              session_id: SES_A as never,
              directory: DIR_A as never,
              target_fingerprint: { kind: "none" },
              title: "pending orphan",
              status: "pending",
              config: "{}",
              seq: 1,
              wake_reported: true,
            }).run().pipe(Effect.orDie)
            yield* database.db.insert(WorkflowNodeTable).values({
              id: "n1",
              workflow_id: "c6-orphan",
              name: "n1",
              worker_type: "build",
              status: "pending",
              required: true,
              depends_on: [],
              seq: 1,
            }).run().pipe(Effect.orDie)
            // Boot A; recoverOrphanPending parks its first getNodes on the gate.
            const initFiber = yield* initA.pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.sync(() => (parked.value ? true : undefined)),
              "recoverOrphanPending never parked at getNodes",
            )
            // While it is parked between getNodes and dag.fail, delete the
            // session — FK cascade wipes the orphan rows out from under it.
            yield* session.remove(SES_A as never)
            expect(yield* store.getWorkflow("c6-orphan")).toBeUndefined()
            // Release: dag.fail on the gone workflow fails, the startup-scan
            // catchCause absorbs it, and Effect.ensuring frees the recovering
            // slot. init must therefore complete — a leak or an unabsorbed
            // defect would surface here.
            release()
            yield* Fiber.join(initFiber)
            expect(yield* store.getWorkflow("c6-orphan")).toBeUndefined()
          }),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// H1 mutation probe (DAG-LOC-01 REJECT follow-up, latch = 959bae7c2)
//
// The WorkflowStarted handler's recovering reservation is the only guard
// between its runtimes/recovering check and runtimes.set. Within one
// subscription duplicate WorkflowStarted events are serialized by
// Stream.runForEach, so the falsifiable race is a reentrant stimulus on a
// DIFFERENT subscription fiber: the WorkflowReplanned handler's no-entry
// path calls recoverWorkflow, whose own guard observes the live adoption's
// reservation (post-latch) or nothing (pre-latch). The probe parks the live
// adoption at the getWorkflow/getNodes seam, publishes the reentrant
// WorkflowReplanned from the SIBLING directory's ambient context, and
// asserts adopt-exactly-once: while parked, exactly ONE adoption sequence
// may sit at the seam (single runtimes.set-to-be, single automation-lease
// registration-to-be); after release, exactly one first-wave spawn; a
// follow-up duplicate WorkflowStarted from the sibling directory must not
// drive a second adoption either. Reverting 959bae7c2 turns this probe RED
// at the seam-count assertion (a second gated getNodes parks inside
// reconcileWorkflow — the second adoption that would overwrite the first
// runtimes entry and double-register the lease).
// ---------------------------------------------------------------------------

describe("DAG-LOC-01 H1 adopt-exactly-once latch", () => {
  it("H1: a reentrant sibling-directory publish cannot drive a second adoption of a parked live WorkflowStarted adoption", async () => {
    const parked = { value: false }
    const calls = { value: 0 }
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        { parkGetNodes: { wait, parked, calls } },
        ({ dag, store, bridge, initA, initB, childPromptsA, childPromptsB, cancelsA }) =>
          Effect.gen(function* () {
            yield* initA
            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: SES_A,
              title: "Duplicate publish race",
              config: { name: "h1", nodes: [node()] },
            })
            // The owner's live WorkflowStarted adoption parks between its
            // guard and runtimes.set: exactly one gated getNodes proves the
            // owner's adoption — and nothing else — is at the seam.
            yield* pollWithTimeout(
              Effect.sync(() => (parked.value ? true : undefined)),
              "live WorkflowStarted adoption never parked at getNodes",
            )
            expect(calls.value).toBe(1)
            // Reentrant stimulus published from the SIBLING directory's
            // ambient context (B's InstanceRef stamps the location): a same-
            // dagID WorkflowReplanned whose handler finds no runtimes entry
            // takes the recoverWorkflow re-adoption path. The live adoption's
            // reservation must repel it — pre-latch the replan passed
            // recoverWorkflow's guard and parked a SECOND gated getNodes
            // inside reconcileWorkflow.
            yield* bridge.publish(DagEvent.WorkflowReplanned, {
              dagID: dagID as never,
              added: 0 as never,
              removed: 0 as never,
              replaced: 0 as never,
              restarted: 0 as never,
              timestamp: yield* DateTime.now,
            }).pipe(
              Effect.orDie,
              Effect.provideService(InstanceRef, {
                directory: DIR_B,
                worktree: DIR_B,
                project: { id: PROJECT_ID },
              } as never),
            )
            // Negative window (sleep + snapshot — pollWithTimeout is a
            // positive-wait tool): no second adoption may reach the seam.
            yield* Effect.sleep("300 millis")
            const adoptionsAtTheSeam = calls.value
            // Release BEFORE asserting: the park awaits an uninterruptible
            // Effect.promise, so a failing expectation must never abandon it
            // (a hang at scope close would mask the RED).
            release()
            yield* Effect.sleep("100 millis")
            expect(adoptionsAtTheSeam).toBe(1)
            // Exactly one first-wave spawn for the single-node workflow.
            const first = yield* takeWithin(childPromptsA, "owner did not adopt and spawn its first wave")
            // Boot the sibling: its startup scan must not adopt the foreign
            // (DIR_A-stamped) workflow either.
            yield* initB
            // Duplicate WorkflowStarted — same dagID, published from the
            // sibling directory's context while the owner's entry is live —
            // must not drive a second adoption or a re-spawn.
            yield* bridge.publish(DagEvent.WorkflowStarted, {
              dagID: dagID as never,
              timestamp: yield* DateTime.now,
            }).pipe(
              Effect.orDie,
              Effect.provideService(InstanceRef, {
                directory: DIR_B,
                worktree: DIR_B,
                project: { id: PROJECT_ID },
              } as never),
            )
            yield* Effect.sleep("300 millis")
            expect(Option.isNone(yield* Queue.take(childPromptsA).pipe(Effect.timeoutOption("300 millis")))).toBe(true)
            expect(Option.getOrElse(yield* Queue.poll(childPromptsB), () => null)).toBe(null)
            expect(cancelsA).toEqual([])
            const row = yield* store.getNode(dagID, "n1")
            expect(row?.status).toBe("running")
            expect(row?.childSessionId).toBe(first.input.sessionID as string)
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          }),
      ),
    )
  })
})

describe("DAG workspace binding", () => {
  it("#943: rejects an invalid config workspace through the Error channel before persistence", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, database }) =>
          Effect.gen(function* () {
            const exit = yield* dag
              .create({
                projectID: PROJECT_ID,
                sessionID: SES_A,
                title: "invalid config workspace",
                config: {
                  name: "invalid-config-workspace",
                  workspace: path.join(directoryRoot, "missing-config-workspace"),
                  nodes: [node()],
                },
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.hasDies(exit.cause)).toBe(false)
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Error)
            }
            expect(yield* database.db.select().from(WorkflowTable).all()).toHaveLength(0)
            expect(yield* database.db.select().from(EventTable).all()).toHaveLength(0)
          }),
      ),
    )
  })

  it("#943: rejects an invalid node workspace through the Error channel before persistence", async () => {
    await Effect.runPromise(
      runTwoInstanceGuardTest(
        {},
        ({ dag, database }) =>
          Effect.gen(function* () {
            const exit = yield* dag
              .create({
                projectID: PROJECT_ID,
                sessionID: SES_A,
                title: "invalid node workspace",
                config: {
                  name: "invalid-node-workspace",
                  nodes: [node({ workspace: path.join(directoryRoot, "missing-node-workspace") })],
                },
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.hasDies(exit.cause)).toBe(false)
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Error)
            }
            expect(yield* database.db.select().from(WorkflowTable).all()).toHaveLength(0)
            expect(yield* database.db.select().from(EventTable).all()).toHaveLength(0)
          }),
      ),
    )
  })
})
