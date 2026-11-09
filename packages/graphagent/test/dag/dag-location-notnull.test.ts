// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * E1 D1: the workflow owner columns are required in the durable schema.
 * `workflow.directory` and `workflow.target_fingerprint` are NOT NULL, the
 * child-session lookup is indexed, and the mailbox change stream has its
 * version column. Legacy persisted WorkflowCreated events that omit the
 * fields still project: they become the empty directory / explicit non-git
 * fingerprint and stay fail-closed (no instance ever owns them).
 */
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = DagStore.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const dagLayer = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
const it = testEffect(Layer.mergeAll(database, events, projector, store, bridge, dagLayer))

const PROJECT_ID = Project.ID.global
const SESSION_ID = "ses_notnull_parent"
const DIRECTORY = "/project"

function node(id: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
  }
}

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: PROJECT_ID, worktree: AbsolutePath.make(DIRECTORY), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(SESSION_ID),
        project_id: PROJECT_ID,
        slug: "notnull",
        directory: AbsolutePath.make(DIRECTORY),
        title: "notnull",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("D1 workflow owner columns", () => {
  it.effect("the baseline declares the owner columns NOT NULL and adds the child-session index", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const columns = yield* db.all<{ name: string; notnull: number }>(sql`PRAGMA table_info(workflow)`)
      expect(columns.find((column) => column.name === "directory")).toMatchObject({ notnull: 1 })
      expect(columns.find((column) => column.name === "target_fingerprint")).toMatchObject({ notnull: 1 })

      const index = yield* db.get<{ sql: string | null }>(
        sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'workflow_node_child_session_idx'`,
      )
      expect(index?.sql).toContain("child_session_id")

      const mailbox = yield* db.all<{ name: string; notnull: number; dflt_value: string | null }>(
        sql`PRAGMA table_info(agent_mailbox)`,
      )
      expect(mailbox.find((column) => column.name === "change_seq")).toMatchObject({ notnull: 1, dflt_value: "0" })
    }),
  )

  it.effect("SQLite rejects a workflow row without the owner columns", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      const failure = yield* db
        .insert(WorkflowTable)
        .values({
          id: "dag_notnull_missing_owner",
          project_id: PROJECT_ID,
          session_id: SESSION_ID,
          title: "missing owner",
          status: "pending",
          config: "{}",
          seq: 1,
        } as never)
        .run()
        .pipe(Effect.exit)
      expect(failure._tag).toBe("Failure")
    }),
  )

  it.effect("create stamps the session directory and a target fingerprint", () =>
    Effect.gen(function* () {
      yield* setup()
      const dag = yield* Dag.Service
      const dagID = yield* dag.create({
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
        title: "stamped",
        config: { name: "stamped", nodes: [node("n1")] },
      })
      const workflow = yield* dag.store.getWorkflow(dagID)
      expect(workflow?.directory).toBe(DIRECTORY)
      expect(workflow?.targetFingerprint).toBeDefined()
    }),
  )

  it.effect("a legacy event without owner fields projects a row no instance owns", () =>
    Effect.gen(function* () {
      yield* setup()
      const events = yield* EventV2.Service
      const dagStore = yield* DagStore.Service
      const dagID = DagEvent.DagID.make("dag_notnull_legacy")
      yield* events.publish(DagEvent.WorkflowCreated, {
        dagID,
        projectID: PROJECT_ID as never,
        sessionID: SESSION_ID as never,
        title: "legacy",
        config: "{}",
        status: "pending",
        timestamp: DateTime.makeUnsafe(0),
      })

      const workflow = yield* dagStore.getWorkflow(dagID)
      expect(workflow?.directory).toBe("")
      expect(workflow?.targetFingerprint).toEqual({ kind: "none" })
      expect(DagLocation.resolveExecution(workflow!)).toEqual({
        _tag: "invalid",
        directory: "",
        reason: "workflow has no recorded execution directory",
      })

      yield* Effect.gen(function* () {
        expect(yield* DagLocation.ownsWorkflow(dagID, DIRECTORY)).toBe(false)
        expect(yield* DagLocation.ownsSession(SESSION_ID, DIRECTORY)).toBe(false)
      }).pipe(
        Effect.provideService(InstanceRef, {
          directory: DIRECTORY,
          worktree: DIRECTORY,
          project: { id: PROJECT_ID },
        } as never),
      )
    }),
  )
})
