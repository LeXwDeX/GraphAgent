// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// A fan_out writer is reshaped at admission through the durable extend path:
// disjoint plan packages become parallel writers plus an aggregator under the
// writer's id, and anything else runs the writer serially without the marker.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { DagBlocks } from "@/dag/blocks"
import { Dag, parseWorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { withIdleAdmission } from "../lib/session-prompt"

const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

const pkg = (id: string, write_set: string[]) => ({ id, instruction: `Implement ${id}`, write_set })

function nodes() {
  return DagBlocks.compileWorkflowBlocks({
    objective: "Deliver the planned change",
    blocks: [
      new DagBlocks.WorkflowBlock({ id: "plan", kind: "plan" }),
      new DagBlocks.WorkflowBlock({ id: "slices", kind: "coding", depends_on: ["plan"], fan_out: "plan" }),
      new DagBlocks.WorkflowBlock({ id: "gates", kind: "verify", depends_on: ["slices"] }),
      new DagBlocks.WorkflowBlock({ id: "decision", kind: "review", depends_on: ["gates"] }),
    ],
  })
}

async function run(planOutput: unknown) {
  const prompts: string[] = []
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
    create: () => Effect.sync(() => ({ id: `ses_child_${prompts.length + 1}` }) as never),
    messages: () => Effect.succeed([]),
  })
  // Children never finish: the test observes admission, not settlement.
  const never = (value: SessionPrompt.PromptInput) =>
    Effect.sync(() => prompts.push(JSON.stringify(value))).pipe(Effect.andThen(Effect.never))
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({ cancel: () => Effect.void, prompt: never, promptIfIdle: never }),
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

  return Effect.runPromise(
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

      const dagID = yield* dagSvc.create({
        projectID: "project-1",
        sessionID: "ses_parent",
        title: "Fan-out",
        config: { name: "fan-out", max_concurrency: 4, nodes: nodes() },
      })
      yield* dagSvc.nodeQueued(dagID, "plan", Date.now() + 600_000)
      yield* dagSvc.nodeStarted(dagID, "plan", "ses_plan", Date.now() + 600_000)
      yield* dagSvc.nodeCompleted(dagID, "plan", JSON.stringify(planOutput))

      yield* loop.init()
      const running = () =>
        storeSvc.getNodes(dagID).pipe(Effect.map((rows) => rows.filter((row) => row.status === "running")))
      for (let i = 0; i < 300 && (yield* running()).length === 0; i++) yield* realSleep(10)
      // Let a wrongly unexpanded writer, if any, also reach admission.
      yield* realSleep(100)

      const config = parseWorkflowConfig((yield* storeSvc.getWorkflow(dagID))!.config)!
      return {
        config,
        running: (yield* running()).map((row) => row.id).sort(),
        prompts,
      }
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
}

describe("DagLoop fan_out expansion", () => {
  it("runs disjoint packages as parallel writers joined under the original writer id", async () => {
    const result = await run({ summary: "split", packages: [pkg("api", ["src/api"]), pkg("ui", ["src/ui"]), pkg("docs", ["docs"])] })
    const byID = new Map(result.config.nodes.map((node) => [node.id, node]))

    expect(result.running).toEqual(["slices--api", "slices--docs", "slices--ui"])
    expect(byID.get("slices")).toMatchObject({
      worker_type: "explore",
      depends_on: ["slices--api", "slices--ui", "slices--docs"],
    })
    expect(byID.get("slices")?.fan_out).toBeUndefined()
    // Downstream bindings are untouched and now read the aggregator.
    expect(byID.get("gates")?.depends_on).toEqual(["slices"])
    expect(byID.get("decision")?.review?.implementation_node_id).toBe("slices")
    // Each writer still sees the whole plan as context, plus its own assignment.
    expect(result.prompts.filter((text) => text.includes("Assigned work package"))).toHaveLength(3)
  })

  it("runs the writer unchanged when the planner keeps one package", async () => {
    const result = await run({ summary: "one", packages: [pkg("all", ["src"])] })
    const writer = result.config.nodes.find((node) => node.id === "slices")
    expect(result.running).toEqual(["slices"])
    expect(writer?.worker_type).toBe("build")
    expect(writer?.fan_out).toBeUndefined()
    expect(result.config.nodes.some((node) => node.id.startsWith("slices--"))).toBe(false)
  })

  it("declines overlapping packages and runs one serial writer that is told why", async () => {
    const result = await run({ summary: "bad", packages: [pkg("a", ["src"]), pkg("b", ["src/b.ts"])] })
    expect(result.running).toEqual(["slices"])
    expect(result.config.nodes.find((node) => node.id === "slices")?.fan_out).toBeUndefined()
    expect(result.prompts.some((text) => text.includes("Parallel fan-out was declined"))).toBe(true)
  })

  it("declines when the expanded graph would breach the node ceiling", async () => {
    const many = Array.from({ length: 120 }, (_, index) => pkg(`p${index}`, [`src/p${index}`]))
    const result = await run({ summary: "huge", packages: many })
    expect(result.running).toEqual(["slices"])
    expect(result.prompts.some((text) => text.includes("the expanded graph was rejected"))).toBe(true)
  })
})
