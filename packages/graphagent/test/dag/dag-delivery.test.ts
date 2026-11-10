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
import { Deferred, Effect, Fiber, Layer, Option, Scope, Stream, type Context } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
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
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"

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
          const prompt = Layer.mock(SessionPrompt.Service, {
            prepareIfIdle: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
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
              return Layer.mock(SessionPrompt.Service, {
                prepareIfIdle: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
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
          const prompt = Layer.mock(SessionPrompt.Service, {
            prepareIfIdle: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
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
})