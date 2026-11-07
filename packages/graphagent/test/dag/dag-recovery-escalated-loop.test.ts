import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

function node(id: string, timeoutMs?: number): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...(timeoutMs !== undefined ? { worker_config: { timeout_ms: timeoutMs } } : {}),
  }
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function recoveryLayer(input: { wakes: string[] }) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  // The crashed child session is gone: reads yield no durable outcome, so the
  // recovery checker reports "unknown" (ownership lost), not a fabricated
  // completion/failure read off the child.
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    create: () => Effect.sync(() => ({}) as never),
    get: () => Effect.succeed({} as never),
    messages: () => Effect.succeed([]),
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: () => Effect.void,
    prompt: () => Effect.never,
    promptIfIdle: (value) =>
      Effect.sync(() => {
        const text = value.parts.find((part) => part.type === "text")?.text
        if (text) input.wakes.push(text)
      }).pipe(
        Effect.map(() => Option.some(reply(value.sessionID as string, "wake handled"))),
      ),
  }))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.merge(base, loop)
}

function runRecoveryTest<A>(
  test: (services: {
    dag: Dag.Interface
    database: Database.Interface
    loop: DagLoop.Interface
    store: DagStore.Interface
    wakes: string[]
  }) => Effect.Effect<A, Error>,
) {
  const wakes: string[] = []
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const database = yield* Database.Service
    const loop = yield* DagLoop.Service
    const store = yield* DagStore.Service
    yield* database.db.insert(ProjectTable).values({
      id: "project-1" as never,
      worktree: process.cwd() as never,
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: "ses_parent" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    return yield* test({ dag, database, loop, store, wakes })
  }).pipe(
    Effect.provide(recoveryLayer({ wakes })),
    Effect.provideService(InstanceRef, {
      directory: process.cwd(),
      worktree: process.cwd(),
      project: { id: "project-1" },
    } as never),
    Effect.scoped,
  )
}

describe("DagLoop escalated crash recovery (loop-level E2E)", () => {
  it("reconciles a crashed escalated node to a timeout failure, pauses the workflow, and wakes the parent", async () => {
    await Effect.runPromise(
      runRecoveryTest(({ dag, loop, store, wakes }) =>
        Effect.gen(function* () {
          // Simulate a process crash AFTER the node escalated once: the node
          // row is running, timeout_extensions=1, its deadline passed while it
          // was executing, and the child session is gone. Everything is seeded
          // before DagLoop.init so the startup recovery scan is the actor.
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Escalated crash",
            config: { name: "escalated-crash", nodes: [node("a", 60_000)] },
          })
          yield* dag.nodeQueued(dagID, "a", Date.now() - 1000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_crashed", Date.now() - 1000, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_crashed", 1)

          yield* loop.init()

          // S2: the durable escalation counter proves the timeout semantics —
          // the recovery must fail the node as timeout (not ownership loss),
          // preserve the extension count, and pause the workflow instead of
          // letting the scheduler cascade terminalize on invented evidence.
          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.errorClass).toBe("timeout")
          expect(row?.errorReason).toContain("timeout escalated (1 extension(s)) node failed on recovery")
          expect(row?.timeoutExtensions).toBe(1)
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")

          // The invented-failure wake reaches the parent at the paused
          // delivery boundary with the timeout attribution.
          const wake = yield* pollWithTimeout(
            Effect.sync(() => (wakes.length > 0 ? wakes[0] : undefined)),
            "recovery wake did not reach the parent",
          )
          expect(wake).toContain('Node "a" failed (timeout)')
          expect(wake).toContain("timeout escalated (1 extension(s)) node failed on recovery")
        }),
      ),
    )
  })

  it("reports ownership loss for a crashed escalated node whose deadline never passed (S2 future deadline)", async () => {
    await Effect.runPromise(
      runRecoveryTest(({ dag, loop, store }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Escalated crash future",
            config: { name: "escalated-crash-future", nodes: [node("a", 60_000)] },
          })
          yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_crashed", Date.now() + 60_000, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_crashed", 1)

          yield* loop.init()

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("failed")
          expect(row?.errorClass).toBe("exec_failed")
          expect(row?.errorReason).toContain("execution ownership lost on recovery")
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")
        }),
      ),
    )
  })
})
