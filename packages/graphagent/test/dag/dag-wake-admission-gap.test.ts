// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagStore } from "@graphagent/core/dag/store"
import { DagProjector } from "@graphagent/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

function userData(created: number): Omit<SessionV1.User, "id" | "sessionID"> {
  return {
    role: "user",
    agent: "build",
    model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
    time: { created },
  }
}

type Probe = {
  readonly admitted: Deferred.Deferred<void>
  readonly markEntered?: Deferred.Deferred<void>
  readonly legacyAdmission?: boolean
}

function restartLayer(filename: string, probe: Probe) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const rawStore = DagStore.layer.pipe(Layer.provide(database))
  const store = probe.markEntered
    ? Layer.effect(
        DagStore.Service,
        Effect.gen(function* () {
          const original = yield* DagStore.Service
          return DagStore.Service.of({
            ...original,
            markWakeBatchReported: () =>
              Deferred.succeed(probe.markEntered!, undefined).pipe(Effect.andThen(Effect.never), Effect.interruptible),
          })
        }),
      ).pipe(Layer.provide(rawStore))
    : rawStore
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, status, dag)
  const session = Layer.unwrap(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return Layer.mock(Session.Service, {
        get: () =>
          Effect.succeed({
            id: SessionID.make("ses_parent"),
            agent: "build",
            permission: [],
            projectID: Project.ID.make("project-1"),
            directory: path.dirname(filename),
            slug: "parent",
            title: "Parent",
            version: "test",
            time: { created: 0, updated: 0 },
          }),
        messages: () =>
          db
            .select()
            .from(MessageTable)
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) =>
                rows.map(
                  (row): SessionV1.WithParts => ({
                    info: {
                      id: row.id,
                      sessionID: row.session_id,
                      role: "user",
                      agent: "build",
                      model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
                      time: { created: row.data.time.created },
                    },
                    parts: [],
                  }),
                ),
              ),
            ),
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
            return row
              ? Schema.decodeUnknownSync(SessionV1.TextPart)({
                  ...row.data,
                  id: row.id,
                  sessionID: row.session_id,
                  messageID: row.message_id,
                })
              : undefined
          }),
      })
    }),
  ).pipe(Layer.provide(database))
  // Stub only the model-facing admission boundary: persist the synthetic
  // message exactly before returning the prepared handle, as prepareIfIdle
  // does in production. The real loop, lease, wake store, DB and restart sweep
  // run unchanged. No remote model is invoked.
  const prompt = Layer.unwrap(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return Layer.mock(SessionPrompt.Service, {
        prepareIfIdle: (input, persistAdmission) =>
          Effect.gen(function* () {
            const messageID = input.messageID ?? MessageID.ascending()
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx
                    .insert(MessageTable)
                    .values({
                      id: messageID,
                      session_id: input.sessionID,
                      data: userData(Date.now()),
                    })
                    .run()
                    .pipe(Effect.orDie)
                  for (const part of input.parts) {
                    if (part.type !== "text") continue
                    const data = { type: "text" as const, text: part.text, synthetic: part.synthetic }
                    yield* tx
                      .insert(PartTable)
                      .values({
                        id: part.id ? PartID.make(part.id) : PartID.ascending(),
                        message_id: messageID,
                        session_id: input.sessionID,
                        data,
                      })
                      .run()
                      .pipe(Effect.orDie)
                  }
                  yield* Deferred.succeed(probe.admitted, undefined)
                  if (!probe.legacyAdmission) yield* persistAdmission ?? Effect.void
                }),
              )
              .pipe(Effect.orDie)
            if (probe.legacyAdmission) yield* persistAdmission ?? Effect.void
            return Option.some({ activate: Effect.void, result: Effect.never, abort: Effect.void })
          }),
      })
    }),
  ).pipe(Layer.provide(database))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.fresh(Layer.mergeAll(base, loop))
}

function seed(directory: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.make("project-1"),
        worktree: AbsolutePath.make(directory),
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make("ses_parent"),
        project_id: Project.ID.make("project-1"),
        slug: "parent",
        directory: AbsolutePath.make(directory),
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowTable)
      .values({
        id: "dag_gap",
        project_id: Project.ID.make("project-1"),
        session_id: SessionID.make("ses_parent"),
        directory: AbsolutePath.make(directory),
        target_fingerprint: { kind: "none" },
        title: "Wake gap",
        status: "completed",
        seq: 1,
        config: "{}",
        wake_reported: false,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkflowNodeTable)
      .values({
        id: "node",
        workflow_id: "dag_gap",
        name: "Node",
        worker_type: "build",
        status: "completed",
        output: "done",
        depends_on: [],
        required: true,
        seq: 1,
        wake_eligible: true,
        wake_reported: false,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const it = testEffect(Layer.empty)

describe("DAG wake admission-to-mark crash boundary (#697/B4)", () => {
  for (const scenario of ["atomic", "atomic-new-row", "legacy-human"] as const) {
    it.instance(`recovers ${scenario} without inserting a duplicate synthetic wake`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filename = path.join(test.directory, "wake-gap.sqlite")
        const legacy = scenario === "legacy-human"
        const instance = {
          directory: test.directory,
          worktree: test.directory,
          root: test.directory,
          project: {
            id: Project.ID.make("project-1"),
            worktree: AbsolutePath.make(test.directory),
            time: { created: 0, updated: 0 },
            sandboxes: [],
          },
        }
        const admitted = yield* Deferred.make<void>()
        const markEntered = yield* Deferred.make<void>()
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seed(test.directory)
            const loop = yield* DagLoop.Service
            yield* loop.init().pipe(Effect.forkChild)

            yield* Deferred.await(admitted).pipe(Effect.timeout("2 seconds"))

            yield* Deferred.await(markEntered).pipe(Effect.timeout("2 seconds"))

            // Dispose while the mark is blocked: new admission rolls its transcript
            // back with the mark; legacy admission left a committed receipt.
          }).pipe(
            Effect.provide(restartLayer(filename, { admitted, markEntered, legacyAdmission: legacy })),
            Effect.provideService(InstanceRef, instance),
          ),
        )

        const restartedAdmission = yield* Deferred.make<void>()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { db } = yield* Database.Service

            expect(yield* db.select().from(PartTable).all()).toHaveLength(legacy ? 1 : 0)

            if (scenario === "atomic-new-row") {
              yield* db
                .insert(WorkflowNodeTable)
                .values({
                  id: "new_node",
                  workflow_id: "dag_gap",
                  name: "New node",
                  worker_type: "build",
                  status: "completed",
                  output: "new result",
                  depends_on: [],
                  required: true,
                  seq: 2,
                  wake_eligible: true,
                  wake_reported: false,
                })
                .run()
                .pipe(Effect.orDie)
            }
            if (legacy) {
              yield* db
                .insert(MessageTable)
                .values({
                  id: MessageID.make("msg_fresh_human"),
                  session_id: SessionID.make("ses_parent"),
                  data: userData(Date.now() + 1000),
                })
                .run()
                .pipe(Effect.orDie)
              const data = { type: "text" as const, text: "New human request", synthetic: false }
              yield* db
                .insert(PartTable)
                .values({
                  id: PartID.make("prt_fresh_human"),
                  message_id: MessageID.make("msg_fresh_human"),
                  session_id: SessionID.make("ses_parent"),
                  data,
                })
                .run()
                .pipe(Effect.orDie)
            }
            const loop = yield* DagLoop.Service
            const store = yield* DagStore.Service

            yield* loop.init()

            yield* pollWithTimeout(
              store
                .getUnreportedWakeWorkflows("ses_parent")
                .pipe(Effect.map((rows) => (rows.length === 0 ? true : undefined))),
              "restart did not acknowledge the existing wake",
            )
            expect(yield* store.getUnreportedWakeNodes("ses_parent")).toEqual([])
            const parts = yield* db
              .select()
              .from(PartTable)
              .where(eq(PartTable.session_id, SessionID.make("ses_parent")))
              .all()
            const synthetic = parts.filter(
              (part) => part.data.type === "text" && Reflect.get(part.data, "synthetic") === true,
            )
            expect(synthetic).toHaveLength(1)
            const text = Reflect.get(synthetic[0].data, "text")
            if (typeof text !== "string") throw new Error("Expected text wake")
            expect(text).toContain('Node "Node" completed')
            if (scenario === "atomic-new-row") expect(text).toContain('Node "New node" completed')
          }).pipe(
            Effect.provide(restartLayer(filename, { admitted: restartedAdmission })),
            Effect.provideService(InstanceRef, instance),
          ),
        )
      }),
    )
  }
})
