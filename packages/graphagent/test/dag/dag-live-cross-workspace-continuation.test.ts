// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { $ } from "bun"
import { sql } from "drizzle-orm"
import { Effect, Fiber, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { layer as sqliteLayer } from "@graphagent/core/database/sqlite.bun"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { DagProjector } from "@graphagent/core/dag/projector"
import { EventV2 } from "@graphagent/core/event"
import { ProjectV2 } from "@graphagent/core/project"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { tmpdir } from "../fixture/fixture"
import { makeNodeRow } from "./fixtures"
import { AgentScheduler } from "@/session/agent-scheduler"

/** The per-workflow child-run schedule the loop hands to `spawnNode`. */
const spawnSchedule = <T extends { readonly dagID: string }>(input: T, cap: number) => ({
  limit: { kind: "workflow" as const, workflowID: input.dagID },
  cap,
})

const projectID = ProjectV2.ID.make("p-cross-workspace")
const parentID = SessionID.make("ses_cross_parent")
const childID = SessionID.make("ses_cross_child")

function sessionInfo(id: SessionID, directory: string, parentID?: SessionID): Session.Info {
  return {
    id,
    projectID,
    slug: id,
    directory,
    title: id,
    version: "test",
    ...(parentID ? { parentID } : {}),
    time: { created: 1, updated: 1 },
  }
}

function reply(text: string, directory: string, messageID = MessageID.ascending()): SessionV1.WithParts {
  return {
    info: {
      id: messageID,
      parentID: MessageID.ascending(),
      sessionID: childID,
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: directory, root: directory },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), sessionID: childID, messageID, type: "text", text }],
  }
}

function value<A>(result: DagMessages.Result<A>): A {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

describe("live cross-workspace DAG continuation", () => {
  test("runs the queued-input loop in the child workspace and settles the same attempt", async () => {
    await using owner = await tmpdir({ git: true })
    await using workspace = await tmpdir()
    await rm(workspace.path, { recursive: true, force: true })
    await $`git worktree add --detach ${workspace.path} HEAD`.cwd(owner.path).quiet()

    try {
      const sqlite = sqliteLayer({ filename: ":memory:" })
      const database = Database.layer.pipe(Layer.provide(sqlite))
      const events = EventV2.layer.pipe(Layer.provide(database))
      const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
      const store = DagStore.layer.pipe(Layer.provide(database))
      const messagesLayer = DagMessages.layer.pipe(Layer.provide(database))
      const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
      const persistence = Layer.mergeAll(database, events, bridge, store, messagesLayer, projector)
      const dag = Dag.layer.pipe(Layer.provide(persistence))

      const parent = sessionInfo(parentID, owner.path)
      const child = sessionInfo(childID, workspace.path, parentID)
      const parentCaller = { projectID: projectID as string, directory: owner.path, sessionID: parentID as string }
      const childCaller = { projectID: projectID as string, directory: workspace.path, sessionID: childID as string }
      let prompts = 0
      let loops = 0
      let completedToolWrites = 0
      const loopDirectories: string[] = []
      let messages: DagMessages.Interface | undefined
      let databaseService: Database.Interface | undefined

      const agent = Layer.mock(Agent.Service, {
        get: () =>
          Effect.succeed({
            name: "build",
            mode: "all",
            permission: [],
            options: {},
            description: "",
            prompt: "",
            tools: {},
            hooks: {},
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
          }),
      })
      const sessions = Layer.mock(Session.Service, {
        get: (id) => Effect.succeed(id === parentID ? parent : child),
        create: () => Effect.succeed(child),
      })
      const instanceStore = Layer.mock(InstanceStore.Service, {
        provide: (input, effect) =>
          effect.pipe(
            Effect.provideService(InstanceRef, {
              directory: input.directory,
              worktree: input.directory,
              project: { id: projectID, worktree: input.directory, sandboxes: [], time: { created: 1, updated: 1 } },
            } as never),
          ),
      })

      const prompt = Layer.mock(SessionPrompt.Service, {
        prompt: () =>
          Effect.gen(function* () {
            prompts++
            completedToolWrites++
            const sent = yield* messages!.send(parentCaller, {
              workflowID: "dag_cross_workspace",
              nodeID: "node-1",
              attemptID: DagMessages.nodeAttemptID(childID, 0),
              idempotencyKey: "new-input",
              content: "continue with the new input",
            })
            expect(sent.ok).toBe(true)
            return reply("old result", workspace.path)
          }),
        loop: () =>
          Effect.gen(function* () {
            loops++
            const instance = yield* InstanceRef
            loopDirectories.push(instance?.directory ?? "<missing>")
            if (!instance || instance.directory !== workspace.path)
              return yield* Effect.die(new Error("continuation loop used the owner workspace"))

            const turn = MessageID.ascending()
            const frozen = value(yield* messages!.freeze(childCaller, turn))
            const { db } = databaseService!
            for (const message of frozen.messages) {
              yield* db.run(
                sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${message.transcriptID},${childID},1,1,'{}') ON CONFLICT(id) DO NOTHING`,
              )
              yield* db.run(
                sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${message.partID},${message.transcriptID},${childID},1,1,${JSON.stringify({ type: "text", text: DagMessages.renderMessage(message) })}) ON CONFLICT(id) DO NOTHING`,
              )
            }
            expect((yield* messages!.associate(childCaller, frozen.id)).ok).toBe(true)
            return reply("updated result", workspace.path, turn)
          }).pipe(Effect.provideService(Database.Service, databaseService!), Effect.orDie),
        cancel: () => Effect.void,
      })

      const layer = Layer.mergeAll(
        persistence,
        dag,
        agent,
        sessions,
        prompt,
        instanceStore,
        AgentScheduler.defaultLayer,
      )
      const ambient = {
        directory: owner.path,
        worktree: owner.path,
        project: { id: projectID, worktree: owner.path, sandboxes: [], time: { created: 1, updated: 1 } },
      }

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            databaseService = yield* Database.Service
            const { db } = databaseService
            messages = yield* DagMessages.Service
            yield* db.run(
              sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${projectID},${owner.path},'[]',1,1)`,
            )
            for (const session of [parent, child])
              yield* db.run(
                sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${session.id},${projectID},${session.parentID ?? null},${session.slug},${session.directory},${session.title},'test',1,1)`,
              )
            yield* db.run(
              sql`INSERT INTO workflow (id,project_id,session_id,directory,execution_directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES ('dag_cross_workspace',${projectID},${parentID},${owner.path},${workspace.path},'{"kind":"none"}','W','running',${JSON.stringify({ name: "W", nodes: [{ id: "node-1", name: "N", worker_type: "build", depends_on: [] }] })},0,1,1)`,
            )
            yield* db.run(
              sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,seq,time_created,time_updated) VALUES ('node-1','dag_cross_workspace','N','build','pending','[]',NULL,0,1,1)`,
            )

            const input: NodeSpawnInput = {
              dagID: "dag_cross_workspace",
              nodeID: "node-1",
              node: makeNodeRow({ id: "node-1", name: "N", status: "pending" }),
              parentSessionID: parentID,
              directory: owner.path,
              executionDirectory: workspace.path,
              promptParts: [{ type: "text", text: "work" }],
            }
            const spawned = yield* spawnNode(spawnSchedule(input, 1), input)
            yield* Fiber.join(spawned.fiber)

            const finalNode = yield* (yield* Dag.Service).store.getNode("dag_cross_workspace", "node-1")
            expect({
              prompts,
              loops,
              completedToolWrites,
              loopDirectories,
              status: finalNode?.status,
              childSessionId: finalNode?.childSessionId,
              replanAttempts: finalNode?.replanAttempts,
            }).toEqual({
              prompts: 1,
              loops: 1,
              completedToolWrites: 1,
              loopDirectories: [workspace.path],
              status: "completed",
              childSessionId: childID,
              replanAttempts: 0,
            })
            expect(value(yield* messages!.receive(childCaller)).map((message) => message.state)).toEqual(["delivered"])
          }),
        ).pipe(Effect.provideService(InstanceRef, ambient as never), Effect.provide(layer)),
      )
    } finally {
      await $`git worktree remove --force ${workspace.path}`.cwd(owner.path).quiet().nothrow()
    }
  })
})
