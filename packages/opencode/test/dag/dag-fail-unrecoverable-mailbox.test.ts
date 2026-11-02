// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- durable row fixtures and branded IDs use `as never` shims.
/**
 * #948 blocker: a failUnrecoverable call whose in-lock revalidation finds the
 * workflow moved to a valid directory must be a no-op. It must not pass a
 * failure reason into the mailbox fence and close a live parent mailbox.
 */
import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { AgentMailboxTable, AgentMessageTable } from "@opencode-ai/core/dag/messages.sql"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Location } from "@opencode-ai/schema/location"
import { SessionEvent } from "@opencode-ai/schema/session-event"
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
  async function settle(outcome: "completed" | "failed") {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-mailbox-settle-")))
    const directory = path.join(root, "a")
    mkdirSync(directory, { recursive: true })
    try {
      await Effect.runPromise(
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
          yield* database.db
            .run(sql`UPDATE workflow_node SET status = ${outcome} WHERE workflow_id = ${dagID} AND id = 'n1'`)
            .pipe(Effect.orDie)
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

          const settled = yield* dag.settleCompletion(dagID)
          expect(settled.status).toBe(outcome)
          const mailbox = yield* database.db
            .select()
            .from(AgentMailboxTable)
            .where(eq(AgentMailboxTable.id, MAILBOX_ID))
            .get()
            .pipe(Effect.orDie)
          expect(mailbox?.closed_reason).toBe(outcome)
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

  it("closes the parent mailbox as completed on natural completion", () => settle("completed"))
  it("closes the parent mailbox as failed on natural failure", () => settle("failed"))
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
