import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptGate {
  readonly title: string
  readonly sessionID: string
  readonly text: string
  readonly release: Deferred.Deferred<string>
}

const parentSessionID = "ses_retarget_loop_parent"

function reply(sessionID: string, text: string): SessionV1.WithParts {
  const sid = SessionID.make(sessionID)
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sid,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: Model.ID.make("test-model"),
      providerID: Provider.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), sessionID: sid, messageID, type: "text", text }],
  }
}

function node(id: string, workerType = "build", overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: workerType,
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...overrides,
  }
}

interface CreatedChild {
  readonly id: string
  readonly title: string
  readonly directory?: string
}

function loopLayer(input: {
  readonly directory: string
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly cancelled: string[]
  readonly created: CreatedChild[]
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const projectID = ProjectV2.ID.make("project-retarget-loop")
  const sessionInfo = (id: SessionSchema.ID, title: string, directory: string): Session.Info => ({
    id,
    slug: title,
    projectID,
    directory,
    title,
    version: "test",
    time: { created: 0, updated: 0 },
  })
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (id) => Effect.succeed(sessionInfo(id, "Parent", input.directory)),
    create: (value) =>
      Effect.sync(() => {
        const id = SessionID.make(`ses_retarget_child_${input.created.length + 1}`)
        const title = (value?.title ?? id).replace(" (DAG node)", "")
        const directory = value?.directory ?? input.directory
        input.created.push({ id, title, directory })
        return sessionInfo(id, value?.title ?? id, directory)
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.retarget")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === parentSessionID) return reply(sessionID, "parent handled wake")
    const text = value.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: input.created.find((child) => child.id === sessionID)?.title ?? sessionID,
      sessionID,
      release,
      text,
    })
    const outcome = yield* Deferred.await(release)
    return reply(sessionID, outcome)
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: (sessionID) => Effect.sync(() => input.cancelled.push(sessionID)),
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
  }))
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.merge(base, loop)
}

function runLoop<A>(
  directory: string,
  test: (services: {
    readonly dag: Dag.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly cancelled: string[]
    readonly created: CreatedChild[]
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const cancelled: string[] = []
    const created: CreatedChild[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      const projectID = ProjectV2.ID.make("project-retarget-loop")
      const parent = SessionID.make(parentSessionID)
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(directory),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: parent,
        project_id: projectID,
        slug: "parent",
        directory,
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      yield* loop.init()
      return yield* test({ dag, store, childPrompts, cancelled, created })
    }).pipe(
      Effect.provide(loopLayer({ directory, childPrompts, cancelled, created })),
      Effect.provideService(InstanceRef, {
        directory,
        worktree: directory,
        root: directory,
        project: {
          id: ProjectV2.ID.make("project-retarget-loop"),
          worktree: directory,
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

function takeGate(queue: Queue.Queue<PromptGate>, title: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(`${title} did not start`)),
      onSome: (gate) => Effect.succeed(gate),
    })),
  )
}

const workflow = {
  name: "retarget-loop",
  nodes: [node("review", "build", { target_sensitive: true }), node("build", "build")],
}

describe("Dag retarget through the live loop", () => {
  it("aborts the old child and lets the fresh attempt complete while an unrelated node keeps running", async () => {
    await using tmp = await tmpdirGit()
    await Effect.runPromise(
      runLoop(tmp.path, ({ dag, store, childPrompts, cancelled, created }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: ProjectV2.ID.make("project-retarget-loop"),
            sessionID: parentSessionID,
            title: "retarget",
            config: workflow,
          })
          const first = yield* takeGate(childPrompts, "review")
          const second = yield* takeGate(childPrompts, "build")
          const review = first.title === "review" ? first : second
          const build = first.title === "build" ? first : second
          expect([review.title, build.title].sort()).toEqual(["build", "review"])
          const oldReviewChild = review.sessionID
          const buildChild = build.sessionID

          const fingerprint = DagLocation.fingerprintTarget(tmp.path)
          yield* dag.retarget(dagID, {
            reason: "tree moved",
            fingerprint: fingerprint.kind === "git" ? fingerprint.value : "none",
          })

          yield* pollWithTimeout(
            Effect.sync(() => (cancelled.includes(oldReviewChild) ? cancelled : undefined)),
            "old review child was not aborted",
          )
          expect(cancelled).not.toContain(buildChild)

          const restarted = yield* takeGate(childPrompts, "review")
          expect(restarted.sessionID).not.toBe(oldReviewChild)
          expect(created.filter((child) => child.title === "build")).toHaveLength(1)
          yield* Deferred.succeed(restarted.release, "review fresh")
          yield* pollWithTimeout(
            store.getNode(dagID, "review").pipe(
              Effect.map((item) => (item?.status === "completed" ? item : undefined)),
            ),
            "the fresh review attempt did not complete",
          )
          expect(yield* store.getNode(dagID, "review")).toMatchObject({
            output: "review fresh",
            replanAttempts: 1,
          })
          expect(yield* store.getNode(dagID, "build")).toMatchObject({ status: "running" })

          // The aborted attempt cannot settle after the restart.
          const late = yield* dag
            .nodeCompleted(dagID, "review", "old evidence", { replanAttempts: 0, childSessionID: oldReviewChild })
            .pipe(Effect.exit)
          expect(late._tag).toBe("Failure")
        }),
      ),
    )
  })

  it("spawns the restarted attempt in the retargeted worktree", async () => {
    await using tmp = await tmpdirGit()
    const worktree = path.join(tmp.path, "linked")
    await $`git worktree add ${worktree} -b retarget-loop`.cwd(tmp.path).quiet()
    await Effect.runPromise(
      runLoop(tmp.path, ({ dag, childPrompts, cancelled, created }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: ProjectV2.ID.make("project-retarget-loop"),
            sessionID: parentSessionID,
            title: "retarget workspace",
            config: workflow,
          })
          const first = yield* takeGate(childPrompts, "review")
          const second = yield* takeGate(childPrompts, "build")
          const review = first.title === "review" ? first : second

          yield* dag.retarget(dagID, { workspace: worktree, reason: "switch worktree" })
          yield* pollWithTimeout(
            Effect.sync(() => (cancelled.includes(review.sessionID) ? cancelled : undefined)),
            "old review child was not aborted",
          )
          const restarted = yield* takeGate(childPrompts, "review")
          expect(restarted.sessionID).not.toBe(review.sessionID)
          const child = created.find((item) => item.id === restarted.sessionID)
          expect(child?.directory).toBe(DagLocation.canonicalDirectory(worktree))
        }),
      ),
    )
  })
})

async function tmpdirGit() {
  const { tmpdir } = await import("../fixture/fixture")
  return tmpdir({ git: true })
}
