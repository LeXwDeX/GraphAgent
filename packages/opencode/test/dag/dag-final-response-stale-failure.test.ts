// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Narrow model service fixtures retain real DAG events and durable mailbox guards.
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { continueRecoveredMessageNode, reconcileWorkflow } from "@/dag/runtime/recovery"
import { spawnNode } from "@/dag/runtime/spawn"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const parent = { projectID: "p", directory: process.cwd(), sessionID: "ses_parent" }
const child = { ...parent, sessionID: "ses_child" }
const attempt = { replanAttempts: 0, childSessionID: child.sessionID }
const workflowID = "dag_final_failure"

function services() {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const messages = DagMessages.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const dependencies = Layer.mergeAll(database, events, bridge, store, messages, projector)
  return Layer.merge(dependencies, Dag.layer.pipe(Layer.provide(dependencies)))
}
const it = testEffect(services())
const value = <A>(result: DagMessages.Result<A>) => {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}
function seed(status: "pending" | "running" = "running") {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${parent.directory},'[]',1,1)`,
    )
    for (const s of [parent, child])
      yield* db.run(
        sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${s.sessionID},'p',${s === parent ? null : parent.sessionID},${s.sessionID},${parent.directory},'S','test',1,1)`,
      )
    const config = JSON.stringify({
      name: "freshness",
      result_protocol: "final_response",
      nodes: [
        {
          id: "n",
          name: "N",
          worker_type: "build",
          depends_on: [],
          prompt_template: { inline: "work" },
        },
      ],
    })
    yield* db.run(
      sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated) VALUES (${workflowID},'p',${parent.sessionID},${parent.directory},'W','running',${config},0,1,1)`,
    )
    yield* db.run(
      sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated) VALUES ('n',${workflowID},'N','build',${status},'[]',${status === "pending" ? null : child.sessionID},0,1,1)`,
    )
  }).pipe(Effect.orDie)
}
function accept(sender = parent, key = "new-input") {
  return Effect.gen(function* () {
    const messages = yield* DagMessages.Service
    return value(
      yield* messages.send(sender, {
        workflowID,
        nodeID: "n",
        attemptID: DagMessages.nodeAttemptID(child.sessionID, 0),
        idempotencyKey: key,
        content: key,
      }),
    )
  })
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
      sessionID,
      parentID: MessageID.ascending(),
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: parent.directory, root: parent.directory },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID, type: "text", text }],
  }
}

describe("final-response failure freshness", () => {
  for (const mode of ["spawn", "continue", "reconcile"] as const)
    it.live(`${mode} continues when parent input arrives during failed schema validation`, () =>
      Effect.gen(function* () {
        yield* seed(mode === "spawn" ? "pending" : "running")
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        const database = yield* Database.Service
        const oldTurn = MessageID.ascending()
        const entered = Promise.withResolvers<void>()
        // Worker.postMessage reads this getter when admitting schema validation.
        // The parent accepts input while that asynchronous worker is pending.
        const schema: Record<string, unknown> = {
          get type() {
            entered.resolve()
            return "boolean"
          },
        }
        const config = { result_protocol: "final_response" as const, nodes: [{ id: "n", output_schema: schema }] }
        let prompts = 0
        let loops = 0
        const modelTurn = (text: string) =>
          Effect.gen(function* () {
            const turn = MessageID.ascending()
            yield* associate(turn)
            return reply(turn, text)
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(DagMessages.Service, messages),
          )
        const prompt = Layer.mock(SessionPrompt.Service, {
          prompt: () => {
            prompts++
            return modelTurn('"invalid old answer"')
          },
          loop: () => {
            loops++
            return modelTurn(mode === "continue" && loops === 1 ? '"invalid old answer"' : "true")
          },
          cancel: () => Effect.void,
        })
        const injector = yield* Effect.forkChild(Effect.promise(() => entered.promise).pipe(Effect.andThen(accept())))
        if (mode === "spawn") {
          const agent = Layer.mock(Agent.Service, {
            get: () =>
              Effect.succeed({
                name: "build",
                mode: "all",
                permission: [],
                options: {},
                tools: {},
                hooks: {},
                model: { providerID: "test", modelID: "test" },
              } as never),
          })
          const sessions = Layer.mock(Session.Service, {
            get: () =>
              Effect.succeed({ id: SessionID.make(parent.sessionID), permission: [], agent: "build" } as never),
            create: () => Effect.succeed({ id: SessionID.make(child.sessionID) } as never),
          })
          const node = (yield* dag.store.getNode(workflowID, "n"))!
          const spawned = yield* spawnNode(Semaphore.makeUnsafe(1), {
            dagID: workflowID,
            nodeID: "n",
            node,
            parentSessionID: parent.sessionID,
            promptParts: [{ type: "text", text: "work" }],
            resultProtocol: "final_response",
            outputSchema: schema,
          }).pipe(Effect.provide(Layer.mergeAll(agent, sessions, prompt)))
          expect(Exit.isSuccess(yield* Fiber.await(spawned.fiber))).toBe(true)
          expect({ prompts, loops }).toEqual({ prompts: 1, loops: 1 })
        } else if (mode === "continue") {
          yield* continueRecoveredMessageNode(workflowID, "n", config).pipe(Effect.provide(prompt))
          expect({ prompts, loops }).toEqual({ prompts: 0, loops: 2 })
        } else {
          yield* associate(oldTurn)
          const result = yield* reconcileWorkflow(
            workflowID,
            (sessionID) => Effect.succeed(sessionID === child.sessionID ? "completed" : "active"),
            undefined,
            config,
            undefined,
            undefined,
            undefined,
            () => Effect.succeed(reply(oldTurn, '"invalid old answer"')),
          )
          expect(result).toMatchObject({ reconciled: 0, continuations: ["n"] })
          expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("running")
          expect(value(yield* messages.receive(child))[0].state).toBe("queued")
          yield* continueRecoveredMessageNode(workflowID, "n", config).pipe(Effect.provide(prompt))
          expect(loops).toBe(1)
        }
        yield* Fiber.join(injector)
        expect(yield* dag.store.getNode(workflowID, "n")).toMatchObject({
          status: "completed",
          output: true,
          childSessionId: child.sessionID,
          replanAttempts: 0,
        })
        expect(value(yield* messages.receive(child)).map((m) => m.state)).toEqual(["delivered"])
      }),
    )

  it.live("an invalid current response still fails its associated snapshot", () =>
    Effect.gen(function* () {
      yield* seed()
      const dag = yield* Dag.Service
      const messages = yield* DagMessages.Service
      yield* accept()
      const snapshot = yield* associate(MessageID.ascending())
      yield* dag.nodeFailed(workflowID, "n", "invalid response", "verdict_fail", {
        ...attempt,
        inputSnapshotID: snapshot.id,
      })
      expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("failed")
      expect(value(yield* messages.metadata(parent, workflowID, "n"))).toMatchObject({ closedReason: "verdict_fail" })
    }),
  )

  it.live("execution failures still close newer pending input without a response snapshot", () =>
    Effect.gen(function* () {
      yield* seed()
      const dag = yield* Dag.Service
      const messages = yield* DagMessages.Service
      yield* associate(MessageID.ascending())
      yield* accept()
      yield* dag.nodeFailed(workflowID, "n", "provider crashed", "exec_failed", attempt)
      expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("failed")
      expect(value(yield* messages.receive(child))[0]).toMatchObject({ state: "undeliverable", reason: "exec_failed" })
    }),
  )

  for (const snapshotState of ["unassociated", "missing"] as const)
    it.live(`a response failure rejects its ${snapshotState} original snapshot before closing the mailbox`, () =>
      Effect.gen(function* () {
        yield* seed()
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        const snapshotID =
          snapshotState === "unassociated"
            ? value(yield* messages.freeze(child, MessageID.ascending())).id
            : "snapshot-that-does-not-exist"
        const result = yield* dag
          .nodeFailed(workflowID, "n", "invalid response", "verdict_fail", {
            ...attempt,
            inputSnapshotID: snapshotID,
          })
          .pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(Dag.isStaleMessageInput(result.failure)).toBe(true)
        expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("running")
        expect(value(yield* messages.metadata(parent, workflowID, "n")).closedReason).toBeUndefined()
      }),
    )

  it.live("a forced execution failure ignores an old response snapshot when newer input exists", () =>
    Effect.gen(function* () {
      yield* seed()
      const dag = yield* Dag.Service
      const messages = yield* DagMessages.Service
      const snapshot = yield* associate(MessageID.ascending())
      yield* accept()
      yield* dag.nodeFailed(workflowID, "n", "provider crashed", "exec_failed", {
        ...attempt,
        inputSnapshotID: snapshot.id,
      })
      expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("failed")
      expect(value(yield* messages.receive(child))[0]).toMatchObject({ state: "undeliverable", reason: "exec_failed" })
    }),
  )

  it.live("a final-response failure without a known snapshot cannot discard accepted input", () =>
    Effect.gen(function* () {
      yield* seed()
      const dag = yield* Dag.Service
      const messages = yield* DagMessages.Service
      yield* accept()
      const result = yield* dag
        .nodeFailed(workflowID, "n", "final message unavailable", "verdict_fail", attempt)
        .pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(Dag.isStaleMessageInput(result.failure)).toBe(true)
      expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("running")
      expect(value(yield* messages.receive(child))[0].state).toBe("queued")
    }),
  )

  for (const arrival of ["before-check", "after-check", "none"] as const)
    it.live(`recovery without a response snapshot preserves input arriving ${arrival}`, () =>
      Effect.gen(function* () {
        yield* seed()
        const dag = yield* Dag.Service
        const messages = yield* DagMessages.Service
        let checks = 0
        const database = yield* Database.Service
        const observed = {
          ...messages,
          revisions: (caller: DagMessages.Caller) =>
            messages.revisions(caller).pipe(
              Effect.tap(() => {
                checks++
                return arrival === "after-check" && checks === 2
                  ? accept().pipe(Effect.provideService(DagMessages.Service, messages), Effect.asVoid)
                  : Effect.void
              }),
            ),
        }
        const config = { result_protocol: "final_response" as const, nodes: [{ id: "n" }] }
        const result = yield* reconcileWorkflow(
          workflowID,
          () => Effect.succeed("completed"),
          undefined,
          config,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.gen(function* () {
              if (arrival === "before-check") yield* accept()
              return reply(MessageID.ascending(), "unassociated old result")
            }).pipe(Effect.provideService(DagMessages.Service, messages)),
        ).pipe(Effect.provideService(DagMessages.Service, observed))
        if (arrival === "none") {
          expect(result).toMatchObject({ reconciled: 1 })
          expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("failed")
          expect(value(yield* messages.metadata(parent, workflowID, "n")).closedReason).toBe("exec_failed")
          return
        }
        expect(result).toMatchObject({ reconciled: 0, continuations: ["n"] })
        expect((yield* dag.store.getNode(workflowID, "n"))?.status).toBe("running")
        expect(value(yield* messages.receive(child))[0].state).toBe("queued")
        expect(value(yield* messages.metadata(parent, workflowID, "n")).closedReason).toBeUndefined()
        const prompt = Layer.mock(SessionPrompt.Service, {
          loop: () =>
            Effect.gen(function* () {
              const turn = MessageID.ascending()
              yield* associate(turn)
              return reply(turn, "fresh result")
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.provideService(DagMessages.Service, messages),
            ),
        })
        yield* continueRecoveredMessageNode(workflowID, "n", config).pipe(Effect.provide(prompt))
        expect(yield* dag.store.getNode(workflowID, "n")).toMatchObject({ status: "completed", output: "fresh result" })
        expect(value(yield* messages.receive(child))[0].state).toBe("delivered")
      }),
    )
})
