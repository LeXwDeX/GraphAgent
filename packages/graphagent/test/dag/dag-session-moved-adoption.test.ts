// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// Regression: SessionEvent.Moved of a session that owns a RUNNING workflow,
// with both the old and the new directory instances live. The old owner evicts
// its runtime entry (cancelling the child, interrupting the fiber); the new
// owner must adopt the workflow through the ordinary recovery path — reconcile
// the dead attempt with attempt identity and park the workflow for the parent —
// instead of leaving the durable row running with a dead node and a pending
// dependent that nothing ever schedules again.
import { afterAll, describe, expect, it } from "bun:test"
import { DateTime, Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { SessionProjector } from "@graphagent/core/session/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Location } from "@graphagent/schema/location"
import { SessionEvent } from "@graphagent/schema/session-event"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

const PROJECT_ID = "project-1"
// #948: adoption now requires the stamped execution directory to exist.
const movedRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-session-moved-")))
const DIR_A = path.join(movedRoot, "wtA")
const DIR_B = path.join(movedRoot, "wtB")
mkdirSync(DIR_A, { recursive: true })
mkdirSync(DIR_B, { recursive: true })
afterAll(() => rmSync(movedRoot, { recursive: true, force: true }))
const SES = "sesA"

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
  }
}

const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

describe("DagLoop session move with a running workflow", () => {
  it("the new owner directory adopts the workflow and reconciles the evicted attempt", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const childPrompts = new Map([
          [DIR_A, yield* Queue.unbounded<{ sessionID: string; release: Deferred.Deferred<string> }>()],
          [DIR_B, yield* Queue.unbounded<{ sessionID: string; release: Deferred.Deferred<string> }>()],
        ])
        const cancels: Record<string, string[]> = { [DIR_A]: [], [DIR_B]: [] }
        let created = 0

        const database = Database.layerFromPath(":memory:")
        const events = EventV2.layer.pipe(Layer.provide(database))
        const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
        const store = DagStore.layer.pipe(Layer.provide(database))
        const status = SessionStatus.layer.pipe(Layer.provide(bridge))
        const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
        const sessionProjector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
        const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
        const base = Layer.mergeAll(
          database,
          events,
          bridge,
          store,
          projector,
          sessionProjector,
          dag,
          status,
          AgentScheduler.defaultLayer,
        )
        const session = Layer.mock(Session.Service, {
          getPart: () => Effect.succeed(undefined),
          get: () => Effect.succeed({ id: SES, permission: [], agent: "build" } as never),
          create: () => Effect.sync(() => ({ id: `ses_child_${++created}` }) as never),
          messages: () => Effect.succeed([] as SessionV1.WithParts[]),
        })
        const deliver = Effect.fn("test.deliver")(function* (value: SessionPrompt.PromptInput) {
          const dir = (yield* InstanceRef)?.directory ?? DIR_A
          const release = yield* Deferred.make<string>()
          yield* Queue.offer(childPrompts.get(dir)!, { sessionID: value.sessionID as string, release })
          const text = yield* Deferred.await(release)
          return {
            info: {
              id: MessageID.ascending(),
              sessionID: value.sessionID,
              role: "assistant",
              time: { created: Date.now() },
              finish: "stop",
            },
            parts: [{ type: "text", text }],
          } as never as SessionV1.WithParts
        })
        const prompt = mockSessionPrompt({
          cancel: (sessionID) =>
            Effect.gen(function* () {
              const dir = (yield* InstanceRef)?.directory ?? DIR_A
              cancels[dir].push(sessionID as string)
            }),
          prompt: deliver,
          prepareTurn: () => Effect.succeed(Option.none()),
        })
        const agent = Layer.mock(Agent.Service, {
          get: () =>
            Effect.succeed({
              name: "build",
              mode: "all",
              permission: [],
              options: {},
              description: "",
              prompt: "",
              model: { providerID: "test" as never, modelID: "test-model" as never },
              tools: {},
              hooks: {},
            }),
        })
        const loopLayer = DagLoop.layer.pipe(
          Layer.provide(base),
          Layer.provide(session),
          Layer.provide(prompt),
          Layer.provide(agent),
        )
        const refB = { directory: DIR_B, worktree: DIR_B, project: { id: PROJECT_ID } } as never

        yield* Effect.gen(function* () {
          const db = yield* Database.Service
          const dagSvc = yield* Dag.Service
          const loop = yield* DagLoop.Service
          const storeSvc = yield* DagStore.Service
          const bus = yield* EventV2Bridge.Service
          yield* db.db
            .insert(ProjectTable)
            .values({ id: PROJECT_ID as never, worktree: DIR_A as never, sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* db.db
            .insert(SessionTable)
            .values({
              id: SES as never,
              project_id: PROJECT_ID as never,
              slug: "a",
              directory: DIR_A as never,
              title: "A",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          // Both directory instances are live.
          yield* loop.init()
          yield* loop.init().pipe(Effect.provideService(InstanceRef, refB))

          const dagID = yield* dagSvc.create({
            projectID: PROJECT_ID,
            sessionID: SES,
            title: "moved",
            config: { name: "moved", nodes: [node("n1"), node("n2", ["n1"])] },
          })
          let n1: { sessionID: string } | undefined
          for (let i = 0; i < 200 && !n1; i++) {
            const item = yield* Queue.poll(childPrompts.get(DIR_A)!)
            if (Option.isSome(item)) n1 = item.value
            else yield* realSleep(10)
          }
          expect(n1).toBeDefined()
          expect((yield* storeSvc.getWorkflow(dagID))?.directory).toBe(DIR_A)

          // Move the session (and, atomically, its workflow stamps) to DIR_B.
          yield* bus
            .publish(SessionEvent.Moved, {
              sessionID: SES as never,
              location: Location.Ref.make({ directory: DIR_B as never }),
              timestamp: yield* DateTime.now,
            })
            .pipe(Effect.orDie)
          expect((yield* storeSvc.getWorkflow(dagID))?.directory).toBe(DIR_B)

          // The old owner evicts and kills the in-flight attempt.
          for (let i = 0; i < 100 && !cancels[DIR_A].includes(n1!.sessionID); i++) yield* realSleep(10)
          expect(cancels[DIR_A]).toContain(n1!.sessionID)

          // The NEW owner (DIR_B) adopts: the dead attempt is reconciled
          // (ownership lost → n1 failed) and the workflow is parked for the
          // parent instead of terminalizing; n2 stays replannable.
          let wf = yield* storeSvc.getWorkflow(dagID)
          for (let i = 0; i < 300 && wf?.status !== "paused"; i++) {
            yield* realSleep(10)
            wf = yield* storeSvc.getWorkflow(dagID)
          }
          const nodes = yield* storeSvc.getNodes(dagID)
          expect({
            workflow: wf?.status,
            directory: wf?.directory,
            nodes: Object.fromEntries(nodes.map((n) => [n.id, n.status])),
          }).toEqual({ workflow: "paused", directory: DIR_B, nodes: { n1: "failed", n2: "pending" } })
          expect((yield* storeSvc.getNode(dagID, "n1"))?.errorReason).toContain("ownership lost")
          // Nothing was spawned under the old directory after the move.
          expect(Option.isNone(yield* Queue.poll(childPrompts.get(DIR_A)!))).toBe(true)
        }).pipe(
          Effect.provide(Layer.mergeAll(base, loopLayer)),
          Effect.provideService(InstanceRef, {
            directory: DIR_A,
            worktree: DIR_A,
            project: { id: PROJECT_ID },
          } as never),
          Effect.scoped,
        )
      }),
    )
  })
})
