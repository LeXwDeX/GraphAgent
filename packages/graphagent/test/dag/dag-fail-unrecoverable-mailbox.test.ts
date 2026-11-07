// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- durable row fixtures and branded IDs use `as never` shims.
/**
 * #948 blocker: a failUnrecoverable call whose in-lock revalidation finds the
 * workflow moved to a valid directory must be a no-op. It must not pass a
 * failure reason into the mailbox fence and close a live parent mailbox.
 */
import { describe, expect, it } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { SessionProjector } from "@graphagent/core/session/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { AgentMailboxTable, AgentMessageTable } from "@graphagent/core/dag/messages.sql"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Location } from "@graphagent/schema/location"
import { SessionEvent } from "@graphagent/schema/session-event"
import { Dag } from "@/dag/dag"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { and, eq, sql } from "drizzle-orm"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PROJECT_ID = "project-1"
const SESSION_ID = "ses_parent"
const MAILBOX_ID = "mailbox-1"
const MESSAGE_ID = "message-1"

function layers() {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessionProjector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const messages = DagMessages.layer.pipe(Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(messages))
  return Layer.mergeAll(database, events, bridge, store, projector, sessionProjector, messages, dag)
}

describe("#950 terminal settlement closes the parent mailbox", () => {
  async function settle(
    outcome: "completed" | "failed" | "ignored" | "stale",
    options?: { repeat?: boolean; concurrent?: boolean },
  ) {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-mailbox-settle-")))
    const directory = path.join(root, "a")
    mkdirSync(directory, { recursive: true })
    try {
      return await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const dag = yield* Dag.Service
          yield* database.db
            .insert(ProjectTable)
            .values({ id: PROJECT_ID as never, worktree: directory as never, sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(SessionTable)
            .values({
              id: SESSION_ID as never,
              project_id: PROJECT_ID as never,
              slug: "p",
              directory: directory as never,
              title: "P",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const dagID = yield* dag.create({
            projectID: PROJECT_ID,
            sessionID: SESSION_ID,
            title: "mailbox",
            config: {
              name: "mailbox",
              nodes: [
                {
                  id: "n1",
                  name: "n1",
                  worker_type: "build",
                  depends_on: [],
                  required: true,
                  prompt_template: { inline: "x" },
                },
              ],
            },
          })
          yield* dag.nodeQueued(dagID, "n1", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "n1", "ses_child", Date.now() + 60_000)
          // This fixture has a mailbox service but no child mailbox/snapshot;
          // set the terminal node state directly so the fence, not the guard,
          // is what the test observes.
          if (outcome === "completed" || outcome === "failed") {
            yield* database.db
              .run(sql`UPDATE workflow_node SET status = ${outcome} WHERE workflow_id = ${dagID} AND id = 'n1'`)
              .pipe(Effect.orDie)
          }
          yield* database.db
            .insert(AgentMailboxTable)
            .values({
              id: MAILBOX_ID,
              session_id: SESSION_ID,
              workflow_id: dagID,
              node_id: null,
              attempt_id: null,
              revision: 1,
              result_nudge_revision: -1,
              closed_reason: null,
              time_created: 1,
            })
            .run()
            .pipe(Effect.orDie)

          const current = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
          const settleOnce = () =>
            dag.settleCompletion(
              dagID,
              outcome === "stale" ? { expectedGraphRev: (current?.graphRev ?? 0) + 1 } : undefined,
            )
          const [settled, duplicate] = options?.concurrent
            ? yield* Effect.scoped(
                Effect.gen(function* () {
                  // Both callers wait on one barrier, then race the workflow lock.
                  const barrier = yield* Deferred.make<void>()
                  const run = Deferred.await(barrier).pipe(Effect.andThen(settleOnce()))
                  const first = yield* run.pipe(Effect.forkScoped)
                  const second = yield* run.pipe(Effect.forkScoped)
                  yield* Deferred.succeed(barrier, void 0)
                  return yield* Effect.all([Fiber.join(first), Fiber.join(second)])
                }),
              )
            : [
                yield* settleOnce(),
                options?.repeat ? yield* dag.settleCompletion(dagID) : undefined,
              ] as const
          const mailbox = yield* database.db
            .select()
            .from(AgentMailboxTable)
            .where(eq(AgentMailboxTable.id, MAILBOX_ID))
            .get()
            .pipe(Effect.orDie)
          const workflow = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
          return { settled, duplicate, mailbox, workflow }
        }).pipe(
          Effect.provide(layers()),
          Effect.provideService(InstanceRef, {
            directory,
            worktree: directory,
            project: { id: PROJECT_ID },
          } as never),
          Effect.scoped,
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it("closes the parent mailbox as completed on natural completion", async () => {
    const { settled, mailbox } = await settle("completed")
    expect(settled.status).toBe("completed")
    expect(mailbox?.closed_reason).toBe("completed")
  })
  it("closes the parent mailbox as failed on natural failure", async () => {
    const { settled, mailbox } = await settle("failed")
    expect(settled.status).toBe("failed")
    expect(mailbox?.closed_reason).toBe("failed")
  })
  it("keeps the parent mailbox open when settlement is ignored or stale", async () => {
    for (const outcome of ["ignored", "stale"] as const) {
      const { settled, mailbox } = await settle(outcome)
      expect(settled.status).toBe(outcome)
      expect(mailbox?.closed_reason).toBeNull()
    }
  })
  it("settles exactly once when completion runs twice", async () => {
    const { settled, duplicate, mailbox, workflow } = await settle("completed", { repeat: true })
    expect(settled.status).toBe("completed")
    expect(duplicate?.status).toBe("ignored")
    expect(mailbox?.closed_reason).toBe("completed")
    expect(workflow?.status).toBe("completed")
  })
  for (const outcome of ["completed", "failed"] as const) {
    it(`settles exactly once when concurrent ${outcome} settlement races`, async () => {
      const { settled, duplicate, mailbox, workflow } = await settle(outcome, { concurrent: true })
      expect([settled.status, duplicate?.status]).toContain(outcome)
      expect([settled.status, duplicate?.status]).toContain("ignored")
      expect(mailbox?.closed_reason).toBe(outcome)
      expect(workflow?.status).toBe(outcome)
    })
  }
})

describe("#948 failUnrecoverable mailbox safety", () => {
  it("keeps a live parent mailbox and queued messages open when a moved workflow is not failed", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-mailbox-move-")))
    const directoryA = path.join(root, "a")
    const directoryB = path.join(root, "b")
    mkdirSync(directoryA, { recursive: true })
    mkdirSync(directoryB, { recursive: true })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const bridge = yield* EventV2Bridge.Service
          const dag = yield* Dag.Service
          yield* database.db
            .insert(ProjectTable)
            .values({ id: PROJECT_ID as never, worktree: directoryA as never, sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(SessionTable)
            .values({
              id: SESSION_ID as never,
              project_id: PROJECT_ID as never,
              slug: "p",
              directory: directoryA as never,
              title: "P",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const dagID = yield* dag.create({
            projectID: PROJECT_ID,
            sessionID: SESSION_ID,
            title: "mailbox",
            config: {
              name: "mailbox",
              nodes: [
                {
                  id: "n1",
                  name: "n1",
                  worker_type: "build",
                  depends_on: [],
                  required: true,
                  prompt_template: { inline: "x" },
                },
              ],
            },
          })
          yield* database.db
            .insert(AgentMailboxTable)
            .values({
              id: MAILBOX_ID,
              session_id: SESSION_ID,
              workflow_id: dagID,
              node_id: null,
              attempt_id: null,
              revision: 1,
              result_nudge_revision: -1,
              closed_reason: null,
              time_created: 1,
            })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(AgentMessageTable)
            .values({
              id: MESSAGE_ID,
              workflow_id: dagID,
              sender_id: "parent",
              recipient_id: MAILBOX_ID,
              recipient_session_id: SESSION_ID,
              sender: {},
              recipient: {},
              idempotency_key: "message-key",
              request: "request",
              content: "queued work",
              recipient_sequence: 1,
              accepted_revision: 1,
              state: "queued",
              transcript_id: "transcript",
              part_id: "part",
              time_created: 1,
            })
            .run()
            .pipe(Effect.orDie)

          yield* bridge
            .publish(SessionEvent.Moved, {
              sessionID: SESSION_ID as never,
              location: Location.Ref.make({ directory: directoryB as never }),
              timestamp: yield* DateTime.now,
            })
            .pipe(Effect.orDie)
          expect((yield* dag.store.getWorkflow(dagID))?.directory).toBe(directoryB)

          expect(yield* dag.failUnrecoverable(dagID, "workspace_missing: stale")).toBe("ignored")
          expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")

          const mailbox = yield* database.db
            .select()
            .from(AgentMailboxTable)
            .where(eq(AgentMailboxTable.id, MAILBOX_ID))
            .get()
            .pipe(Effect.orDie)
          const message = yield* database.db
            .select()
            .from(AgentMessageTable)
            .where(and(eq(AgentMessageTable.id, MESSAGE_ID), eq(AgentMessageTable.recipient_id, MAILBOX_ID)))
            .get()
            .pipe(Effect.orDie)
          expect(mailbox?.closed_reason).toBeNull()
          expect(message?.state).toBe("queued")
        }).pipe(
          Effect.provide(layers()),
          Effect.provideService(InstanceRef, {
            directory: directoryA,
            worktree: directoryA,
            project: { id: PROJECT_ID },
          } as never),
          Effect.scoped,
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
