/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded DB rows and Session service mocks exercise transaction rollback without starting a model. */
import { expect, it } from "bun:test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Hash } from "@opencode-ai/core/util/hash"
import type { Session } from "@/session/session"
import { deliverReport, reportIdentity, selectReportNode } from "@/dag/runtime/report-delivery"
import { commitOutputFileRef, verifyOutputFileRef } from "@/dag/runtime/output-ref"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"
import { WorkflowAuthoring } from "@/dag/authoring"
import { parseWorkflowConfig, resultProtocol } from "@/dag/dag"
import { before } from "@/session/message-v2"

const Barrier = EventV2.define({ type: "test.dag.delivery.barrier", schema: {} })

function fixture(
  work: (input: {
    database: Database.Interface
    store: DagStore.Interface
    sessions: Session.Interface
    workflow: DagStore.WorkflowRow
    deliver: () => Effect.Effect<boolean, never, Database.Service>
    crash: (value: boolean) => void
    wakeCrash: (value: boolean) => void
    visibleReports: EventV2.Payload[]
    flush: () => Effect.Effect<void>
  }) => Effect.Effect<unknown, unknown, Database.Service>,
  options?: {
    output: unknown
    schema: Record<string, unknown>
    source?: SessionV1.WithParts
    acknowledge?: boolean
  },
) {
  const database = Database.layerFromPath(":memory:")
  const eventsLayer = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(eventsLayer), Layer.provide(database))
  const layer = Layer.mergeAll(database, DagStore.layer.pipe(Layer.provide(database)), eventsLayer, projector)
  return Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const rawStore = yield* DagStore.Service
      const events = yield* EventV2.Service
      let failWake = false
      const store: DagStore.Interface = {
        ...rawStore,
        markWakeBatchReported: (batch) =>
          failWake ? Effect.die(new Error("simulated wake write failure")) : rawStore.markWakeBatchReported(batch),
      }
      const visibleReports: EventV2.Payload[] = []
      let barrier: Deferred.Deferred<void> | undefined
      yield* events.all().pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === Barrier.type && barrier) {
              yield* Deferred.succeed(barrier, undefined)
              return
            }
            if (
              event.type === SessionV1.Event.PartUpdated.type &&
              typeof event.data === "object" &&
              event.data !== null &&
              "part" in event.data
            ) {
              const part = event.data.part as SessionV1.Part
              if (part.type === "text" && part.metadata?.dag_delivery) visibleReports.push(event)
            }
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const flush = () =>
        Effect.gen(function* () {
          barrier = yield* Deferred.make<void>()
          yield* events.publish(Barrier, {})
          yield* Deferred.await(barrier)
        })
      const db = database.db
      const text = "  Exact final report\n\nwith **formatting** and trailing space.  "
      const config = {
        name: "delivery",
        result_protocol: "final_response",
        delivery_node: "final",
        nodes: [{ id: "final", depends_on: [], ...(options ? { output_schema: options.schema } : {}) }],
      }
      yield* db
        .insert(ProjectTable)
        .values({ id: "proj-1" as never, worktree: "/tmp" as never, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: "ses_parent" as never,
          project_id: "proj-1" as never,
          directory: "/tmp",
          title: "parent",
          slug: "parent",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      yield* db
        .insert(WorkflowTable)
        .values({
          id: "wf-1",
          project_id: "proj-1" as never,
          session_id: "ses_parent" as never,
          title: "delivery",
          status: "completed",
          config: JSON.stringify(config),
          graph_rev: 2,
          seq: 7,
          completed_at: 100,
          time_created: 1,
          time_updated: 100,
        })
        .run()
      yield* db
        .insert(WorkflowNodeTable)
        .values({
          workflow_id: "wf-1",
          id: "final",
          name: "Final",
          worker_type: "general",
          status: "completed",
          depends_on: [],
          output: options ? options.output : text,
          seq: 6,
          child_session_id: "ses_child",
          time_created: 1,
          time_updated: 100,
        })
        .run()
      const workflow = (yield* store.getWorkflow("wf-1"))!
      let fail = false
      yield* events.project(SessionV1.Event.PartUpdated, (event) =>
        fail && event.data.part.type === "text" && event.data.part.metadata?.dag_delivery?.kind === "answer"
          ? Effect.die(new Error("simulated process failure before receipt"))
          : Effect.void,
      )
      const sessions = {
        get: () =>
          Effect.succeed({ id: "ses_parent", agent: "build", model: { providerID: "test", id: "test-model" } }),
        messages: (input: { limit?: number }) =>
          Effect.gen(function* () {
            const rows = yield* db.select().from(MessageTable)
            const parts = yield* db.select().from(PartTable)
            const history = rows
              .map((row) => ({
                info: { ...row.data, id: row.id, sessionID: row.session_id },
                parts: parts
                  .filter((part) => part.message_id === row.id)
                  .map((part) => ({
                    ...part.data,
                    id: part.id,
                    sessionID: part.session_id,
                    messageID: part.message_id,
                  })),
              }))
              .toSorted((left, right) => (before(left.info, right.info) ? -1 : 1))
            return input.limit === undefined ? history : history.slice(-input.limit)
          }),
        getPart: (input: { partID: string }) =>
          db
            .select()
            .from(PartTable)
            .where(eq(PartTable.id, input.partID as never))
            .pipe(
              Effect.map((rows) =>
                rows[0]
                  ? { ...rows[0].data, id: rows[0].id, sessionID: rows[0].session_id, messageID: rows[0].message_id }
                  : undefined,
              ),
            ),
        updateMessage: (info: SessionV1.Info) =>
          events.publish(SessionV1.Event.MessageUpdated, { sessionID: info.sessionID, info }).pipe(Effect.as(info)),
        updatePart: (part: SessionV1.Part) =>
          events
            .publish(SessionV1.Event.PartUpdated, { sessionID: part.sessionID, part, time: 100 })
            .pipe(Effect.as(part)),
      } as unknown as Session.Interface
      const deliver = () =>
        Effect.gen(function* () {
          const nodes = yield* store.getCurrentNodes("wf-1")
          return yield* deliverReport({
            workflow,
            events,
            source: options?.source,
            store,
            sessions,
            directory: "/tmp",
            batch: { nodes, workflows: [workflow] },
            acknowledge: options?.acknowledge,
          })
        }).pipe(Effect.orDie)
      yield* work({
        database,
        store,
        sessions,
        workflow,
        deliver,
        crash: (value) => {
          fail = value
        },
        wakeCrash: (value) => {
          failWake = value
        },
        visibleReports,
        flush,
      })
    }),
  ).pipe(Effect.provide(layer), Effect.runPromise)
}

it("copies the answer verbatim with source metadata and adopts the same receipt after restart", () =>
  fixture(({ database, store, workflow, deliver }) =>
    Effect.gen(function* () {
      expect(yield* deliver()).toBe(true)
      const first = yield* database.db.select().from(PartTable)
      const answers = first.filter(
        (part) =>
          part.data.type === "text" && (part.data as SessionV1.TextPart).metadata?.dag_delivery?.kind === "answer",
      )
      expect(answers).toHaveLength(1)
      expect((answers[0].data as SessionV1.TextPart).text).toBe(
        "  Exact final report\n\nwith **formatting** and trailing space.  ",
      )
      expect(answers[0].id).toBe(reportIdentity(workflow).answerID)
      expect((answers[0].data as SessionV1.TextPart).time?.end).toBe(100)
      expect(reportIdentity(workflow).sourceID < reportIdentity(workflow).answerID).toBe(true)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
      // Reconstructed callers have no in-memory receipt cache. A durable receipt
      // still suppresses re-insertion if an old wake flag needs re-acknowledging.
      yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
      expect(yield* deliver()).toBe(true)
      expect(yield* database.db.select().from(PartTable)).toHaveLength(first.length)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
    }),
  ))

it("marks only the workflow completion row and never consumes a node wake", () =>
  fixture(({ store, deliver }) =>
    Effect.gen(function* () {
      expect(yield* deliver()).toBe(true)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
      expect((yield* store.getNode("wf-1", "final"))?.wakeReported).toBe(false)
    }),
  ))

it("attributes the report to the parent model instead of a differing child source", () =>
  fixture(
    ({ database, sessions, workflow, deliver }) =>
      Effect.gen(function* () {
        yield* sessions.updateMessage({
          id: "msg_parent_user" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "parent-provider" as never, modelID: "parent-model" as never },
        })
        yield* sessions.updateMessage({
          ...parentAnswer("msg_parent_answer", "msg_parent_user"),
          providerID: "parent-provider" as never,
          modelID: "parent-model" as never,
        })
        expect(yield* deliver()).toBe(true)
        const report = (yield* database.db.select().from(MessageTable)).find(
          (row) => row.id === reportIdentity(workflow).messageID,
        )
        expect(report?.data.role).toBe("assistant")
        const data = report?.data as SessionV1.Assistant | undefined
        if (!data) throw new Error("report assistant message missing")
        expect(String(data.providerID)).toBe("parent-provider")
        expect(String(data.modelID)).toBe("parent-model")
      }),
    {
      output: "child text",
      schema: {},
      source: {
        info: {
          ...parentAnswer("msg_child_final", "msg_child_input"),
          providerID: "child-provider" as never,
          modelID: "child-model" as never,
        },
        parts: [],
      },
    },
  ))

it("defers the completion acknowledgement to the wake admission without duplicating the report", () =>
  fixture(
    ({ database, store, workflow, deliver }) =>
      Effect.gen(function* () {
        expect(yield* deliver()).toBe(true)
        expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
        const parts = yield* database.db.select().from(PartTable)
        yield* store.markWakeBatchReported({ nodes: [], workflows: [workflow] })
        expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
        expect(yield* deliver()).toBe(true)
        expect(yield* database.db.select().from(PartTable)).toHaveLength(parts.length)
      }),
    { output: "deferred report", schema: {}, acknowledge: false },
  ))

it("keeps a deferred report uncommitted while a parent user turn is unanswered", () =>
  fixture(
    ({ database, sessions, store, deliver }) =>
      Effect.gen(function* () {
        yield* sessions.updateMessage({
          id: "msg_deferred_user" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "test" as never, modelID: "test" as never },
        })
        expect(yield* deliver()).toBe(false)
        expect(yield* database.db.select().from(PartTable)).toHaveLength(0)
        yield* sessions.updateMessage(parentAnswer("msg_deferred_answer", "msg_deferred_user"))
        expect(yield* deliver()).toBe(true)
        expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
      }),
    { output: "deferred report", schema: {}, acknowledge: false },
  ))

it("rolls back the entire transcript and wake mark when receipt persistence fails", () =>
  fixture(({ database, store, deliver, crash }) =>
    Effect.gen(function* () {
      crash(true)
      expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* database.db.select().from(MessageTable)).toHaveLength(0)
      expect(yield* database.db.select().from(PartTable)).toHaveLength(0)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
      crash(false)
      expect(yield* deliver()).toBe(true)
      expect(
        (yield* database.db.select().from(MessageTable)).filter((row) => row.data.role === "assistant"),
      ).toHaveLength(1)
    }),
  ))

it("publishes no report events when the final wake write rolls back, then emits once on retry", () =>
  fixture(({ database, store, deliver, wakeCrash, visibleReports, flush }) =>
    Effect.gen(function* () {
      wakeCrash(true)
      expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      yield* flush()
      expect(visibleReports).toHaveLength(0)
      expect(yield* database.db.select().from(MessageTable)).toHaveLength(0)
      expect(yield* database.db.select().from(PartTable)).toHaveLength(0)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
      wakeCrash(false)
      expect(yield* deliver()).toBe(true)
      yield* flush()
      expect(visibleReports).toHaveLength(2)
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
      yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
      expect(yield* deliver()).toBe(true)
      yield* flush()
      expect(visibleReports).toHaveLength(2)
    }),
  ))

function parentAnswer(id: string, parentID: string): SessionV1.Assistant {
  return {
    id: id as never,
    sessionID: "ses_parent" as never,
    parentID: parentID as never,
    role: "assistant",
    time: { created: 60, completed: 60 },
    agent: "build",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    providerID: "test" as never,
    modelID: "test" as never,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

for (const field of ["report", "summary"] as const) {
  it(`preserves all structured fields alongside ${field}`, () => {
    const output = { [field]: "Readable report", metrics: { count: 3 }, details: ["a", "b"] }
    const raw = JSON.stringify(output, null, 2)
    const source: SessionV1.WithParts = {
      info: parentAnswer("msg_child_final", "msg_child_input"),
      parts: [
        {
          id: "prt_child" as never,
          sessionID: "ses_parent" as never,
          messageID: "msg_child_final" as never,
          type: "text",
          text: raw,
        },
      ],
    }
    return fixture(
      ({ database, deliver }) =>
        Effect.gen(function* () {
          expect(yield* deliver()).toBe(true)
          const answer = (yield* database.db.select().from(PartTable))
            .map((row) => row.data as SessionV1.TextPart)
            .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
          expect(JSON.parse(answer.text)).toEqual(output)
          expect(answer.text).toBe(field === "report" ? raw : JSON.stringify(output))
        }),
      {
        output,
        schema: { type: "object", properties: { [field]: { type: "string" } } },
        ...(field === "report" ? { source } : {}),
      },
    )
  })
}

for (const output of [
  "false",
  "",
  false,
  null,
  0,
  {
    kind: "file_ref",
    content_ref: "report",
    path: "/tmp/schema-report.json",
    size: 10,
    sha256: "schema-value",
    summary: "Not an artifact",
    storage: "managed-v1",
    source_path: "/tmp/source.json",
    provenance: { workflow_id: "wf-1", node_id: "final", child_session_id: "ses_child", replan_attempt: 0 },
    details: ["Preserve this field"],
  },
]) {
  for (const withSource of [true, false]) {
    it(`delivers complete schema JSON ${JSON.stringify(output)} ${withSource ? "with" : "without"} source text`, () => {
      const raw = `  ${JSON.stringify(output, null, 2)}\n`
      return fixture(
        ({ database, deliver }) =>
          Effect.gen(function* () {
            expect(yield* deliver()).toBe(true)
            const answer = (yield* database.db.select().from(PartTable))
              .map((row) => row.data as SessionV1.TextPart)
              .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
            expect(answer.text).toBe(withSource ? raw : JSON.stringify(output))
            expect(JSON.parse(answer.text)).toEqual(output)
          }),
        {
          output,
          schema: { type: output === null ? "null" : typeof output === "number" ? "integer" : typeof output },
          ...(withSource
            ? {
                source: {
                  info: parentAnswer("msg_child_final", "msg_child_input"),
                  parts: [
                    {
                      id: "prt_child" as never,
                      sessionID: "ses_parent" as never,
                      messageID: "msg_child_final" as never,
                      type: "text" as const,
                      text: raw,
                    },
                  ],
                },
              }
            : {}),
        },
      )
    })
  }
}

for (const state of ["error", "unfinished", "wrong-parent", "dag-report"] as const) {
  it(`keeps a pending user request behind a newer ${state} assistant`, () =>
    fixture(({ database, sessions, deliver }) =>
      Effect.gen(function* () {
        yield* sessions.updateMessage({
          id: "msg_pending" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "test" as never, modelID: "test" as never },
        })
        const reply = parentAnswer("msg_failed_attempt", state === "wrong-parent" ? "msg_previous" : "msg_pending")
        if (state === "error") reply.error = { name: "UnknownError", data: { message: "provider failed" } } as never
        if (state === "unfinished") {
          reply.finish = undefined
          reply.time.completed = undefined
        }
        yield* sessions.updateMessage(reply)
        if (state === "dag-report")
          yield* sessions.updatePart({
            id: "prt_other_dag" as never,
            messageID: reply.id,
            sessionID: reply.sessionID,
            type: "text",
            text: "older workflow result",
            metadata: { dag_delivery: { workflow_id: "other", completion_seq: 1, kind: "answer" } },
          })
        expect(yield* deliver()).toBe(false)
        expect(
          (yield* database.db.select().from(PartTable)).some(
            (row) =>
              row.id ===
              reportIdentity(
                makeWorkflowRow({
                  id: "wf-1",
                  sessionId: "ses_parent",
                  seq: 7,
                  completedAt: 100,
                  timeUpdated: 100,
                }),
              ).answerID,
          ),
        ).toBe(false)
        const answered = parentAnswer("msg_real_answer", "msg_pending")
        answered.time = { created: 70, completed: 70 }
        yield* sessions.updateMessage(answered)
        expect(yield* deliver()).toBe(true)
      }),
    ))
}

for (const command of ["memory", "trust", "goal", "subgoal"])
  it(`delivers after a completed local /${command} without an assistant response`, () =>
    fixture(({ sessions, store, deliver }) =>
      Effect.gen(function* () {
        const user: SessionV1.User = {
          id: "msg_command" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "test" as never, modelID: "test" as never },
        }
        yield* sessions.updateMessage(user)
        yield* sessions.updatePart({
          id: "prt_command" as never,
          messageID: user.id,
          sessionID: user.sessionID,
          type: "text",
          text: `/${command} status`,
          metadata: { command },
        })
        expect(yield* deliver()).toBe(false)
        yield* sessions.updatePart({
          id: "prt_response" as never,
          messageID: user.id,
          sessionID: user.sessionID,
          type: "text",
          text: "Command completed",
          ignored: command === "goal" || command === "subgoal",
          time: { start: 60, end: 60 },
        })
        expect(yield* deliver()).toBe(true)
        expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
      }),
    ))

for (const command of ["goal", "subgoal"])
  it(`delivers behind a historical /${command} dispatch failure persisted without metadata or assistant`, () =>
    fixture(({ database, store, sessions, deliver }) =>
      Effect.gen(function* () {
        yield* sessions.updateMessage({
          id: "msg_historic" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "test" as never, modelID: "test" as never },
        })
        yield* sessions.updatePart({
          id: "prt_historic" as never,
          messageID: "msg_historic" as never,
          sessionID: "ses_parent" as never,
          type: "text",
          text: `⚠️ /${command} 执行失败，请检查日志。`,
          synthetic: true,
          ignored: true,
          time: { start: 50, end: 50 },
        })
        expect(yield* deliver()).toBe(true)
        expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(true)
        expect(
          (yield* database.db.select().from(PartTable)).filter(
            (part) => (part.data as SessionV1.TextPart).metadata?.dag_delivery?.kind === "answer",
          ),
        ).toHaveLength(1)
      }),
    ))

for (const variant of [
  { name: "lookalike ordinary", text: "⚠️ /goal 执行失败", ignored: true, synthetic: true, ended: true },
  {
    name: "lookalike unfinished",
    text: "⚠️ /goal 执行失败，请检查日志。",
    ignored: true,
    synthetic: true,
    ended: false,
  },
  {
    name: "lookalike nonignored",
    text: "⚠️ /goal 执行失败，请检查日志。",
    ignored: false,
    synthetic: true,
    ended: true,
  },
  {
    name: "lookalike nonsynthetic",
    text: "⚠️ /goal 执行失败，请检查日志。",
    ignored: true,
    synthetic: false,
    ended: true,
  },
])
  it(`keeps a pending user request behind a ${variant.name} failure part`, () =>
    fixture(({ database, sessions, deliver }) =>
      Effect.gen(function* () {
        yield* sessions.updateMessage({
          id: "msg_lookalike" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "test" as never, modelID: "test" as never },
        })
        yield* sessions.updatePart({
          id: "prt_lookalike" as never,
          messageID: "msg_lookalike" as never,
          sessionID: "ses_parent" as never,
          type: "text",
          text: variant.text,
          ...(variant.synthetic ? { synthetic: true } : {}),
          ...(variant.ignored ? { ignored: true } : {}),
          time: variant.ended ? { start: 50, end: 50 } : { start: 50 },
        })
        expect(yield* deliver()).toBe(false)
        expect(yield* database.db.select().from(PartTable)).toHaveLength(1)
        const answer = parentAnswer("msg_real_answer", "msg_lookalike")
        answer.time = { created: 70, completed: 70 }
        yield* sessions.updateMessage(answer)
        expect(yield* deliver()).toBe(true)
      }),
    ))

for (const state of ["unfinished", "synthetic", "same-part", "model-command"] as const)
  it(`does not treat a ${state} command response as an answered user turn`, () =>
    fixture(({ sessions, deliver }) =>
      Effect.gen(function* () {
        yield* sessions.updateMessage({
          id: "msg_command" as never,
          sessionID: "ses_parent" as never,
          role: "user",
          time: { created: 50 },
          agent: "build",
          model: { providerID: "test" as never, modelID: "test" as never },
        })
        yield* sessions.updatePart({
          id: "prt_command" as never,
          messageID: "msg_command" as never,
          sessionID: "ses_parent" as never,
          type: "text",
          text: "/command",
          metadata: { command: state === "model-command" ? "review" : "memory" },
          ...(state === "same-part" ? { time: { start: 50, end: 50 } } : {}),
        })
        if (state !== "same-part")
          yield* sessions.updatePart({
            id: "prt_response" as never,
            messageID: "msg_command" as never,
            sessionID: "ses_parent" as never,
            type: "text",
            text: "Response text",
            synthetic: state === "synthetic",
            time: { start: 60, ...(state === "unfinished" ? {} : { end: 60 }) },
          })
        expect(yield* deliver()).toBe(false)
      }),
    ))

it("keeps an unanswered user behind more than twenty assistant tool turns", () =>
  fixture(({ database, sessions, deliver }) =>
    Effect.gen(function* () {
      yield* sessions.updateMessage({
        id: "msg_pending" as never,
        sessionID: "ses_parent" as never,
        role: "user",
        time: { created: 50 },
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
      })
      for (let turn = 0; turn < 25; turn++) {
        const reply = parentAnswer(`msg_tool_${turn}`, "msg_pending")
        reply.time = { created: 60 + turn, completed: 60 + turn }
        reply.finish = "tool-calls"
        if (turn === 24) reply.error = { name: "UnknownError", data: { message: "provider failed" } } as never
        yield* sessions.updateMessage(reply)
      }
      expect(
        (yield* sessions.messages({ sessionID: "ses_parent" as never, limit: 20 })).every(
          (item) => item.info.role === "assistant",
        ),
      ).toBe(true)
      expect(yield* deliver()).toBe(false)
      expect(yield* database.db.select().from(PartTable)).toHaveLength(0)
      const answer = parentAnswer("msg_real_answer", "msg_pending")
      answer.time = { created: 90, completed: 90 }
      yield* sessions.updateMessage(answer)
      expect(yield* deliver()).toBe(true)
    }),
  ))

it("does not copy a completion superseded by a reopen or a newer graph revision", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      yield* database.db
        .update(WorkflowTable)
        .set({ status: "running", seq: 8, graph_rev: 3 })
        .where(eq(WorkflowTable.id, "wf-1"))
        .run()
      expect(yield* deliver()).toBe(false)
      expect(yield* database.db.select().from(MessageTable)).toHaveLength(0)
    }),
  ))

it("rejects a mismatched durable receipt instead of acknowledging lost content", () =>
  fixture(({ database, store, workflow, deliver }) =>
    Effect.gen(function* () {
      yield* deliver()
      const id = reportIdentity(workflow).answerID
      const part = (yield* database.db.select().from(PartTable).where(eq(PartTable.id, id)))[0]
      yield* database.db
        .update(PartTable)
        .set({ data: { ...part.data, text: "tampered" } as never })
        .where(eq(PartTable.id, id))
        .run()
      yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
      expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* store.getWorkflow("wf-1"))?.wakeReported).toBe(false)
    }),
  ))

it("uses explicit delivery selection and never guesses from required nodes or old attempts", () => {
  const nodes = [
    makeNodeRow({ id: "required", required: true, status: "completed" }),
    makeNodeRow({ id: "final", status: "completed", superseded: true }),
  ]
  expect(selectReportNode({ name: "ambiguous", nodes: [] }, nodes)).toBeUndefined()
  expect(selectReportNode({ name: "old", nodes: [], delivery_node: "final" }, nodes)).toBeUndefined()
  expect(reportIdentity(makeWorkflowRow({ seq: 2 }))).not.toEqual(reportIdentity(makeWorkflowRow({ seq: 3 })))
})

it("persists the unique leaf synthesis selection and preserves the legacy protocol default", async () => {
  const authoring = WorkflowAuthoring.make()
  const result = await Effect.runPromise(
    authoring.prepare({
      action: "start",
      profile: "portable",
      source: {
        kind: "inline",
        value: {
          config: {
            name: "synthesis",
            objective: "Produce the final report",
            blocks: [{ id: "final", kind: "synthesize" }],
          },
        },
      },
    }),
  )
  expect(result.valid).toBe(true)
  expect(result.prepared?.action === "start" && result.prepared.config.delivery_node).toBe("final")
  const ambiguous = await Effect.runPromise(
    authoring.prepare({
      action: "start",
      profile: "portable",
      source: {
        kind: "inline",
        value: {
          config: {
            name: "ambiguous",
            objective: "Produce reports",
            blocks: [
              { id: "a", kind: "synthesize" },
              { id: "b", kind: "synthesize" },
            ],
          },
        },
      },
    }),
  )
  expect(ambiguous.prepared?.action === "start" && ambiguous.prepared.config.delivery_node).toBeUndefined()
  const invalid = await Effect.runPromise(
    authoring.prepare({
      action: "start",
      profile: "portable",
      source: {
        kind: "inline",
        value: {
          config: {
            name: "invalid",
            delivery_node: "missing",
            nodes: [{ id: "a", name: "A", worker_type: "general", depends_on: [], prompt_template: { inline: "A" } }],
          },
        },
      },
    }),
  )
  expect(invalid.valid).toBe(false)
  expect(resultProtocol(parseWorkflowConfig(JSON.stringify({ name: "legacy", nodes: [] })))).toBe("submit_result")
  expect(parseWorkflowConfig(JSON.stringify({ name: "bad", nodes: [], result_protocol: "unknown" }))).toBeUndefined()
})

it("preserves an unprocessed user request while idle and delivers after it has an answer", () =>
  fixture(({ database, sessions, deliver }) =>
    Effect.gen(function* () {
      yield* sessions.updateMessage({
        id: "msg_pending" as never,
        sessionID: "ses_parent" as never,
        role: "user",
        time: { created: 50 },
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
      })
      expect(yield* deliver()).toBe(false)
      expect(
        (yield* database.db.select().from(MessageTable)).filter((row) => row.data.role === "assistant"),
      ).toHaveLength(0)
      yield* sessions.updateMessage({
        id: "msg_answered" as never,
        sessionID: "ses_parent" as never,
        parentID: "msg_pending" as never,
        role: "assistant",
        time: { created: 60, completed: 60 },
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        providerID: "test" as never,
        modelID: "test" as never,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      })
      expect(yield* deliver()).toBe(true)
    }),
  ))

it("stores an oversized answer as a verified artifact with bounded parent text", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      const text = "large report\n".repeat(6000)
      yield* database.db
        .update(WorkflowNodeTable)
        .set({ output: text })
        .where(eq(WorkflowNodeTable.workflow_id, "wf-1"))
        .run()
      expect(yield* deliver()).toBe(true)
      const receipt = (yield* database.db.select().from(PartTable))
        .map((row) => row.data as SessionV1.TextPart)
        .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
      expect(receipt.text.length).toBeLessThan(2000)
      const artifact = receipt.metadata!.dag_delivery.artifact
      yield* verifyOutputFileRef(artifact)
      expect(yield* Effect.promise(() => readFile(artifact.path, "utf8"))).toBe(text)
    }),
  ))

it("writes no filesystem artifact for oversized output while a user request is pending, then delivers it after an answer", () =>
  fixture(({ database, sessions, deliver }) =>
    Effect.gen(function* () {
      const text = `${randomUUID()} unique oversized report\n${"large report\n".repeat(6000)}`
      const digest = Hash.sha256(Buffer.from(text))
      yield* database.db
        .update(WorkflowNodeTable)
        .set({ output: text })
        .where(eq(WorkflowNodeTable.workflow_id, "wf-1"))
        .run()
      yield* sessions.updateMessage({
        id: "msg_pending" as never,
        sessionID: "ses_parent" as never,
        role: "user",
        time: { created: 50 },
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
      })
      const deliveryDirectory = path.join(Global.Path.data, "workflow-artifacts", "delivery")
      const objectDirectory = path.join(Global.Path.data, "workflow-artifacts", "objects", digest.slice(0, 2), digest)
      const listDelivery = Effect.promise(() =>
        readdir(deliveryDirectory).then(
          () => true,
          () => false,
        ),
      )
      const objectExists = Effect.promise(() =>
        readdir(objectDirectory).then(
          () => true,
          () => false,
        ),
      )
      const before = yield* listDelivery
      expect(yield* deliver()).toBe(false)
      expect(yield* listDelivery).toBe(before)
      expect(yield* objectExists).toBe(false)
      const answer = parentAnswer("msg_real_answer", "msg_pending")
      answer.time = { created: 70, completed: 70 }
      yield* sessions.updateMessage(answer)
      expect(yield* deliver()).toBe(true)
      const receipt = (yield* database.db.select().from(PartTable))
        .map((row) => row.data as SessionV1.TextPart)
        .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
      expect(receipt.text.length).toBeLessThan(2000)
      const artifact = receipt.metadata!.dag_delivery.artifact
      yield* verifyOutputFileRef(artifact)
      expect(yield* Effect.promise(() => readFile(artifact.path, "utf8"))).toBe(text)
      yield* Effect.promise(() => rm(path.dirname(artifact.path), { recursive: true, force: true }))
    }),
  ))

it("writes no filesystem artifact for oversized output behind a stale completion episode", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      const text = `${randomUUID()} unique stale report\n${"large report\n".repeat(6000)}`
      const digest = Hash.sha256(Buffer.from(text))
      yield* database.db
        .update(WorkflowNodeTable)
        .set({ output: text })
        .where(eq(WorkflowNodeTable.workflow_id, "wf-1"))
        .run()
      yield* database.db
        .update(WorkflowTable)
        .set({ status: "running", seq: 8, graph_rev: 3 })
        .where(eq(WorkflowTable.id, "wf-1"))
        .run()
      const objectDirectory = path.join(Global.Path.data, "workflow-artifacts", "objects", digest.slice(0, 2), digest)
      expect(yield* deliver()).toBe(false)
      expect(
        yield* Effect.promise(() =>
          readdir(objectDirectory).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  ))

it("uses the captured file receipt and refuses to acknowledge a missing managed object", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "dag-delivery-file-")))
      yield* Effect.gen(function* () {
        const source = path.join(directory, "report.txt")
        yield* Effect.promise(() => writeFile(source, `file report ${directory}`))
        const artifact = (yield* commitOutputFileRef(source, {
          workflow_id: "wf-1",
          node_id: "final",
          child_session_id: "ses_child",
          replan_attempt: 0,
          graph_rev: 2,
        }))!
        yield* database.db
          .update(WorkflowNodeTable)
          .set({ output: artifact.path, captured_output: artifact, captured_output_present: true })
          .where(eq(WorkflowNodeTable.workflow_id, "wf-1"))
          .run()
        yield* deliver()
        const receipt = (yield* database.db.select().from(PartTable))
          .map((row) => row.data as SessionV1.TextPart)
          .find((part) => part.metadata?.dag_delivery?.kind === "answer")!
        expect(receipt.text).toContain("[Complete report]")
        expect(receipt.metadata?.dag_delivery.artifact.sha256).toBe(artifact.sha256)
        yield* Effect.promise(() => rm(artifact.path))
        yield* database.db.update(WorkflowTable).set({ wake_reported: false }).where(eq(WorkflowTable.id, "wf-1")).run()
        expect((yield* deliver().pipe(Effect.exit))._tag).toBe("Failure")
      }).pipe(Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))))
    }),
  ))

it("keeps the fallback synthetic anchor before its assistant using canonical ordering", () =>
  fixture(({ database, deliver }) =>
    Effect.gen(function* () {
      yield* deliver()
      const messages = yield* database.db.select().from(MessageTable)
      const user = messages.find((row) => row.data.role === "user")!
      const answer = messages.find((row) => row.data.role === "assistant")!
      expect(before({ id: user.id, time: user.data.time }, { id: answer.id, time: answer.data.time })).toBe(true)
      const zero = reportIdentity(makeWorkflowRow({ completedAt: 0, timeUpdated: 0 }))
      expect(before({ id: zero.anchorID, time: { created: 0 } }, { id: zero.messageID, time: { created: 0 } })).toBe(
        true,
      )
    }),
  ))

it("does not consume a same-millisecond user that sorts after the previous assistant", () =>
  fixture(({ sessions, deliver }) =>
    Effect.gen(function* () {
      yield* sessions.updateMessage({
        id: "msg_z_pending" as never,
        sessionID: "ses_parent" as never,
        role: "user",
        time: { created: 50 },
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
      })
      yield* sessions.updateMessage({
        id: "msg_a_previous" as never,
        sessionID: "ses_parent" as never,
        parentID: "msg_previous" as never,
        role: "assistant",
        time: { created: 50, completed: 50 },
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        providerID: "test" as never,
        modelID: "test" as never,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      })
      expect(yield* deliver()).toBe(false)
    }),
  ))
