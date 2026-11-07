import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Goal } from "@/goal/goal"
import { Dag } from "@/dag/dag"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionAutomationLease } from "@/session/automation-lease"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer } from "../fixture/fixture"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    Goal.defaultLayer,
    Dag.defaultLayer,
    SessionAutomationLease.defaultLayer,
    DagMessages.defaultLayer,
    Database.defaultLayer,
    SessionProjector.defaultLayer,
    testInstanceStoreLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function seed() {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const parent = yield* sessions.create({ title: "Parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
    const workflowID = `dag-${parent.id}`
    yield* db.run(sql`INSERT INTO workflow (id,project_id,session_id,directory,title,status,config,seq,time_created,time_updated)
      VALUES (${workflowID},${parent.projectID},${parent.id},${parent.directory},'Closure','running','{}',1,1,1)`)
    yield* db.run(sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated)
      VALUES ('worker',${workflowID},'Worker','task','running','[]',${child.id},1,1,1)`)
    const identity = { projectID: parent.projectID, directory: parent.directory }
    return {
      parent,
      child,
      workflowID,
      parentCaller: { ...identity, sessionID: parent.id },
      childCaller: { ...identity, sessionID: child.id },
    }
  }).pipe(Effect.orDie)
}

const value = <A>(result: DagMessages.Result<A>): A => {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

describe("Session.remove and durable agent mailbox closure (#697)", () => {
  it.instance("preserves an accepted child report when its source session is deleted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const mailbox = yield* DagMessages.Service
      const { parentCaller, childCaller, child, workflowID } = yield* seed()
      const accepted = value(
        yield* mailbox.send(childCaller, { workflowID, idempotencyKey: "report", content: "accepted report" }),
      )
      yield* sessions.remove(child.id)
      expect(value(yield* mailbox.receive(parentCaller))).toMatchObject([
        { id: accepted.id, state: "queued", content: "accepted report" },
      ])
      const { db } = yield* Database.Service
      expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${child.id}`)).toBeUndefined()
      expect(yield* db.get(sql`SELECT closed_reason FROM agent_mailbox WHERE session_id = ${child.id}`)).toEqual({
        closed_reason: "session_deleted",
      })
    }),
  )

  it.instance(
    "closes the parent and descendants before deletion so queued messages become explicitly undeliverable",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const mailbox = yield* DagMessages.Service
        const { parent, child, workflowID, parentCaller, childCaller } = yield* seed()
        const report = value(
          yield* mailbox.send(childCaller, { workflowID, idempotencyKey: "report", content: "report" }),
        )
        const instruction = value(
          yield* mailbox.send(parentCaller, {
            workflowID,
            nodeID: "worker",
            attemptID: DagMessages.nodeAttemptID(child.id, 0),
            idempotencyKey: "instruction",
            content: "instruction",
          }),
        )
        yield* sessions.remove(parent.id)
        const { db } = yield* Database.Service
        for (const id of [report.id, instruction.id]) {
          expect(yield* db.get(sql`SELECT state,reason FROM agent_message WHERE id = ${id}`)).toEqual({
            state: "undeliverable",
            reason: "session_deleted",
          })
        }
        expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${parent.id} OR id = ${child.id}`)).toBeUndefined()
        expect(yield* mailbox.send(childCaller, { workflowID, idempotencyKey: "late", content: "late" })).toMatchObject(
          { ok: false },
        )
      }),
  )
})

const faultedMailbox = Layer.effect(
  DagMessages.Service,
  Effect.gen(function* () {
    const real = yield* DagMessages.Service
    return DagMessages.Service.of({
      ...real,
      closeSession: (sessionID, reason) =>
        real
          .closeSession(sessionID, reason)
          .pipe(Effect.andThen(Effect.die(new Error("injected deletion boundary failure")))),
    })
  }),
).pipe(Layer.provide(DagMessages.defaultLayer))
const faultedIt = testEffect(
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          BackgroundJob.defaultLayer,
          RuntimeFlags.defaultLayer,
          Database.defaultLayer,
          EventV2Bridge.defaultLayer,
          Goal.defaultLayer,
          SessionAutomationLease.defaultLayer,
          Dag.defaultLayer,
          faultedMailbox,
        ),
      ),
    ),
    Database.defaultLayer,
    DagMessages.defaultLayer,
    SessionProjector.defaultLayer,
    testInstanceStoreLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

faultedIt.instance("rolls mailbox closure back when the deletion transaction fails after closing it", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const mailbox = yield* DagMessages.Service
    const info = yield* sessions.create({ title: "Deletion rollback" })
    const caller = { projectID: info.projectID, directory: info.directory, sessionID: info.id }
    value(yield* mailbox.freeze(caller, "before-deletion"))
    yield* sessions.remove(info.id).pipe(Effect.exit)
    const { db } = yield* Database.Service
    expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${info.id}`)).toEqual({ id: info.id })
    expect(yield* db.get(sql`SELECT closed_reason FROM agent_mailbox WHERE session_id = ${info.id}`)).toEqual({
      closed_reason: null,
    })
    expect(value(yield* mailbox.freeze(caller, "after-rollback"))).toMatchObject({ associated: false, messages: [] })
  }),
)
