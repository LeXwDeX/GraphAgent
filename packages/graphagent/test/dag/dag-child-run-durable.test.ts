// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- narrow session and agent fixtures

import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { ProviderV2 } from "@graphagent/core/provider"
import { AbsolutePath } from "@graphagent/core/schema"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { TerminalViolationError } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer, Scope } from "effect"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { AgentScheduler } from "@/session/agent-scheduler"
import { makeChildRuns } from "@/session/child/run"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

/**
 * Issue #1026, PR4: the DAG run's durable life over the real `ChildRuns`
 * factory and an in-memory database. The DAG tests elsewhere use a stub so
 * they can assert scheduling; this file is the one that proves the binding and
 * the `child_run` row are written, walked to `running`, and settled with the
 * node's outcome.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

const agentLayer = Layer.mock(Agent.Service, {
  get: () =>
    Effect.succeed({
      name: "build",
      mode: "all",
      permission: [],
      options: {},
      description: "",
      prompt: "",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      tools: {},
      hooks: {},
    }),
  list: () => Effect.succeed([]),
  defaultAgent: () => Effect.succeed("build"),
})

const sessionID = (label: string) => SessionID.make(`ses_durable_${label}_${crypto.randomUUID()}`)

const seedSession = (db: Database.Interface["db"], id: SessionID) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_durable"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.make("prj_durable"),
        slug: `durable-${id}`,
        directory: AbsolutePath.make("/tmp"),
        title: "durable",
        version: "0",
      })
      .run()
      .pipe(Effect.orDie)
  })

const runRows = (db: Database.Interface["db"], child: SessionID) =>
  db.select().from(ChildRunTable).where(eq(ChildRunTable.child_session_id, child)).all().pipe(Effect.orDie)
const bindingRows = (db: Database.Interface["db"], child: SessionID) =>
  db.select().from(ChildBindingTable).where(eq(ChildBindingTable.child_session_id, child)).all().pipe(Effect.orDie)

function reply(session: SessionID, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: session,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ type: "text", text }] as never,
  }
}

const spawnInput = (dagID: string, nodeID: string, parentSessionID: string): NodeSpawnInput => ({
  dagID,
  nodeID,
  node: makeNodeRow({ id: nodeID, workflowId: dagID, workerType: "build", status: "running" }),
  parentSessionID,
  promptParts: [{ type: "text", text: "do the thing" }] as never,
})

/**
 * One spawn over the real ChildRuns. The Session mock materializes the child
 * session row (the real Session service would), and the child-run driver
 * answers the prompt; the prompt service only exposes the same `children`.
 */
const runSpawn = (input: NodeSpawnInput, nodeStarted: () => Effect.Effect<void, Error> = () => Effect.void) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const parent = SessionID.make(input.parentSessionID)
    yield* seedSession(db, parent)
    const created: SessionID[] = []
    const cancelled: Array<{ sessionID: string; reason?: string; actor?: string }> = []
    const children = yield* makeChildRuns({
      db,
      scope,
      cancelSession: (childSessionID, options) =>
        Effect.sync(() => {
          cancelled.push({
            sessionID: childSessionID,
            reason: options?.reason?.reason,
            actor: options?.reason?.actor,
          })
        }),
      driver: {
        prompt: (prompt) => Effect.succeed(reply(prompt.sessionID, "done")),
        resolvePromptParts: () => Effect.succeed([]),
      },
    })
    const sessions = Layer.mock(Session.Service, {
      get: () =>
        Effect.succeed({
          id: parent,
          permission: [],
          agent: "build",
          model: undefined,
          directory: "/tmp",
        } as never),
      create: (create?: { directory?: string }) =>
        Effect.gen(function* () {
          const child = sessionID("child")
          yield* seedSession(db, child)
          created.push(child)
          return { id: child, directory: create?.directory ?? "/tmp" } as never
        }),
      messages: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
    })
    const workflow = makeWorkflowRow({ id: input.dagID, sessionId: input.parentSessionID })
    const dag = Layer.mock(Dag.Service, {
      store: {
        tryClaimAdoption: () => Effect.succeed(true),
        getWorkflow: () => Effect.succeed(workflow),
        getNode: () => Effect.succeed(input.node),
      } as unknown as DagStore.Interface,
      nodeQueued: () => Effect.void,
      nodeStarted: () => nodeStarted(),
      nodeCompleted: () => Effect.void,
      nodeFailed: () => Effect.void,
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      children: Effect.succeed(children),
      prompt: () => Effect.die(new Error("spawn must drive through children.prompt")),
    })
    const layers = Layer.mergeAll(dag, agentLayer, AgentScheduler.defaultLayer, sessions, promptLayer)

    yield* Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode({ limit: { kind: "workflow", workflowID: input.dagID }, cap: 1 }, input)
        yield* Fiber.await(result.fiber)
      }).pipe(Effect.provide(layers)),
    )
    return { db, created, cancelled }
  })

it.effect("writes the binding and the run, walks it to running, and settles it completed", () =>
  Effect.gen(function* () {
    const dagID = `wf-${crypto.randomUUID()}`
    const { db, created } = yield* runSpawn(spawnInput(dagID, "n1", "ses_durable_parent"))
    const child = created[0]!
    const rows = yield* runRows(db, child)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      owner_kind: "dag_node",
      owner_id: `${dagID}/n1`,
      state: "ended",
      detached: false,
      policy: { ask: "auto" },
      outcome: { type: "completed" },
    })
    expect(rows[0]?.reported_at).not.toBeNull()
    const bindings = yield* bindingRows(db, child)
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({
      parent_session_id: "ses_durable_parent",
      owner_kind: "dag_node",
      owner_ref: `${dagID}/n1`,
    })
  }),
)

it.effect("cancels the queued run when the durable start rejects the attempt", () =>
  Effect.gen(function* () {
    const dagID = `wf-${crypto.randomUUID()}`
    const { db, created, cancelled } = yield* runSpawn(spawnInput(dagID, "n2", "ses_durable_parent"), () =>
      Effect.fail(new TerminalViolationError("n2", "failed", "running")),
    )
    const child = created[0]!
    const rows = yield* runRows(db, child)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "ended",
      outcome: {
        type: "cancelled",
        by: { kind: "engine", reason: "admission-rejected", actor: "dag-loop" },
      },
    })
    expect(cancelled).toEqual([{ sessionID: child, reason: "admission-rejected", actor: "dag-loop" }])
  }),
)
