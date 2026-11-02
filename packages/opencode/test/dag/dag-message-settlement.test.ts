import { describe, expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scheduler, Scope } from "effect"
import type { Database as NativeDatabase } from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { layer as sqliteLayer } from "@opencode-ai/core/database/sqlite.bun"
import { Sqlite } from "@opencode-ai/core/database/sqlite"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Dag } from "@/dag/dag"
import { SubmitResultTool } from "@/tool/submit_result"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectV2 } from "@opencode-ai/core/project"
import { registerCaptureSlot, setCaptureSnapshot, clearCaptureSlot, hasCaptureSlot } from "@/dag/runtime/capture"
import type { Tool } from "@/tool/tool"
import { reconcileWorkflow, continueRecoveredMessageNode, makeSessionStatusChecker } from "@/dag/runtime/recovery"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { MessageID, SessionID, PartID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const parent = { projectID: "p", directory: process.cwd(), sessionID: "ses_parent" }
const child = { ...parent, sessionID: "ses_child" }
const attempt = { replanAttempts: 0, childSessionID: child.sessionID }
function services() {
  const sqlite = sqliteLayer({ filename: ":memory:" })
  const database = Database.layer.pipe(Layer.provide(sqlite))
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const messages = DagMessages.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const dependencies = Layer.mergeAll(database, events, bridge, store, messages, projector)
  return Layer.mergeAll(sqlite, dependencies, Dag.layer.pipe(Layer.provide(dependencies)))
}
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Database.Service | DagMessages.Service | Dag.Service | DagStore.Service | Sqlite.Native | Scope.Scope
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(services()), Effect.scoped))
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(
    sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
  )
  for (const s of [parent, child])
    yield* db.run(
      sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${s.sessionID},'p',${s.sessionID === child.sessionID ? parent.sessionID : null},${s.sessionID},${process.cwd()},'S','test',1,1)`,
    )
  yield* db.run(
    sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated) VALUES ('dag_messages','p',${parent.sessionID},${process.cwd()},'W','running','{}',0,1,1)`,
  )
  yield* db.run(
    sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated) VALUES ('n','dag_messages','N','build','running','[]',${child.sessionID},0,1,1)`,
  )
}).pipe(Effect.orDie)
const value = <A>(result: DagMessages.Result<A>): A => {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}
function accept(key: string) {
  return Effect.flatMap(DagMessages.Service, (m) =>
    m.send(parent, {
      workflowID: "dag_messages",
      nodeID: "n",
      attemptID: DagMessages.nodeAttemptID(child.sessionID, 0),
      idempotencyKey: key,
      content: key,
    }),
  )
}
function associate(turn: string) {
  return Effect.gen(function* () {
    const messages = yield* DagMessages.Service
    const { db } = yield* Database.Service
    const snapshot = value(yield* messages.freeze(child, turn))
    for (const m of snapshot.messages) {
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${m.transcriptID},${child.sessionID},1,1,'{}') ON CONFLICT(id) DO NOTHING`,
      )
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${m.partID},${m.transcriptID},${child.sessionID},1,1,${JSON.stringify({ type: "text", text: DagMessages.renderMessage(m) })}) ON CONFLICT(id) DO NOTHING`,
      )
    }
    value(yield* messages.associate(child, snapshot.id))
    return snapshot
  }).pipe(Effect.orDie)
}
function reply(id: string, text: string): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  const sessionID = SessionID.make(child.sessionID)
  return {
    info: {
      id: messageID,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID, type: "text", text }],
  }
}

describe("message settlement through durable DAG events", () => {
  test("recovery rejects missing json_schema result before semantic error persistence", async () => {
    const assistant = reply(MessageID.ascending(), "done")
    if (assistant.info.role !== "assistant") throw new Error("fixture role")
    const user: SessionV1.WithParts = {
      info: {
        id: assistant.info.parentID,
        sessionID: SessionID.make(child.sessionID),
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
        format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: { type: "null" } }),
      },
      parts: [],
    }
    const info: Session.Info = {
      id: SessionID.make(child.sessionID),
      slug: "s",
      projectID: ProjectV2.ID.make("p"),
      directory: process.cwd(),
      title: "S",
      version: "test",
      time: { created: NonNegativeInt.make(1), updated: NonNegativeInt.make(1) },
    }
    const session = Layer.mock(Session.Service, {
      get: () => Effect.succeed(info),
      messages: () => Effect.succeed([assistant]),
      findMessage: (_id, predicate) => Effect.succeed(predicate(user) ? Option.some(user) : Option.none()),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const checker = makeSessionStatusChecker(yield* Session.Service)
        expect(yield* checker(child.sessionID)).toBe("failed")
        if (assistant.info.role !== "assistant") throw new Error("fixture role")
        assistant.info.finish = "tool-calls"
        expect(yield* checker(child.sessionID)).toBe("active")
        assistant.info.finish = "stop"
        assistant.info.structured = null
        expect(yield* checker(child.sessionID)).toBe("completed")
        delete assistant.info.structured
        if (user.info.role !== "user") throw new Error("fixture role")
        delete user.info.format
        expect(yield* checker(child.sessionID)).toBe("completed")
      }).pipe(Effect.provide(session)),
    )
    const limits: (number | undefined)[] = []
    if (user.info.role !== "user") throw new Error("fixture role")
    user.info.format = new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: { type: "null" } })
    const legacy = Layer.mock(Session.Service, {
      get: () => Effect.succeed(info),
      messages: ({ limit }) =>
        Effect.sync(() => {
          limits.push(limit)
          return limit === 1 ? [assistant] : [user, assistant]
        }),
    })
    expect(
      await Effect.runPromise(
        Effect.flatMap(Session.Service, (sessions) => makeSessionStatusChecker(sessions)(child.sessionID)).pipe(
          Effect.provide(legacy),
        ),
      ),
    ).toBe("failed")
    expect(limits).toEqual([1, 20])
  })
  test("replan restart closes old queued attempt without retargeting it", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        const { db } = yield* Database.Service
        const config = { id: "n", name: "N", worker_type: "build", depends_on: [], prompt_template: { inline: "work" } }
        yield* db.run(
          sql`UPDATE workflow SET config = ${JSON.stringify({ name: "W", nodes: [config] })} WHERE id = 'dag_messages'`,
        )
        const accepted = value(yield* accept("old-attempt"))
        yield* dag.replan("dag_messages", { nodes: [{ ...config, restart: true }] })
        expect(
          yield* db.get(sql`SELECT state,reason,recipient_id FROM agent_message WHERE id = ${accepted.id}`),
        ).toEqual({ state: "undeliverable", reason: "attempt_replaced", recipient_id: accepted.recipient.id })
        expect((yield* dag.store.getNode("dag_messages", "n"))?.replanAttempts).toBe(1)
        expect(yield* accept("old-target-again")).toEqual({ ok: false, reason: "stale_attempt" })
      }),
    ))

  for (const kind of ["effect defect", "thrown preparation error"] as const)
    test(`recovery model ${kind} must terminalize its claimed attempt and pending input`, async () =>
      run(
        Effect.gen(function* () {
          yield* seed
          const dag = yield* Dag.Service
          const messages = yield* DagMessages.Service
          value(yield* accept("waiting-on-recovered-model"))
          let calls = 0
          const prompt = Layer.mock(SessionPrompt.Service, {
            loop: () =>
              Effect.suspend(() => {
                calls++
                const error = new Error("recovered provider preparation failed")
                return kind === "effect defect"
                  ? Effect.die(error)
                  : Effect.sync(() => {
                      throw error
                    })
              }),
          })
          yield* Effect.exit(
            continueRecoveredMessageNode("dag_messages", "n", {
              nodes: [{ id: "n", output_schema: { type: "object" } }],
            }).pipe(Effect.provide(prompt)),
          )
          const node = yield* dag.store.getNode("dag_messages", "n")
          const message = value(yield* messages.receive(child))[0]
          const captureRegistered = hasCaptureSlot(child.sessionID)
          clearCaptureSlot(child.sessionID)
          expect(calls).toBe(1)
          expect({ nodeStatus: node?.status, inputState: message.state, captureRegistered }).toEqual({
            nodeStatus: "failed",
            inputState: "undeliverable",
            captureRegistered: false,
          })
          expect(node).toMatchObject({ childSessionId: child.sessionID, replanAttempts: 0, errorClass: "exec_failed" })
          expect(node?.errorReason).toContain("recovered provider preparation failed")
          expect(message.reason).toBe("exec_failed")
        }),
      ))
  for (const ordering of ["accept-before-claim", "accept-after-spent-claim"] as const)
    test(`new input winning retry exhaustion continues recovered child: ${ordering}`, async () =>
      run(
        Effect.gen(function* () {
          yield* seed
          const dag = yield* Dag.Service
          const messages = yield* DagMessages.Service
          const database = yield* Database.Service
          const old = yield* associate("old-capture")
          yield* dag.store.setCapturedOutput(child.sessionID, { result: "old" }, old.id)
          value(yield* accept("already-consumed"))
          if (ordering === "accept-after-spent-claim") value(yield* messages.claimResultNudge(child, 1))
          let loops = 0,
            nudges = 0,
            injected = false
          const instrumented: DagMessages.Interface = {
            ...messages,
            claimResultNudge: (caller, revision) =>
              Effect.gen(function* () {
                if (injected) return yield* messages.claimResultNudge(caller, revision)
                injected = true
                if (ordering === "accept-before-claim") value(yield* accept("wins-before-claim"))
                const claim = yield* messages.claimResultNudge(caller, revision)
                if (ordering === "accept-after-spent-claim") value(yield* accept("wins-before-failure"))
                return claim
              }).pipe(Effect.provideService(DagMessages.Service, messages)),
          }
          const prompt = Layer.mock(SessionPrompt.Service, {
            loop: () =>
              Effect.gen(function* () {
                loops++
                const turn = MessageID.ascending()
                const snapshot = yield* associate(turn)
                if (loops > 1)
                  yield* dag.store.setCapturedOutput(child.sessionID, { result: "new input consumed" }, snapshot.id)
                return reply(turn, "result")
              }).pipe(
                Effect.provideService(DagMessages.Service, messages),
                Effect.provideService(Database.Service, database),
              ),
            prompt: () =>
              Effect.sync(() => {
                nudges++
                return reply(MessageID.ascending(), "unexpected nudge")
              }),
          })
          yield* continueRecoveredMessageNode("dag_messages", "n", {
            nodes: [{ id: "n", output_schema: { type: "object" } }],
          }).pipe(Effect.provide(prompt), Effect.provideService(DagMessages.Service, instrumented))
          expect({ loops, nudges }).toEqual({ loops: 2, nudges: 0 })
          expect(yield* dag.store.getNode("dag_messages", "n")).toMatchObject({
            status: "completed",
            childSessionId: child.sessionID,
            replanAttempts: 0,
          })
          expect(value(yield* messages.receive(child)).map((m) => m.state)).toEqual(["delivered", "delivered"])
          expect((yield* dag.store.getNode("dag_messages", "n"))?.capturedOutput).toEqual({
            result: "new input consumed",
          })
        }),
      ))
  test("interrupted resubmission stays bounded when the same attempt is recovered again", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        const old = yield* associate("old-capture")
        yield* dag.store.setCapturedOutput(child.sessionID, { result: "old" }, old.id)
        value(yield* accept("new-input"))
        const database = yield* Database.Service
        const current = MessageID.ascending()
        let loops = 0,
          nudges = 0
        const prompt = Layer.mock(SessionPrompt.Service, {
          loop: () =>
            Effect.gen(function* () {
              loops++
              yield* associate(current)
              return reply(current, "result still not submitted")
            }).pipe(
              Effect.provideService(DagMessages.Service, messages),
              Effect.provideService(Database.Service, database),
            ),
          prompt: () =>
            Effect.gen(function* () {
              nudges++
              return yield* Effect.interrupt
            }),
        })
        const helper = continueRecoveredMessageNode("dag_messages", "n", {
          nodes: [{ id: "n", output_schema: { type: "object" } }],
        }).pipe(Effect.provide(prompt))
        expect(Exit.isFailure(yield* Effect.exit(helper))).toBe(true)
        expect((yield* dag.store.getNode("dag_messages", "n"))?.status).toBe("running")
        expect(hasCaptureSlot(child.sessionID)).toBe(false)
        yield* helper
        expect({ loops, nudges }).toEqual({ loops: 2, nudges: 1 })
        expect(yield* dag.store.getNode("dag_messages", "n")).toMatchObject({
          status: "failed",
          childSessionId: child.sessionID,
          replanAttempts: 0,
          errorClass: "exec_failed",
        })
        expect((yield* dag.store.getNode("dag_messages", "n"))?.errorReason).toContain("resubmission already requested")
        expect(hasCaptureSlot(child.sessionID)).toBe(false)
      }),
    ))
  test("recovered artifact authorization failures settle the exact node instead of leaking ownership", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "report.txt")
    await writeFile(file, "report")
    await run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        const turn = MessageID.ascending()
        const database = yield* Database.Service
        const { db } = database
        const prompt = Layer.mock(SessionPrompt.Service, {
          loop: () =>
            associate(turn).pipe(
              Effect.provideService(DagMessages.Service, messages),
              Effect.provideService(Database.Service, database),
              Effect.as(reply(turn, file)),
            ),
        })
        yield* continueRecoveredMessageNode("dag_messages", "n", undefined, undefined, () =>
          Effect.fail(new Error("artifact authorization failed")),
        ).pipe(Effect.provide(prompt))
        expect(yield* dag.store.getNode("dag_messages", "n")).toMatchObject({
          status: "failed",
          childSessionId: child.sessionID,
          replanAttempts: 0,
          errorClass: "exec_failed",
        })
        expect((yield* dag.store.getNode("dag_messages", "n"))?.errorReason).toContain("artifact authorization failed")
        expect(
          (yield* db.get<{ count: number }>(
            sql`SELECT COUNT(*) AS count FROM workflow_node WHERE captured_output_present = 1`,
          ))?.count,
        ).toBe(0)
      }),
    )
  })
  test("late submit_result callbacks cannot borrow a newer model-step snapshot", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const store = yield* DagStore.Service
        const oldTurn = MessageID.ascending(),
          nextTurn = MessageID.ascending()
        yield* associate(oldTurn)
        value(yield* accept("new-step-input"))
        const next = yield* associate(nextTurn)
        registerCaptureSlot(child.sessionID, { type: "object" })
        setCaptureSnapshot(child.sessionID, next.id)
        try {
          const tool = yield* SubmitResultTool
          const definition = yield* tool.init()
          const context = (messageID: MessageID): Tool.Context => ({
            sessionID: SessionID.make(child.sessionID),
            messageID,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            ask: () => Effect.void,
            metadata: () => Effect.void,
          })
          const stale = yield* definition.execute({ payload: { result: "old" } }, context(oldTurn))
          expect(stale.metadata.captured).not.toBe(true)
          expect((yield* store.getNode("dag_messages", "n"))?.capturedOutputPresent).toBe(false)
          const missing = yield* definition.execute({ payload: { result: "missing" } }, context(MessageID.ascending()))
          expect(missing.title).toBe("submit_result input unavailable")
          const fresh = yield* definition.execute({ payload: { result: "new" } }, context(nextTurn))
          expect(fresh.metadata.captured).toBe(true)
          expect((yield* store.getNode("dag_messages", "n"))?.capturedSnapshotID).toBe(next.id)
        } finally {
          clearCaptureSlot(child.sessionID)
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Agent.Service, {
              get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} }),
            }),
            Layer.mock(Truncate.Service, {
              output: (content: string) => Effect.succeed({ content, truncated: false }),
            }),
          ),
        ),
        Effect.provideService(InstanceRef, {
          directory: process.cwd(),
          worktree: process.cwd(),
          project: {
            id: ProjectV2.ID.make("p"),
            worktree: process.cwd(),
            sandboxes: [],
            time: { created: 1, updated: 1 },
          },
        }),
      ),
    ))
  test("submit_result fences slot replacement after validation before durable capture", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const store = yield* DagStore.Service
        const turn = MessageID.ascending()
        yield* associate(turn)
        const schema = { type: "object" }
        registerCaptureSlot(child.sessionID, schema)
        try {
          const tool = yield* SubmitResultTool
          const definition = yield* tool.init()
          const context: Tool.Context = {
            sessionID: SessionID.make(child.sessionID),
            messageID: turn,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            ask: () => Effect.void,
            metadata: () => Effect.void,
          }
          const result = yield* definition.execute({ payload: {} }, context).pipe(
            Effect.provideService(DagMessages.Service, {
              ...messages,
              revisions: (caller) =>
                messages.revisions(caller).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      clearCaptureSlot(child.sessionID)
                      registerCaptureSlot(child.sessionID, schema)
                    }),
                  ),
                ),
            }),
          )
          expect(result.metadata.captured).not.toBe(true)
          expect((yield* store.getNode("dag_messages", "n"))?.capturedOutputPresent).toBe(false)
        } finally {
          clearCaptureSlot(child.sessionID)
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Agent.Service, {
              get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} }),
            }),
            Layer.mock(Truncate.Service, {
              output: (content: string) => Effect.succeed({ content, truncated: false }),
            }),
          ),
        ),
        Effect.provideService(InstanceRef, {
          directory: process.cwd(),
          worktree: process.cwd(),
          project: {
            id: ProjectV2.ID.make("p"),
            worktree: process.cwd(),
            sandboxes: [],
            time: { created: 1, updated: 1 },
          },
        }),
      ),
    ))
  for (const boundary of ["scheduler", "connection-wait", "connection-abort"] as const)
    test(`submit_result preserves slot authority across ${boundary}`, async () =>
      run(
        Effect.gen(function* () {
          yield* seed
          const database = yield* Database.Service
          const store = yield* DagStore.Service
          const native = (yield* Sqlite.Native) as NativeDatabase
          const turn = MessageID.ascending()
          yield* associate(turn)
          const schema = { type: "object" }
          registerCaptureSlot(child.sessionID, schema)
          const order: string[] = []
          const query = native.query.bind(native)
          native.query = ((text: string) => {
            if (/update/i.test(text) && text.includes("captured_output")) order.push("write")
            return query(text)
          }) as typeof native.query
          const replace = () => {
            clearCaptureSlot(child.sessionID)
            registerCaptureSlot(child.sessionID, schema)
            order.push("replace")
          }
          try {
            const tool = yield* SubmitResultTool
            const definition = yield* tool.init()
            const abort = new AbortController()
            const context: Tool.Context = {
              sessionID: SessionID.make(child.sessionID),
              messageID: turn,
              agent: "build",
              abort: abort.signal,
              messages: [],
              ask: () => Effect.void,
              metadata: () => Effect.void,
            }
            const execute = definition.execute({ payload: { result: "old" } }, context)
            if (boundary === "scheduler") {
              const observed = {
                ...store,
                setCapturedOutput: (...args: Parameters<DagStore.Interface["setCapturedOutput"]>) => {
                  queueMicrotask(replace)
                  return store.setCapturedOutput(...args)
                },
              }
              const result = yield* execute.pipe(
                Effect.provideService(DagStore.Service, observed),
                Effect.provideService(Scheduler.MaxOpsBeforeYield, 20),
              )
              yield* Effect.promise(() => Promise.resolve())
              // A successful capture must linearize before the replacement.
              expect(result.metadata.captured).toBe(true)
              expect(order).toEqual(["write", "replace"])
              expect((yield* store.getNode("dag_messages", "n"))?.capturedOutput).toEqual({ result: "old" })
            } else {
              const held = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
              const holder = yield* database.db
                .transaction(() => Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
                .pipe(Effect.forkChild)
              yield* Deferred.await(held)
              const requested = Promise.withResolvers<void>()
              const observed: Database.Interface = {
                db: new Proxy(database.db, {
                  get(target, key, receiver) {
                    if (key === "transaction")
                      return (...args: Parameters<typeof database.db.transaction>) => {
                        requested.resolve()
                        return database.db.transaction(...args)
                      }
                    return Reflect.get(target, key, receiver)
                  },
                }),
              }
              const pending = yield* execute.pipe(
                Effect.updateContext((context: Context.Context<never>) => Context.omit(DagMessages.Service)(context)),
                Effect.provideService(Database.Service, observed),
                Effect.forkChild,
              )
              yield* Effect.promise(() => requested.promise).pipe(Effect.timeout("2 seconds"))
              if (boundary === "connection-abort") {
                abort.abort()
                order.push("abort")
              } else replace()
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(holder)
              const result = yield* Fiber.join(pending)
              expect(result.metadata.captured).not.toBe(true)
              expect(order).toEqual([boundary === "connection-abort" ? "abort" : "replace"])
              expect((yield* store.getNode("dag_messages", "n"))?.capturedOutputPresent).toBe(false)
              registerCaptureSlot(child.sessionID, { type: "null" })
              const fresh = yield* definition.execute(
                { payload: null },
                { ...context, abort: new AbortController().signal },
              )
              expect(fresh.metadata.captured).toBe(true)
              const current = yield* store.getNode("dag_messages", "n")
              expect(current?.capturedOutputPresent).toBe(true)
              expect(current?.capturedOutput).toBeNull()
            }
          } finally {
            native.query = query as typeof native.query
            clearCaptureSlot(child.sessionID)
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Agent.Service, {
                get: () => Effect.succeed({ name: "build", mode: "all", permission: [], options: {} }),
              }),
              Layer.mock(Truncate.Service, {
                output: (content: string) => Effect.succeed({ content, truncated: false }),
              }),
            ),
          ),
          Effect.provideService(InstanceRef, {
            directory: process.cwd(),
            worktree: process.cwd(),
            project: {
              id: ProjectV2.ID.make("p"),
              worktree: process.cwd(),
              sandboxes: [],
              time: { created: 1, updated: 1 },
            },
          }),
        ),
      ))
  for (const action of ["cancel", "complete", "fail"] as const)
    test(`workflow ${action} atomically rejects child input and preserves accepted parent reports`, async () =>
      run(
        Effect.gen(function* () {
          yield* seed
          const dag = yield* Dag.Service
          const messages = yield* DagMessages.Service
          value(yield* accept("queued-child"))
          value(
            yield* messages.send(child, { workflowID: "dag_messages", idempotencyKey: "report", content: "finding" }),
          )
          // This suite exercises terminal message disposition, not the
          // completion gate; keep the running fixture optional so explicit
          // completion remains legal while the child still holds input.
          if (action === "complete") {
            const { db } = yield* Database.Service
            yield* db.run(sql`UPDATE workflow_node SET required = 0 WHERE workflow_id = 'dag_messages' AND id = 'n'`)
          }
          if (action === "fail") yield* dag.fail("dag_messages", "workflow stopped")
          else yield* dag[action]("dag_messages")
          expect(value(yield* messages.receive(child))[0].state).toBe("undeliverable")
          expect(value(yield* messages.receive(parent))[0]).toMatchObject({ state: "queued", content: "finding" })
          expect(yield* accept("after-terminal")).toEqual({ ok: false, reason: "closed" })
        }),
      ))
  test("node cancellation atomically records explicit queued-input outcome", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        value(yield* accept("queued-cancel"))
        yield* dag.nodeCancelled("dag_messages", "n")
        const { db } = yield* Database.Service
        expect(
          yield* db.get(sql`SELECT state,reason FROM agent_message WHERE recipient_session_id = ${child.sessionID}`),
        ).toEqual({ state: "undeliverable", reason: "cancelled" })
        expect((yield* dag.store.getNode("dag_messages", "n"))!.status).toBe("failed")
      }),
    ))
  test("acceptance fences old completion and new associated input commits event+closure atomically", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const messages = yield* DagMessages.Service
        const old = yield* associate("old")
        value(yield* accept("late"))
        const rejected = yield* Effect.exit(
          dag.nodeCompleted("dag_messages", "n", "old", { ...attempt, inputSnapshotID: old.id }),
        )
        expect(Exit.isFailure(rejected)).toBe(true)
        expect((yield* store.getNode("dag_messages", "n"))!.status).toBe("running")
        const next = yield* associate("next")
        yield* dag.nodeCompleted("dag_messages", "n", null, { ...attempt, inputSnapshotID: next.id })
        expect((yield* store.getNode("dag_messages", "n"))!.status).toBe("completed")
        expect((yield* store.getNode("dag_messages", "n"))!.output).toBeNull()
        expect(value(yield* messages.revisions(child))).toMatchObject({ delivered: 1, closedReason: "completed" })
        expect(yield* accept("after-close")).toEqual({ ok: false, reason: "closed" })
      }),
    ))

  test("permanent failure outranks pending input and records undeliverability in its event transaction", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        value(yield* accept("pending"))
        yield* dag.nodeFailed("dag_messages", "n", "deadline exhausted", "timeout", attempt)
        expect(value(yield* messages.receive(child))[0]).toMatchObject({ state: "undeliverable", reason: "timeout" })
        expect((yield* dag.store.getNode("dag_messages", "n"))!.status).toBe("failed")
      }),
    ))

  test("recovery retains the exact child attempt and consumes queued input before completion", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const dag = yield* Dag.Service
        value(yield* accept("recovered-input"))
        const disposition = yield* reconcileWorkflow(
          "dag_messages",
          () => Effect.succeed("completed"),
          undefined,
          { nodes: [{ id: "n" }] },
          () => Effect.succeed("old result"),
        )
        expect(disposition).toEqual({ reconciled: 0, ownershipLost: 0, continuations: ["n"] })
        let called = 0
        const database = yield* Database.Service
        const messages = yield* DagMessages.Service
        const prompt = Layer.mock(SessionPrompt.Service, {
          loop: () =>
            Effect.gen(function* () {
              called++
              const turn = MessageID.ascending()
              yield* associate(turn)
              return reply(turn, "updated result")
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.provideService(DagMessages.Service, messages),
            ),
        })
        yield* continueRecoveredMessageNode("dag_messages", "n", { nodes: [{ id: "n" }] }).pipe(Effect.provide(prompt))
        expect(called).toBe(1)
        expect((yield* dag.store.getNode("dag_messages", "n"))!).toMatchObject({
          status: "completed",
          childSessionId: child.sessionID,
          replanAttempts: 0,
          output: "updated result",
        })
      }),
    ))

  test("durable stopped snapshots prevent recovery from resetting a node budget", async () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const messages = yield* DagMessages.Service
        const dag = yield* Dag.Service
        const snapshot = yield* associate("budget-turn")
        yield* messages.markStopped(child, snapshot.id, "budget_exhausted")
        value(yield* accept("late"))
        let called = 0
        const prompt = Layer.mock(SessionPrompt.Service, {
          loop: () =>
            Effect.sync(() => {
              called++
              return reply("unused", "unused")
            }),
        })
        yield* continueRecoveredMessageNode("dag_messages", "n", { nodes: [{ id: "n" }] }).pipe(Effect.provide(prompt))
        expect(called).toBe(0)
        expect((yield* dag.store.getNode("dag_messages", "n"))!.status).toBe("failed")
        expect(value(yield* messages.receive(child))[0].state).toBe("undeliverable")
      }),
    ))
})
