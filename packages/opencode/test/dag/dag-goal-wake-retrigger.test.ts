import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider as ProviderSchema } from "@opencode-ai/schema/provider"
import { Provider as ProviderService } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { SessionAutomationLease } from "@/session/automation-lease"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

// GOAL-FP-01-02: the final DAG lease unregister (U2) lands AFTER the wake
// turn's idle event. GoalLoop's claim runs on idle while the dag registration
// still exists and yields; no further idle event follows, so an active goal
// silently stalls. Contract under test: when the dag owner disappears,
// unregister itself must re-trigger the goal evaluation through the existing
// idle status event mechanism — with NO idle events AFTER U2 (the wake turn's
// own idle, which the real runner emits and the prompt mock reproduces here,
// is what blocks the claim in the first place and arms the re-trigger).
//
// Real DagLoop (adoption, terminal handler, wake delivery end-to-end so U2
// fires inside the delivery tap) + real GoalLoop (idle subscription on the
// real event bus, judge scripted via GoalLoopJudgeLLM) + real
// SessionAutomationLease / SessionStatus / Goal / DagStore over one in-memory
// database. Session / SessionPrompt / Agent / Provider are mocked exactly
// like the wake-integration harness.

interface ChildPromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

const PARENT_SESSION = "ses_parent"
const PROJECT_ID = "project-1"

// Scripted assistant response — afterIdle extracts its text as the judge input.
const mkAssistant = (): SessionV1.WithParts => reply("ses_any", "I have made progress on the feature.")

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: SessionID.make(sessionID),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: Model.ID.make("test-model"),
      providerID: ProviderSchema.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ id: PartID.ascending(), sessionID: SessionID.make(sessionID), messageID: id, type: "text", text }] : [],
  }
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("1 second"),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error(message)),
        onSome: Effect.succeed,
      }),
    ),
  )
}

// Mutable observation state shared by the layer mocks and the test body.
let judgeCalls = 0
let promptCalls: { noReply?: boolean; text: string }[] = []
let parentPromptCalls = 0
let markReportCalls = 0
const reset = () => {
  judgeCalls = 0
  promptCalls = []
  parentPromptCalls = 0
  markReportCalls = 0
}

function goalWakeLayer(input: { childPrompts: Queue.Queue<ChildPromptGate>; failFirstMarkReport?: boolean }) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = input.failFirstMarkReport
    ? // GOAL-FP-01-14 harness: the real store with ONE injected failure on the
      // first markWakeBatchReported call — the wake transcript part has
      // already been written when that mark fails, and the retry must not
      // re-inject the summary.
      Layer.effect(
        DagStore.Service,
        Effect.gen(function* () {
          const real = yield* DagStore.Service
          return DagStore.Service.of({
            ...real,
            markWakeBatchReported: (batch: DagStore.WakeBatch) =>
              Effect.gen(function* () {
                markReportCalls += 1
                if (markReportCalls === 1) return yield* Effect.die("injected markWakeBatchReported failure")
                return yield* real.markWakeBatchReported(batch)
              }),
          })
        }),
      ).pipe(Layer.provide(DagStore.layer.pipe(Layer.provide(database))))
    : DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const goal = Goal.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(database),
    Layer.provide(status),
  )
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, goal, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  let lastAssistant = mkAssistant()
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (_sessionID) =>
      Effect.succeed({
        id: SessionID.make(PARENT_SESSION),
        slug: "parent",
        projectID: Project.ID.make(PROJECT_ID),
        directory: process.cwd(),
        title: "Parent",
        version: "test",
        time: { created: 0, updated: 0 },
      }),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return {
          id: SessionID.make(id),
          slug: "child",
          projectID: Project.ID.make(PROJECT_ID),
          directory: process.cwd(),
          title: value?.title ?? id,
          version: "test",
          time: { created: 0, updated: 0 },
        }
      }),
    // GoalLoop.afterIdle reads the last-20 message window: an assistant
    // message must exist so the judge is reached (no stale-zombie / no-assistant
    // early pauses).
    messages: () => Effect.succeed([lastAssistant]),
  })
  const deliver = Effect.fn("test.goalWake.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === PARENT_SESSION) {
      // Parent prompts: the dag wake delivery AND the goal continuation must
      // both succeed. Record the call so the test can tell them apart.
      yield* Effect.sync(() => {
        promptCalls.push({
          noReply: value.noReply,
          text: value.parts?.map((p) => (p.type === "text" ? p.text : "")).join("\n") ?? "",
        })
      })
      // The FIRST parent prompt is the wake delivery. Mirror the real runner:
      // a completed wake turn emits the session idle event before its awaiter
      // resolves — i.e., before the delivery tap's U2. That idle event drives
      // GoalLoop's evaluation, whose claim is rejected by the still-registered
      // dag — the blocked claim the unregister re-trigger exists to retry
      // (GOAL-FP-01-02 / R1). Later parent prompts are goal continuations and
      // must not re-emit (the mock has no real runner turn).
      lastAssistant = reply(sessionID, "parent turn")
      if (parentPromptCalls === 0) {
        parentPromptCalls += 1
        yield* Effect.serviceOption(EventV2Bridge.Service).pipe(
          Effect.flatMap((bridge) =>
            Option.isSome(bridge)
              ? bridge.value.publish(SessionStatus.Event.Status, {
                  sessionID: SessionID.make(sessionID),
                  status: { type: "idle" },
                })
              : Effect.void,
          ),
        )
      }
      return lastAssistant
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, { title: childTitles.get(sessionID) ?? sessionID, release })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: () => Effect.void,
    prompt: deliver,
    promptIfIdle: (value: SessionPrompt.PromptInput) => deliver(value).pipe(Effect.map(Option.some)),
  }))
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        model: { providerID: ProviderSchema.ID.make("test"), modelID: Model.ID.make("test-model") },
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
  // Real GoalLoop over the same shared bus/status/goal/lease instances.
  const goalLoop = GoalLoop.layer.pipe(
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(ProviderService.Service, {})),
    Layer.provide(
      Layer.succeed(
        GoalLoopJudgeLLM,
        GoalLoopJudgeLLM.of({
          call: () =>
            Effect.sync(() => {
              judgeCalls += 1
              return JSON.stringify({ done: false, reason: "more steps needed" })
            }),
        }),
      ),
    ),
    Layer.provide(goal),
    Layer.provide(status),
    Layer.provide(bridge),
  )
  // DagLoop.layer / GoalLoop.layer / Goal.layer consume the lease internally.
  // Merge the SAME module-level layer at the top so the test body observes the
  // very instance DagLoop and GoalLoop use (Layer.build memoization dedups the
  // shared layer reference).
  return Layer.mergeAll(base, loop, goalLoop, SessionAutomationLease.defaultLayer)
}

function runGoalWakeTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly goalLoop: GoalLoop.Interface
    readonly store: DagStore.Interface
    readonly goal: Goal.Interface
    readonly automation: SessionAutomationLease.Interface
    readonly database: Database.Interface
    readonly childPrompts: Queue.Queue<ChildPromptGate>
  }) => Effect.Effect<A, Error>,
  layerInput: { failFirstMarkReport?: boolean } = {},
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<ChildPromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const goalLoop = yield* GoalLoop.Service
      const store = yield* DagStore.Service
      const goal = yield* Goal.Service
      const automation = yield* SessionAutomationLease.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: Project.ID.make(PROJECT_ID),
          worktree: AbsolutePath.make(process.cwd()),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: SessionID.make(PARENT_SESSION),
          project_id: Project.ID.make(PROJECT_ID),
          slug: "parent",
          directory: AbsolutePath.make(process.cwd()),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, goalLoop, store, goal, automation, database, childPrompts })
    }).pipe(
      Effect.provide(goalWakeLayer({ childPrompts, ...layerInput })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: {
          id: Project.ID.make(PROJECT_ID),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

describe("DagLoop final wake delivery re-triggers the goal (GOAL-FP-01-02)", () => {
  it("an active goal is claimed and progresses after the dag lease release, with no further idle events", async () => {
    await Effect.runPromise(
      runGoalWakeTest(({ dag, loop, goalLoop, store, goal, automation, childPrompts }) =>
        Effect.gen(function* () {
          reset()
          const sid = SessionID.make(PARENT_SESSION)

          yield* loop.init()
          yield* goalLoop.init()
          // Give the forkScoped idle subscriptions one scheduler turn to
          // acquire their PubSub subscriptions.
          yield* Effect.yieldNow

          // An active goal in the same session. No idle event is ever
          // published by the test body from here on.
          const goalState = yield* goal.set(sid, "ship the feature", 10)
          const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }
          yield* Effect.yieldNow

          const dagID = yield* dag.create({
            projectID: PROJECT_ID,
            sessionID: PARENT_SESSION,
            title: "wake retrigger",
            config: { name: "wake-retrigger", result_protocol: "submit_result", nodes: [node("implement")] },
          })

          // Adoption (WorkflowStarted) registered the dag lease for the parent.
          const child = yield* takeWithin(childPrompts, "implement did not start")
          expect(Option.isSome(yield* automation.claim(sid, { kind: "dag" }))).toBe(true)

          // Complete the node → workflow terminalizes → the terminal handler
          // releases the dag registration and forks the wake delivery.
          yield* Deferred.succeed(child.release, "done")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => (workflow?.status === "completed" ? workflow : undefined)),
            ),
            "workflow did not complete",
          )

          // The final wake delivery succeeded and reported (U2 unregistered the
          // terminal workflow inside the delivery tap).
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => (workflow?.wakeReported ? workflow : undefined)),
            ),
            "wake was never reported",
          )

          // Observe the committed Goal state and continuation, not merely entry
          // into the judge: the durable commit is asynchronous after that call.
          yield* pollWithTimeout(
            goal
              .load(sid)
              .pipe(
                Effect.map((state) =>
                  state &&
                  state.turns_used >= 1 &&
                  promptCalls.some((p) => !p.noReply && p.text.includes("ship the feature"))
                    ? state
                    : undefined,
                ),
              ),
            "goal did not progress after the dag lease release (GOAL-FP-01-02)",
            "5 seconds",
          )

          const g = yield* goal.load(sid)
          expect(g?.status).toBe("active")
          expect(Number(g?.turns_used)).toBeGreaterThanOrEqual(1)
          // The continuation prompt (not a noReply pause line) carries the goal.
          expect(promptCalls.some((p) => !p.noReply && p.text.includes("ship the feature"))).toBe(true)
          // Ownership transferred: the dag lease is gone, the goal owns the session.
          expect(Option.isNone(yield* automation.claim(sid, { kind: "dag" }))).toBe(true)
          expect(Option.isSome(yield* automation.claim(sid, goalOwner))).toBe(true)
        }),
      ),
    )
  })
})

// GOAL-FP-01-14: the wake transcript part is written BEFORE the durable
// markWakeBatchReported, so a mark failure (or a crash between the two) leaves
// the batch unreported — and the retry re-injects the SAME summary into the
// transcript (duplicate visibility). The delivery must dedupe on retry: when
// the summary was already written, the retry only re-marks, it must not
// re-prompt. The retry here is armed by the wake turn's own idle event (the
// prompt mock mirrors the real runner's end-of-turn idle).
describe("DagLoop wake delivery — a mark failure retry must not re-inject the summary (GOAL-FP-01-14)", () => {
  it("the wake summary reaches the transcript exactly once when the first mark fails", async () => {
    await Effect.runPromise(
      runGoalWakeTest(
        ({ dag, loop, store, childPrompts }) =>
          Effect.gen(function* () {
            reset()
            yield* loop.init()
            yield* Effect.yieldNow

            const dagID = yield* dag.create({
              projectID: PROJECT_ID,
              sessionID: PARENT_SESSION,
              title: "mark failure retry",
              config: { name: "mark-fail", result_protocol: "submit_result", nodes: [node("implement")] },
            })

            const child = yield* takeWithin(childPrompts, "implement did not start")
            yield* Deferred.succeed(child.release, "done")
            yield* pollWithTimeout(
              store.getWorkflow(dagID).pipe(
                Effect.map((workflow) => (workflow?.status === "completed" ? workflow : undefined)),
              ),
              "workflow did not complete",
            )

            // First delivery attempt writes the transcript part, then the
            // injected mark failure leaves the batch unreported. The retry
            // (armed by the wake turn's own idle event) must re-mark only.
            yield* pollWithTimeout(
              Effect.sync(() => (markReportCalls >= 2 ? true : undefined)),
              "wake delivery never retried after the injected mark failure",
              "5 seconds",
            )
            yield* pollWithTimeout(
              store.getWorkflow(dagID).pipe(
                Effect.map((workflow) => (workflow?.wakeReported ? workflow : undefined)),
              ),
              "wake was never reported",
            )

            // Pre-fix: the retry re-prompted the identical summary — the
            // transcript would show the wake digest twice.
            const wakeSummaries = promptCalls.filter((p) => p.text.includes("[DAG Workflow completed]"))
            expect(wakeSummaries.length).toBe(1)
          }),
        { failFirstMarkReport: true },
      ),
    )
  })
})
