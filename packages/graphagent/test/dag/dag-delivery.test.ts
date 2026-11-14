// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// D7 delivery-scheduling consolidation: DagDelivery owns the wake and agent
// mailbox ledgers. These probes pin the acceptance behaviors that moved there —
// repeated drain triggers admit once, the #321 crash boundary (admission
// committed, wake mark not) redelivers a receipt instead of a second synthetic
// wake, and the fixed wake-before-mailbox order.
import { describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Scope, Stream, DateTime, type Context } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { DagEvent } from "@graphagent/schema/dag-event"
import { ModelV2 } from "@graphagent/core/model"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { ProviderV2 } from "@graphagent/core/provider"
import { AbsolutePath } from "@graphagent/core/schema"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Dag } from "@/dag/dag"
import { DagDelivery } from "@/dag/runtime/delivery"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ExclusiveRegistry } from "@/session/engine-process"
import { SessionCancellation } from "@/session/cancellation"
import { SessionInbox, type InboxSource, type StepSource } from "@/session/inbox"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { mockSessionPrompt } from "../lib/child-runs"

const DIRECTORY = process.cwd()
const PROJECT_ID = "project-1"
const PARENT = "ses_parent"

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
      path: { cwd: DIRECTORY, root: DIRECTORY },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ type: "text", text }] as never,
  }
}

function userData(created: number): Omit<SessionV1.User, "id" | "sessionID"> {
  return {
    role: "user",
    agent: "build",
    model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
    time: { created },
  }
}

function baseLayers() {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const automation = ExclusiveRegistry.layer.pipe(Layer.provide(status))
  return {
    database,
    bridge,
    store,
    dag,
    status,
    automation,
    all: Layer.mergeAll(database, events, bridge, store, projector, status, dag, automation),
  }
}

const sessionInfo = {
  id: SessionID.make(PARENT),
  projectID: Project.ID.make(PROJECT_ID),
  directory: DIRECTORY,
  slug: "parent",
  title: "Parent",
  agent: "build",
  model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
  version: "test",
  time: { created: 0, updated: 0 },
} as never

const seedWake = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.make(PROJECT_ID), worktree: AbsolutePath.make(DIRECTORY), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(PARENT),
      project_id: Project.ID.make(PROJECT_ID),
      slug: "parent",
      directory: AbsolutePath.make(DIRECTORY),
      title: "Parent",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkflowTable)
    .values({
      id: "dag_delivery",
      project_id: Project.ID.make(PROJECT_ID),
      session_id: SessionID.make(PARENT),
      directory: AbsolutePath.make(DIRECTORY),
      target_fingerprint: { kind: "none" },
      title: "Delivery",
      status: "completed",
      seq: 1,
      config: "{}",
      wake_reported: false,
      completed_at: 2_000,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkflowNodeTable)
    .values({
      id: "node",
      workflow_id: "dag_delivery",
      name: "Node",
      worker_type: "build",
      status: "completed",
      output: "done",
      depends_on: [],
      required: true,
      seq: 1,
      wake_eligible: true,
      wake_reported: false,
      completed_at: 1_000,
    })
    .run()
    .pipe(Effect.orDie)
})

const queuedMailboxMessage: DagMessages.Message = {
  id: "agent_scan_report",
  workflowID: "dag_delivery",
  sender: {
    id: "child_endpoint",
    kind: "node",
    sessionID: "ses_child",
    workflowID: "dag_delivery",
    nodeID: "worker",
    attemptID: "attempt_1",
  },
  recipient: { id: "parent_endpoint", kind: "main", sessionID: PARENT as never },
  recipientSequence: 1,
  acceptedRevision: 1,
  content: "Please review the result.",
  state: "queued",
  transcriptID: "msg_agent_scan_report",
  partID: "prt_agent_scan_report",
  timeCreated: 1,
}

const instanceRef = { directory: DIRECTORY, worktree: DIRECTORY, project: { id: PROJECT_ID } } as never

function startDelivery(input: {
  readonly scope: Scope.Scope
  readonly store: DagStore.Interface
  readonly dag: Dag.Interface
  readonly sessions: Session.Interface
  readonly prompts: SessionPrompt.Interface
  readonly status: SessionStatus.Interface
  readonly automation: ExclusiveRegistry.Interface
  readonly database: Database.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly messages: DagMessages.Interface | undefined
  readonly inbox?: SessionInbox.Interface | undefined
}) {
  return DagDelivery.make({
    directory: DIRECTORY,
    projectID: PROJECT_ID,
    scope: input.scope,
    store: input.store,
    dag: input.dag,
    sessions: input.sessions,
    prompts: input.prompts,
    status: input.status,
    automation: input.automation,
    database: input.database,
    events: input.events,
    messages: input.messages,
    inbox: input.inbox,
    entries: () => undefined,
    lastAssistantMessage: () => Effect.succeed(undefined),
  })
}

function services() {
  return Effect.gen(function* () {
    return {
      store: yield* DagStore.Service,
      dag: yield* Dag.Service,
      sessions: yield* Session.Service,
      prompts: yield* SessionPrompt.Service,
      status: yield* SessionStatus.Service,
      automation: yield* ExclusiveRegistry.Service,
      database: yield* Database.Service,
      events: yield* EventV2Bridge.Service,
      scope: yield* Scope.Scope,
    }
  })
}

const expectReported = Effect.gen(function* () {
  const store = yield* DagStore.Service
  expect(yield* store.getUnreportedWakeWorkflows(PARENT)).toEqual([])
  expect(yield* store.getUnreportedWakeNodes(PARENT)).toEqual([])
})

/** Service graph for probes that never reach a model turn: inert session and prompt slices. */
function inertGraph() {
  const session = Layer.mock(Session.Service, {
    get: () => Effect.succeed(sessionInfo),
    messages: () => Effect.succeed([]),
    getPart: () => Effect.succeed(undefined),
  })
  return Layer.mergeAll(baseLayers().all, session, mockSessionPrompt({}))
}

/** A mailbox ledger that honors the real `pendingRecipients` contract: session-ID
 * order, a capped page, and the `afterSessionID` cursor. */
function pagedMailboxes(ids: ReadonlyArray<string>) {
  /** `afterSessionID` of every page read, in order. */
  const reads: Array<string | undefined> = []
  /** Sessions the mailbox drain tried to deliver to. */
  const attempted = new Set<string>()
  const control = { failNext: false }
  const messages = {
    receive: (caller: DagMessages.Caller) => {
      attempted.add(caller.sessionID)
      return Effect.succeed({ ok: false as const })
    },
    pendingRecipients: (scope: { afterSessionID?: string; limit?: number }) => {
      reads.push(scope.afterSessionID)
      if (control.failNext) {
        control.failNext = false
        return Effect.die(new Error("page read boom"))
      }
      return Effect.succeed(
        ids
          .filter((id) => id > (scope.afterSessionID ?? ""))
          .slice(0, Math.min(64, scope.limit ?? 20))
          .map((sessionID) => ({ id: `endpoint_${sessionID}`, kind: "main" as const, sessionID })),
      )
    },
    changed: Stream.empty,
  } as unknown as DagMessages.Interface
  return { messages, reads, attempted, control }
}

// 150 recipients = two full ledger pages (64 each) and a short one (22).
const pagedIDs = Array.from({ length: 150 }, (_, index) => `ses_page_${String(index).padStart(3, "0")}`)

describe("DagDelivery drain", () => {
  it("admits one durable wake even when drain is triggered one hundred times", async () => {
    let admissions = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "wake handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          yield* Effect.gen(function* () {
            yield* seedWake
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages: undefined })
            for (let index = 0; index < 100; index++) yield* delivery.drain(PARENT)
            expect(admissions).toBe(1)
            yield* expectReported
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("delivers a workflow-isolated completion only after its settlement commits", async () => {
    let admissions = 0
    const settled = {
      directory: "/repo/.agents/worktree/dag-dag_delivery-workflow",
      branch: "opencode/dag-dag_delivery-workflow",
      baseHead: "base-sha",
      head: "head-sha",
      touchedPaths: ["src/a.ts"],
      state: "kept" as const,
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            // The completion report commits its receipt under the idle fence.
            withIdle: <A, E, R>(_sessionID: SessionID, work: Effect.Effect<A, E, R>) => Effect.map(work, Option.some),
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "wake handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          yield* Effect.gen(function* () {
            yield* seedWake
            const { db } = yield* Database.Service
            const store = yield* DagStore.Service
            const bridge = yield* EventV2Bridge.Service
            // F1: a terminal workflow-isolated workflow is not deliverable
            // until its settlement projection commits. Its wake text embeds
            // worktree evidence that the pinned receipt identity cannot
            // reproduce after the settlement write.
            yield* db
              .update(WorkflowTable)
              .set({
                config: JSON.stringify({
                  name: "Delivery",
                  isolation: "worktree",
                  worktree: {
                    directory: settled.directory,
                    branch: settled.branch,
                    baseHead: settled.baseHead,
                  },
                  nodes: [{ id: "node", depends_on: [] }],
                }),
              })
              .where(eq(WorkflowTable.id, "dag_delivery"))
              .run()
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages: undefined })

            yield* delivery.drain(PARENT)
            expect(admissions).toBe(0)
            expect((yield* store.getWorkflow("dag_delivery"))?.wakeReported).toBe(false)

            const workflow = yield* store.getWorkflow("dag_delivery")
            yield* bridge.publish(DagEvent.WorkflowWorktreeSettled, {
              dagID: DagEvent.DagID.make("dag_delivery"),
              worktree: settled,
              episode: { graphRev: workflow?.graphRev ?? 0, seq: workflow?.seq ?? 0 },
              timestamp: yield* DateTime.now,
            })
            yield* delivery.drain(PARENT)
            expect(admissions).toBe(1)
            yield* expectReported

            // Retry over the durable receipts: their text already carries the
            // settled evidence, so the content check must not die.
            yield* db
              .update(WorkflowTable)
              .set({ wake_reported: false })
              .where(eq(WorkflowTable.id, "dag_delivery"))
              .run()
            yield* db
              .update(WorkflowNodeTable)
              .set({ wake_reported: false })
              .where(eq(WorkflowNodeTable.workflow_id, "dag_delivery"))
              .run()
            yield* delivery.drain(PARENT)
            expect(admissions).toBe(1)
            yield* expectReported
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("reuses the durable receipt after an admission crash instead of resending the wake (#321)", async () => {
    let parked = 0
    let resumed = 0
    let mode: "park" | "count" = "park"
    const admitted = Deferred.makeUnsafe<void>()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.unwrap(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return Layer.mock(Session.Service, {
                get: () => Effect.succeed(sessionInfo),
                messages: () => Effect.succeed([]),
                getPart: (input) =>
                  Effect.gen(function* () {
                    const row = yield* db
                      .select()
                      .from(PartTable)
                      .where(
                        and(
                          eq(PartTable.session_id, input.sessionID),
                          eq(PartTable.message_id, input.messageID),
                          eq(PartTable.id, input.partID),
                        ),
                      )
                      .get()
                      .pipe(Effect.orDie)
                    if (!row) return undefined
                    return {
                      type: "text",
                      text: Reflect.get(row.data, "text"),
                      synthetic: Reflect.get(row.data, "synthetic"),
                    } as never
                  }),
              })
            }),
          ).pipe(Layer.provide(base.database))
          const prompt = Layer.unwrap(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return mockSessionPrompt({
                prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
                  Effect.gen(function* () {
                    if (mode === "park") {
                      parked += 1
                      const messageID = input.messageID ?? MessageID.ascending()
                      yield* db
                        .insert(MessageTable)
                        .values({ id: messageID, session_id: input.sessionID, data: userData(Date.now()) })
                        .run()
                        .pipe(Effect.orDie)
                      for (const part of input.parts) {
                        if (part.type !== "text") continue
                        const data = { type: "text" as const, text: part.text, synthetic: part.synthetic }
                        yield* db
                          .insert(PartTable)
                          .values({
                            id: part.id ? PartID.make(part.id) : PartID.ascending(),
                            message_id: messageID,
                            session_id: input.sessionID,
                            data,
                          } as never)
                          .run()
                          .pipe(Effect.orDie)
                      }
                      yield* Deferred.succeed(admitted, undefined)
                      return yield* Effect.never
                    }
                    resumed += 1
                    yield* persistAdmission ?? Effect.void
                    return Option.some({
                      activate: Effect.void,
                      result: Effect.succeed(reply(input.sessionID as string, "wake handled")),
                      abort: Effect.void,
                    })
                  })) as never,
              })
            }),
          ).pipe(Layer.provide(base.database))
          yield* Effect.gen(function* () {
            yield* seedWake
            const deps = yield* services()

            // First process: the transcript receipt commits, then the process
            // dies before the wake mark (the delivery fiber never returns).
            const first = yield* startDelivery({ ...deps, messages: undefined })
            const fiber = yield* first.drain(PARENT).pipe(Effect.forkChild)
            yield* Deferred.await(admitted).pipe(Effect.timeout("2 seconds"))
            yield* Fiber.interrupt(fiber)
            expect(parked).toBe(1)

            // Restart: the same durable batch is still unreported, but its
            // receipt already exists. Delivery must adopt it, mark the batch,
            // and never create a second synthetic wake.
            mode = "count"
            const second = yield* startDelivery({ ...deps, messages: undefined })
            yield* second.drain(PARENT)
            expect(resumed).toBe(0)
            yield* expectReported
            const parts = yield* deps.database.db
              .select()
              .from(PartTable)
              .where(eq(PartTable.session_id, SessionID.make(PARENT)))
              .all()
            expect(parts.filter((row) => Reflect.get(row.data, "synthetic") === true)).toHaveLength(1)
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("does not fall back to the mailbox while a wake turn is in flight", async () => {
    let admissions = 0
    let receiveCalls = 0
    const admitted = Deferred.makeUnsafe<void>()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                yield* Deferred.succeed(admitted, void 0)
                return Option.some({
                  activate: Effect.void,
                  result: Effect.never,
                  abort: Effect.void,
                })
              })) as never,
          })
          const messages = {
            receive: () => {
              receiveCalls += 1
              return Effect.succeed({ ok: false as const })
            },
            pendingRecipients: () => Effect.succeed([]),
            changed: Stream.empty,
          } as unknown as DagMessages.Interface
          yield* Effect.gen(function* () {
            yield* seedWake
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages })
            const first = yield* delivery.deliver(PARENT).pipe(Effect.forkChild)
            yield* Deferred.await(admitted).pipe(Effect.timeout("2 seconds"))
            expect(admissions).toBe(1)

            // The wake reservation is held by the parked turn: the second
            // claim must report "nothing consumed" and must not touch the
            // mailbox, or wake-first would become mailbox-first.
            expect(yield* delivery.deliver(PARENT)).toBe(false)
            expect(receiveCalls).toBe(0)

            yield* Fiber.interrupt(first)
            // The admission already marked the batch; the pending retry that
            // the finalizer forks finds nothing left to admit.
            yield* Effect.sleep("50 millis")
            expect(admissions).toBe(1)
            expect(receiveCalls).toBe(0)
            yield* expectReported
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("returns true for a mailbox admission and false when nothing is deliverable", async () => {
    let admissions = 0
    let receiveCalls = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "mailbox handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          const messages = {
            receive: () => {
              receiveCalls += 1
              return Effect.succeed(
                receiveCalls === 1
                  ? ({ ok: true as const, value: [queuedMailboxMessage] } as const)
                  : ({ ok: true as const, value: [] } as const),
              )
            },
            pendingRecipients: () => Effect.succeed([]),
            changed: Stream.empty,
          } as unknown as DagMessages.Interface
          yield* Effect.gen(function* () {
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages })
            expect(yield* delivery.deliver(PARENT)).toBe(true)
            expect(admissions).toBe(1)
            expect(receiveCalls).toBe(1)
            expect(yield* delivery.deliver(PARENT)).toBe(false)
            expect(admissions).toBe(1)
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("a stale claim epoch leaves the wake batch unconfirmed for the next trigger", async () => {
    let admissions = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "wake handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          yield* Effect.gen(function* () {
            yield* seedWake
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages: undefined })
            const observed = SessionCancellation.epoch(PARENT)
            SessionCancellation.begin(PARENT).finish()
            // An ESC advanced the epoch after the inbox captured it: the wake
            // admission is refused and nothing is marked or delivered.
            expect(yield* delivery.deliver(PARENT, observed)).toBe(false)
            expect(admissions).toBe(0)
            expect(yield* deps.store.getUnreportedWakeWorkflows(PARENT)).not.toEqual([])
            expect(yield* deps.store.getUnreportedWakeNodes(PARENT)).not.toEqual([])
            // A fresh trigger has no stale epoch: the same durable batch is
            // admitted and its rows are confirmed.
            expect(yield* delivery.deliver(PARENT)).toBe(true)
            expect(admissions).toBe(1)
            yield* expectReported
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("a cancellation during the mailbox read leaves the queued message deliverable", async () => {
    let admissions = 0
    let receiveCalls = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "mailbox handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          const messages = {
            receive: () => {
              receiveCalls += 1
              // The mailbox attempt captures its own epoch at entry; this ESC
              // lands after that capture and before the admission.
              if (receiveCalls === 1) SessionCancellation.begin(PARENT).finish()
              return Effect.succeed({ ok: true as const, value: [queuedMailboxMessage] } as const)
            },
            pendingRecipients: () => Effect.succeed([]),
            changed: Stream.empty,
          } as unknown as DagMessages.Interface
          yield* Effect.gen(function* () {
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages })
            expect(yield* delivery.deliver(PARENT)).toBe(false)
            expect(admissions).toBe(0)
            // The queued message was never confirmed, so the next trigger
            // delivers the same row instead of dropping it.
            expect(yield* delivery.deliver(PARENT)).toBe(true)
            expect(admissions).toBe(1)
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("a stale drain epoch fences both wake and mailbox in the same attempt", async () => {
    let admissions = 0
    let receiveCalls = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          const messages = {
            receive: () => {
              receiveCalls += 1
              return Effect.succeed({ ok: true as const, value: [queuedMailboxMessage] } as const)
            },
            pendingRecipients: () => Effect.succeed([]),
            changed: Stream.empty,
          } as unknown as DagMessages.Interface
          yield* Effect.gen(function* () {
            yield* seedWake
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages })
            const observed = SessionCancellation.epoch(PARENT)
            SessionCancellation.begin(PARENT).finish()
            // The drain's observation is stale for both sources. The mailbox
            // attempt reuses it instead of re-reading the post-ESC epoch, so
            // neither the wake ledger nor the queued message is admitted.
            expect(yield* delivery.deliver(PARENT, observed)).toBe(false)
            expect(admissions).toBe(0)
            expect(receiveCalls).toBe(1)
            expect(yield* deps.store.getUnreportedWakeWorkflows(PARENT)).not.toEqual([])
            expect(yield* deps.store.getUnreportedWakeNodes(PARENT)).not.toEqual([])
            // A fresh trigger delivers the wake first and returns before the
            // mailbox; the queued message is still there for the next attempt.
            expect(yield* delivery.deliver(PARENT)).toBe(true)
            expect(admissions).toBe(1)
            expect(receiveCalls).toBe(1)
            yield* expectReported
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("scanSessions unions the wake, paused and mailbox ledgers, filters by directory, and degrades per read", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({})
          const mailSession = "ses_mail_scan"
          const messages = {
            receive: () => Effect.succeed({ ok: false as const }),
            pendingRecipients: () => Effect.succeed([{ sessionID: mailSession }]),
            changed: Stream.empty,
          } as unknown as DagMessages.Interface
          yield* Effect.gen(function* () {
            yield* seedWake
            const { db } = yield* Database.Service
            // A due paused reminder in this directory: the inbox 30s tick is
            // its only periodic driver since the dedicated sweep was removed
            // (#1027 D5), so it must appear in scanSessions.
            yield* db
              .insert(SessionTable)
              .values({
                id: SessionID.make("ses_paused_scan"),
                project_id: Project.ID.make(PROJECT_ID),
                slug: "paused",
                directory: AbsolutePath.make(DIRECTORY),
                title: "Paused",
                version: "test",
              })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(WorkflowTable)
              .values({
                id: "dag_paused_scan",
                project_id: Project.ID.make(PROJECT_ID),
                session_id: SessionID.make("ses_paused_scan"),
                directory: AbsolutePath.make(DIRECTORY),
                target_fingerprint: { kind: "none" },
                title: "Paused",
                status: "paused",
                seq: 1,
                config: "{}",
                wake_reported: false,
                time_updated: 0,
              })
              .run()
              .pipe(Effect.orDie)
            // An unreported terminal workflow that belongs to another
            // directory: the store returns its session globally, the
            // ownership read must filter it out.
            yield* db
              .insert(SessionTable)
              .values({
                id: SessionID.make("ses_other_scan"),
                project_id: Project.ID.make(PROJECT_ID),
                slug: "other",
                directory: AbsolutePath.make("/other-worktree"),
                title: "Other",
                version: "test",
              })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(WorkflowTable)
              .values({
                id: "dag_other_scan",
                project_id: Project.ID.make(PROJECT_ID),
                session_id: SessionID.make("ses_other_scan"),
                directory: AbsolutePath.make("/other-worktree"),
                target_fingerprint: { kind: "none" },
                title: "Other",
                // Running workflow: terminal rows are notification-only and
                // deliberately pass ownsSession even across directories.
                status: "running",
                seq: 1,
                config: "{}",
                wake_reported: false,
              })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(WorkflowNodeTable)
              .values({
                id: "node_other_scan",
                workflow_id: "dag_other_scan",
                name: "Other node",
                worker_type: "build",
                status: "completed",
                output: "done",
                depends_on: [],
                required: true,
                seq: 1,
                wake_eligible: true,
                wake_reported: false,
                completed_at: 1_000,
              })
              .run()
              .pipe(Effect.orDie)

            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages })
            const scanned = yield* delivery.scanSessions()
            expect([...scanned].sort()).toEqual([PARENT, mailSession, "ses_paused_scan"].sort())

            // The wake and paused ledgers share one store read (#1026), so a
            // broken read hides both from this tick; the independent mailbox
            // read must still deliver its recipient.
            const broken = yield* startDelivery({
              ...deps,
              messages,
              store: {
                ...deps.store,
                getSessionsWithDueWakes: () => Effect.die(new Error("scan boom")),
              },
            })
            const degraded = yield* broken.scanSessions()
            expect([...degraded]).toEqual([mailSession])
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("registers the dag.delivery source and the hint-only step source when an inbox is present", async () => {
    const sources: InboxSource[] = []
    const steps: StepSource[] = []
    const inbox = {
      init: () => Effect.void,
      register: (source: InboxSource) =>
        Effect.sync(() => {
          sources.push(source)
        }),
      registerStep: (source: StepSource) =>
        Effect.sync(() => {
          steps.push(source)
        }),
      drain: () => Effect.void,
      nudge: () => Effect.void,
      pullForStep: () => Effect.succeed(true),
      submit: () => Effect.fail(new SessionInbox.InboxNotWired({ source: "goal.continue" })),
    } satisfies SessionInbox.Interface
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({})
          yield* Effect.gen(function* () {
            const deps = yield* services()
            yield* startDelivery({ ...deps, messages: undefined, inbox })
            expect(sources.map((source) => source.id)).toEqual(["dag.delivery"])
            const source = sources[0]!
            expect(source.priority).toBe(5)
            expect(source.mode).toBe("idle_only")
            expect(source.hint(SessionID.make(PARENT))).toBe(true)
            expect(source.scan).toBeDefined()
            expect(source.claim).toBeDefined()

            expect(steps.map((step) => step.id)).toEqual(["dag.mailbox.step"])
            expect(steps[0]!.hint(SessionID.make(PARENT))).toBe(true)
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("keeps the wake phase ahead of the mailbox phase in one drain", async () => {
    let admissions = 0
    let receiveCalls = 0
    const messages = {
      receive: () => {
        receiveCalls += 1
        return Effect.succeed({ ok: false as const })
      },
      pendingRecipients: () => Effect.succeed([]),
      changed: Stream.empty,
    } as unknown as DagMessages.Interface
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = baseLayers()
          const session = Layer.mock(Session.Service, {
            get: () => Effect.succeed(sessionInfo),
            messages: () => Effect.succeed([]),
            getPart: () => Effect.succeed(undefined),
          })
          const prompt = mockSessionPrompt({
            prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
              Effect.gen(function* () {
                admissions += 1
                yield* persistAdmission ?? Effect.void
                return Option.some({
                  activate: Effect.void,
                  result: Effect.succeed(reply(input.sessionID as string, "wake handled")),
                  abort: Effect.void,
                })
              })) as never,
          })
          yield* Effect.gen(function* () {
            yield* seedWake
            const deps = yield* services()
            const delivery = yield* startDelivery({ ...deps, messages })
            yield* delivery.drain(PARENT)
            expect(admissions).toBe(1)
            // The admitted wake ended this drain; the mailbox phase did not run.
            expect(receiveCalls).toBe(0)
            yield* delivery.drain(PARENT)
            // No wake remained, so the same trigger reached the mailbox phase.
            expect(receiveCalls).toBe(1)
            expect(admissions).toBe(1)
            yield* expectReported
          }).pipe(Effect.provide(Layer.mergeAll(base.all, session, prompt)))
        }),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("forks every mailbox change nudge so a pending inbox drain neither blocks the stream nor outlives the instance (#1027 D5)", async () => {
    const started: string[] = []
    const interrupted: string[] = []
    const bothStarted = Deferred.makeUnsafe<void>()
    // The real `inbox.nudge` resolves only after the whole drain, and the drain
    // awaits the admitted model turn: model it as a drain that never ends.
    const inbox = {
      init: () => Effect.void,
      register: () => Effect.void,
      registerStep: () => Effect.void,
      drain: () => Effect.void,
      nudge: (sessionID: SessionID) =>
        Effect.sync(() => {
          started.push(sessionID)
          if (started.length === 2) Deferred.doneUnsafe(bothStarted, Effect.void)
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => void interrupted.push(sessionID))),
        ),
      pullForStep: () => Effect.succeed(true),
      submit: () => Effect.fail(new SessionInbox.InboxNotWired({ source: "goal.continue" })),
    } satisfies SessionInbox.Interface
    const recipients = ["ses_long_turn_a", "ses_long_turn_b"]
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* Queue.unbounded<DagMessages.Change>()
          const messages = {
            receive: () => Effect.succeed({ ok: false as const }),
            pendingRecipients: () => Effect.succeed([]),
            changed: Stream.fromQueue(changes),
          } as unknown as DagMessages.Interface
          const instance = yield* Scope.make()
          const deps = yield* services()
          yield* startDelivery({ ...deps, scope: instance, messages, inbox })
          for (const recipientSessionID of recipients) {
            Queue.offerUnsafe(changes, { recipientSessionID, directory: DIRECTORY, kind: "queued", mailboxVersion: 1 })
          }
          // The first recipient's drain never ends, yet the second event is
          // consumed and nudged: the stream does not wait on the inbox.
          yield* awaitWithTimeout(Deferred.await(bothStarted), "the second recipient's nudge was never issued")
          expect(started).toEqual(recipients)
          expect(interrupted).toEqual([])
          // The pending nudges belong to the instance scope.
          yield* Scope.close(instance, Exit.void)
          expect(interrupted.toSorted()).toEqual(recipients)
        }).pipe(Effect.provide(inertGraph())),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("the startup sweep walks every mailbox ledger page and offers each recipient to the drain (#1027 D5)", async () => {
    const ledger = pagedMailboxes(pagedIDs)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deps = yield* services()
          yield* startDelivery({ ...deps, messages: ledger.messages })
          // Construction runs the sweep: the first page, then each page after
          // the previous page's last recipient, until a short page.
          expect(ledger.reads).toEqual([undefined, pagedIDs[63], pagedIDs[127]])
          yield* pollWithTimeout(
            Effect.sync(() => (ledger.attempted.size === pagedIDs.length ? true : undefined)),
            () => `only ${ledger.attempted.size}/${pagedIDs.length} recipients got a delivery attempt`,
          )
        }).pipe(Effect.provide(inertGraph())),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("scanSessions takes one mailbox page per call, advances the cursor, and wraps at the end (#1027 D5)", async () => {
    const ledger = pagedMailboxes(pagedIDs)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deps = yield* services()
          const delivery = yield* startDelivery({ ...deps, messages: ledger.messages })
          // Only the ticks are measured, not the startup sweep.
          ledger.reads.length = 0
          expect(yield* delivery.scanSessions()).toEqual(pagedIDs.slice(0, 64))
          expect(yield* delivery.scanSessions()).toEqual(pagedIDs.slice(64, 128))
          // A short page is the end of the ledger...
          expect(yield* delivery.scanSessions()).toEqual(pagedIDs.slice(128))
          // ...so the next tick restarts at the first page rather than reading
          // an empty one past the end.
          expect(yield* delivery.scanSessions()).toEqual(pagedIDs.slice(0, 64))
          expect(ledger.reads).toEqual([undefined, pagedIDs[63], pagedIDs[127], undefined])
        }).pipe(Effect.provide(inertGraph())),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })

  it("scanSessions keeps its mailbox cursor when a page read fails (#1027 D5)", async () => {
    const ledger = pagedMailboxes(pagedIDs)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deps = yield* services()
          const delivery = yield* startDelivery({ ...deps, messages: ledger.messages })
          ledger.reads.length = 0
          expect(yield* delivery.scanSessions()).toEqual(pagedIDs.slice(0, 64))
          ledger.control.failNext = true
          // The failed read degrades to "nothing from the mailbox ledger" for
          // this tick, but the cursor must not rewind to the first page...
          expect(yield* delivery.scanSessions()).toEqual([])
          // ...so the next tick retries the page that failed.
          expect(yield* delivery.scanSessions()).toEqual(pagedIDs.slice(64, 128))
          expect(ledger.reads).toEqual([undefined, pagedIDs[63], pagedIDs[63]])
        }).pipe(Effect.provide(inertGraph())),
      ).pipe(Effect.provideService(InstanceRef, instanceRef)),
    )
  })
})
