// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// Regression: a workflow persisted before acceptance-time condition syntax
// checks may still carry an unsupported condition (`!==`, `===`, `&&`, `||`).
// evaluateCondition reports it as `{ ok: false }`; when such a workflow is
// adopted and the gated node becomes ready, the runtime must fail that node
// with the syntax diagnostic (and settle the workflow) instead of running it
// on a mis-lexed comparison or hanging.
import { describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { withIdleAdmission } from "../lib/session-prompt"

const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

function node(overrides: Partial<NodeConfig> & { id: string }): NodeConfig {
  return {
    name: overrides.id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: overrides.id },
    ...overrides,
  }
}

describe("DagLoop unsupported condition syntax in an adopted workflow", () => {
  it("fails the gated node with the syntax diagnostic and settles the workflow", async () => {
    const childPrompts: string[] = []
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
    const store = DagStore.layer.pipe(Layer.provide(database))
    const status = SessionStatus.layer.pipe(Layer.provide(bridge))
    const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
    const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
    const session = Layer.mock(Session.Service, {
      getPart: () => Effect.succeed(undefined),
      get: () =>
        Effect.succeed({
          id: SessionID.make("ses_parent"),
          slug: "parent",
          projectID: Project.ID.make("project-1"),
          directory: process.cwd(),
          title: "parent",
          agent: "build",
          model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
          version: "test",
          time: { created: 0, updated: 0 },
        }),
      create: () => Effect.sync(() => ({ id: `ses_child_${childPrompts.length + 1}` }) as never),
      messages: () => Effect.succeed([]),
    })
    const never = (value: SessionPrompt.PromptInput) =>
      Effect.sync(() => childPrompts.push(value.sessionID as string)).pipe(Effect.andThen(Effect.never))
    const prompt = Layer.mock(
      SessionPrompt.Service,
      withIdleAdmission({
        cancel: () => Effect.void,
        prompt: never,
        promptIfIdle: never,
      }),
    )
    const agent = Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const dagSvc = yield* Dag.Service
        const loop = yield* DagLoop.Service
        const db = yield* Database.Service
        const storeSvc = yield* DagStore.Service
        yield* db.db
          .insert(ProjectTable)
          .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db.db
          .insert(SessionTable)
          .values({
            id: SessionID.make("ses_parent"),
            project_id: Project.ID.make("project-1"),
            slug: "parent",
            directory: AbsolutePath.make(process.cwd()),
            title: "Parent",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        // A workflow from an earlier process: the gate already completed, the
        // gated dependent is pending. The loop is not loaded yet, so nothing
        // adopts it until init's startup recovery.
        const dagID = yield* dagSvc.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Legacy condition",
          config: {
            name: "legacy-condition",
            nodes: [
              node({ id: "gate" }),
              node({ id: "downstream", depends_on: ["gate"], condition: 'gate.output.verdict == "continue"' }),
            ],
          },
        })
        yield* dagSvc.nodeQueued(dagID, "gate", Date.now() + 600_000)
        yield* dagSvc.nodeStarted(dagID, "gate", "ses_gate", Date.now() + 600_000)
        yield* dagSvc.nodeCompleted(dagID, "gate", JSON.stringify({ verdict: "continue" }))
        // Persisted before the syntax check existed: `!==` used to lex as
        // `!= '= "continue"'` and evaluate true.
        const row = yield* storeSvc.getWorkflow(dagID)
        yield* db.db
          .update(WorkflowTable)
          .set({ config: row!.config.replace('== \\"continue\\"', '!== \\"continue\\"') })
          .where(eq(WorkflowTable.id, dagID))
          .run()
          .pipe(Effect.orDie)
        expect((yield* storeSvc.getWorkflow(dagID))?.config).toContain("!==")

        yield* loop.init()
        for (let i = 0; i < 300 && (yield* storeSvc.getWorkflow(dagID))?.status === "running"; i++) yield* realSleep(10)

        const downstream = yield* storeSvc.getNode(dagID, "downstream")
        expect({
          workflow: (yield* storeSvc.getWorkflow(dagID))?.status,
          downstream: downstream?.status,
          spawned: childPrompts.filter((id) => id !== "ses_parent").length,
        }).toEqual({ workflow: "failed", downstream: "failed", spawned: 0 })
        expect(downstream?.errorReason).toContain("unsupported syntax")
      }).pipe(
        Effect.provide(Layer.mergeAll(base, loopLayer)),
        Effect.provideService(InstanceRef, {
          directory: process.cwd(),
          worktree: process.cwd(),
          project: { id: "project-1" },
        } as never),
        Effect.scoped,
      ),
    )
  })
})
