// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Branded ids and the prompt/InstanceRef shims stand in for the full services; the store, events, report delivery and DagDelivery are real and no model is started. */

// #1015 at the `DagDelivery` boundary, over durable state the engine itself
// wrote (`Dag` events, not hand-seeded rows). `dag-terminal-wake-mode.test.ts`
// runs whole workflows through the loop; the cases here need controls the loop
// does not give: a failing mode read, and a process that dies between the report
// receipt and the wake mark (or just after the wake was admitted) and restarts
// over the same database.
import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Option, Scope, Semaphore } from "effect"
import { WorkflowRuntime, type SchedulingNode } from "@graphagent/core/dag/core/scheduling"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectTable } from "@graphagent/core/project/sql"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionProjector } from "@graphagent/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagDelivery, incompleteRequiredWakeLine } from "@/dag/runtime/delivery"
import { isDisplayOnlyCompletion } from "@/dag/runtime/report-delivery"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ExclusiveRegistry } from "@/session/engine-process"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { mockSessionPrompt } from "../lib/child-runs"
import { reportPartKind, tableSession } from "../lib/dag-session-tables"
import { pollWithTimeout } from "../lib/effect"
import { makeNodeRow } from "./fixtures"
import { transactLayer } from "./fixture/transact"

const DIRECTORY = process.cwd()
const PROJECT_ID = "project-1"
const PARENT = SessionID.make("ses_parent")

describe("isDisplayOnlyCompletion", () => {
  const leaf = (report: boolean): NodeConfig => ({
    id: "final",
    name: "final",
    worker_type: "build",
    depends_on: [],
    prompt_template: { inline: "final" },
    report_to_parent: report,
  })
  const checkpoint: NodeConfig = { ...leaf(true), id: "cp", name: "cp" }
  const config = (nodes: NodeConfig[], deliveryNode: string | null = "final"): WorkflowConfig => ({
    name: "display-only",
    ...(deliveryNode ? { delivery_node: deliveryNode } : {}),
    nodes,
  })
  const completed = (id: string, wakeEligible = false) => makeNodeRow({ id, status: "completed", wakeEligible })

  it("is true only for a delivery node that produced the answer with no other reporting node", () => {
    expect(isDisplayOnlyCompletion(config([leaf(true)]), [completed("final", true)])).toBe(true)
    expect(isDisplayOnlyCompletion(config([leaf(false)]), [completed("final")])).toBe(true)
  })

  it("is false when a reporting checkpoint sits beside the delivery leaf", () => {
    const nodes = config([checkpoint, leaf(false)])
    expect(isDisplayOnlyCompletion(nodes, [completed("cp", true), completed("final")])).toBe(false)
  })

  it("is false when the delivery node has dependents: it is a checkpoint, not a leaf", () => {
    const nodes = config([leaf(true), { ...checkpoint, id: "after", depends_on: ["final"], report_to_parent: false }])
    const rows = [completed("final", true), makeNodeRow({ id: "after", status: "completed", dependsOn: ["final"] })]
    expect(isDisplayOnlyCompletion(nodes, rows)).toBe(false)
  })

  it("is false without a delivery node or when a gate skipped it", () => {
    expect(isDisplayOnlyCompletion(config([leaf(false)], null), [completed("final")])).toBe(false)
    expect(isDisplayOnlyCompletion(config([leaf(false)]), [makeNodeRow({ id: "final", status: "skipped" })])).toBe(
      false,
    )
  })
})

describe("incompleteRequiredWakeLine", () => {
  const lines = ['- "branch" (skipped)']

  it("says a final answer was delivered only when the delivery node produced one", () => {
    const delivered = incompleteRequiredWakeLine(lines, true)
    expect(delivered).toContain("Required nodes not completed (the final answer was delivered)")
    expect(delivered).toContain('- "branch" (skipped)')
    expect(delivered).not.toContain("no final answer was produced")
  })

  it("keeps the no-final-answer note, with its instruction to repair, when none was produced", () => {
    const missing = incompleteRequiredWakeLine(lines, false)
    expect(missing).toContain("Required nodes not completed (no final answer was produced)")
    expect(missing).toContain('- "branch" (skipped)')
    expect(missing).toContain("do not stop while in-scope work remains")
    expect(missing).not.toContain("the final answer was delivered")
  })
})

/**
 * What the model-facing admission does, in the two halves a crash can split.
 * `persist` writes the synthetic wake message and runs the wake mark in one
 * transaction, as `prepareTurn` commits them. `park-before-persist` stops
 * before either, so the process "dies" with nothing of the wake durable.
 * `persist-then-park` dies right after that transaction, before the turn runs.
 */
type Admission = "persist" | "park-before-persist" | "persist-then-park"

interface Control {
  admission: Admission
  /** Admissions that reached the model-facing boundary. */
  admissions: number
  /** The text of each admitted wake prompt. */
  texts: string[]
  /** `Session.get` calls, the DAG mode read included. */
  reads: number
  /** Fails the next `Session.get` once, as a typed error or as a defect. */
  failNextRead?: "typed" | "defect"
}

function userData(created: number): Omit<SessionV1.User, "id" | "sessionID"> {
  return {
    role: "user",
    agent: "build",
    model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
    time: { created },
  }
}

function reply(sessionID: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: DIRECTORY, root: DIRECTORY },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: [{ type: "text", text: "wake handled" }] as never,
  }
}

function graph(control: Control) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const transcript = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
  const automation = ExclusiveRegistry.layer.pipe(Layer.provide(status))
  const session = tableSession({
    onGet: () => {
      control.reads += 1
      const failure = control.failNextRead
      control.failNextRead = undefined
      if (failure === "typed") return Effect.fail(new Error("session store unavailable") as never)
      if (failure === "defect") return Effect.die(new Error("session store unavailable"))
      return Effect.void
    },
  }).pipe(Layer.provide(database))
  const prompt = Layer.unwrap(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return mockSessionPrompt({
        // The report's receipt commits under the idle fence it asks for.
        withIdle: <A, E, R>(_sessionID: SessionID, work: Effect.Effect<A, E, R>) => Effect.map(work, Option.some),
        prepareTurn: ((input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
          Effect.gen(function* () {
            control.admissions += 1
            control.texts.push(input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
            if (control.admission === "park-before-persist") return yield* Effect.never
            const messageID = input.messageID ?? MessageID.ascending()
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx
                    .insert(MessageTable)
                    .values({ id: messageID, session_id: input.sessionID, data: userData(Date.now()) })
                    .run()
                    .pipe(Effect.orDie)
                  for (const part of input.parts) {
                    if (part.type !== "text") continue
                    yield* tx
                      .insert(PartTable)
                      .values({
                        id: part.id ? PartID.make(part.id) : PartID.ascending(),
                        message_id: messageID,
                        session_id: input.sessionID,
                        data: { type: "text" as const, text: part.text, synthetic: part.synthetic },
                      } as never)
                      .run()
                      .pipe(Effect.orDie)
                  }
                  yield* persistAdmission ?? Effect.void
                }),
              )
              .pipe(Effect.orDie)
            if (control.admission === "persist-then-park") return yield* Effect.never
            return Option.some({
              activate: Effect.void,
              result: Effect.succeed(reply(input.sessionID as string)),
              abort: Effect.void,
            })
          })) as never,
      })
    }),
  ).pipe(Layer.provide(database))
  return Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    transcript,
    status,
    dag,
    automation,
    session,
    prompt,
  )
}

/**
 * What the loop keeps for a live workflow, with the runtime in whatever state a test needs. The port is the
 * plain service: the entry's lease token is the loop's business (dag-runner-port.test.ts).
 */
const liveEntry = (nodes: readonly SchedulingNode[], port: Dag.Interface): DagDelivery.Entry => ({
  runtime: new WorkflowRuntime([...nodes], 5),
  evalLock: Semaphore.makeUnsafe(1),
  fibers: new Map(),
  port,
})

function startDelivery(entries: (dagID: string) => DagDelivery.Entry | undefined = () => undefined) {
  return Effect.gen(function* () {
    return yield* DagDelivery.make({
      directory: DIRECTORY,
      projectID: PROJECT_ID,
      scope: yield* Scope.Scope,
      store: yield* DagStore.Service,
      sessions: yield* Session.Service,
      prompts: yield* SessionPrompt.Service,
      status: yield* SessionStatus.Service,
      automation: yield* ExclusiveRegistry.Service,
      database: yield* Database.Service,
      events: yield* EventV2Bridge.Service,
      messages: undefined,
      inbox: undefined,
      entries,
      lastAssistantMessage: () => Effect.succeed(undefined),
    })
  })
}

/** The parent session in the given DAG mode. */
const seedParent = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: PROJECT_ID as never, worktree: DIRECTORY as never, sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: PARENT,
        project_id: PROJECT_ID as never,
        slug: "parent",
        directory: DIRECTORY,
        title: "Parent",
        version: "test",
        dag_mode: mode,
      })
      .run()
      .pipe(Effect.orDie)
  })

/**
 * A workflow whose single delivery leaf completed, written through the engine's
 * own events. The workflow itself is still running: this is the window between
 * the last node's event and the completion check that publishes the terminal one.
 */
const leafDone = (title: string, report: boolean) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const dagID = yield* dag.create({
      projectID: PROJECT_ID,
      sessionID: PARENT,
      title,
      config: {
        name: title,
        delivery_node: "final",
        nodes: [
          {
            id: "final",
            name: "final",
            worker_type: "build",
            depends_on: [],
            required: true,
            prompt_template: { inline: "final" },
            report_to_parent: report,
          },
        ],
      },
    })
    yield* dag.nodeQueued(dagID, "final")
    yield* dag.nodeStarted(dagID, "final", `ses_child_${title}`, Date.now() + 60_000, report)
    yield* dag.nodeCompleted(dagID, "final", `${title} answer`)
    return dagID
  })

/** A completed workflow whose only parent-visible output is its delivery leaf. */
const completedLeaf = (title: string, report: boolean) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const dagID = yield* leafDone(title, report)
    yield* dag.complete(dagID)
    return dagID
  })

const answerParts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const parts = yield* db.select().from(PartTable).all().pipe(Effect.orDie)
  return parts.filter((part) => reportPartKind(part.data) === "answer")
})

const syntheticParts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const parts = yield* db.select().from(PartTable).all().pipe(Effect.orDie)
  return parts.filter((part) => part.id.startsWith("prt_dag_wake_"))
})

const unreported = Effect.gen(function* () {
  const store = yield* DagStore.Service
  return {
    workflows: (yield* store.getUnreportedWakeWorkflows(PARENT)).map((workflow) => workflow.id),
    nodes: (yield* store.getUnreportedWakeNodes(PARENT)).map((row) => `${row.workflowId}/${row.id}`),
  }
})

const instanceRef = { directory: DIRECTORY, worktree: DIRECTORY, project: { id: PROJECT_ID } } as never

const run = <A, E>(
  control: Control,
  body: Effect.Effect<A, E, Scope.Scope | Layer.Success<ReturnType<typeof graph>>>,
) =>
  body.pipe(
    Effect.provide(graph(control)),
    Effect.provideService(InstanceRef, instanceRef),
    Effect.scoped,
    Effect.runPromise,
  )

describe("DagDelivery reads the DAG mode at the terminal boundary", () => {
  for (const failure of ["typed", "defect"] as const) {
    it(`treats a DAG mode it cannot read (${failure}) as off, then follows the row once it can`, () => {
      const control: Control = { admission: "persist", admissions: 0, texts: [], reads: 0 }
      return run(
        control,
        Effect.gen(function* () {
          const store = yield* DagStore.Service
          yield* seedParent("on")
          const delivery = yield* startDelivery()

          // The row says "on", but the one read that decides fails: the
          // report is displayed and the parent gets no turn.
          const first = yield* completedLeaf("first", true)
          control.failNextRead = failure
          yield* delivery.drain(PARENT)
          expect(control.admissions).toBe(0)
          expect(yield* answerParts).toHaveLength(1)
          expect((yield* store.getWorkflow(first))?.wakeReported).toBe(true)
          expect((yield* store.getNode(first, "final"))?.wakeReported).toBe(true)
          expect(yield* unreported).toEqual({ workflows: [], nodes: [] })

          // The same session, read successfully, wakes as "on" does.
          yield* completedLeaf("second", true)
          yield* delivery.drain(PARENT)
          expect(control.admissions).toBe(1)
          expect(yield* answerParts).toHaveLength(2)
          expect(yield* unreported).toEqual({ workflows: [], nodes: [] })
        }),
      )
    })
  }

  it("does not read the DAG mode when no display-only completion is waiting", () => {
    const control: Control = { admission: "persist", admissions: 0, texts: [], reads: 0 }
    return run(
      control,
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        yield* seedParent("on")
        const delivery = yield* startDelivery()
        yield* delivery.drain(PARENT)
        expect(control.reads).toBe(0)

        // A failed workflow owes a turn in either mode; the mode is not consulted.
        const dagID = yield* dag.create({
          projectID: PROJECT_ID,
          sessionID: PARENT,
          title: "Failed",
          config: {
            name: "failed",
            nodes: [
              { id: "work", name: "work", worker_type: "build", depends_on: [], prompt_template: { inline: "work" } },
            ],
          },
        })
        yield* dag.fail(dagID, "required node failed")
        control.reads = 0
        yield* delivery.drain(PARENT)
        expect(control.admissions).toBe(1)
        expect(control.reads).toBe(0)
      }),
    )
  })
})

describe("DagDelivery in DAG mode: a process that dies mid-delivery restarts without duplicates", () => {
  const crashes = [
    {
      name: "after the report receipt, before the wake is admitted",
      admission: "park-before-persist" as const,
      // The restarted process finds the receipt, adopts it, and admits the wake itself.
      admissionsAfterRestart: 2,
    },
    {
      name: "right after the wake was admitted, before its turn ran",
      admission: "persist-then-park" as const,
      // Admission already marked the batch (#321): the restart has nothing left to admit.
      admissionsAfterRestart: 1,
    },
  ]
  for (const crash of crashes) {
    it(crash.name, () => {
      const control: Control = { admission: crash.admission, admissions: 0, texts: [], reads: 0 }
      return run(
        control,
        Effect.gen(function* () {
          const store = yield* DagStore.Service
          yield* seedParent("on")
          const dagID = yield* completedLeaf("leaf", true)

          const first = yield* startDelivery()
          const dying = yield* first.drain(PARENT).pipe(Effect.forkChild)
          yield* pollWithTimeout(
            Effect.sync(() => (control.admissions >= 1 ? true : undefined)),
            "the wake never reached the model-facing admission",
          )
          yield* Fiber.interrupt(dying)
          // The report receipt is durable either way; it was not acknowledged with the wake.
          expect(yield* answerParts).toHaveLength(1)

          control.admission = "persist"
          const second = yield* startDelivery()
          yield* second.drain(PARENT)
          yield* second.drain(PARENT)

          expect(control.admissions).toBe(crash.admissionsAfterRestart)
          expect(yield* answerParts).toHaveLength(1)
          expect(yield* syntheticParts).toHaveLength(1)
          expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(true)
          expect((yield* store.getNode(dagID, "final"))?.wakeReported).toBe(true)
          expect(yield* unreported).toEqual({ workflows: [], nodes: [] })
        }),
      )
    })
  }
})

describe("DagDelivery while a workflow is about to complete (#1015)", () => {
  const windows = [
    { name: "before the loop settled the node", status: "running" },
    { name: "after the loop settled the node", status: "satisfied" },
  ] as const
  for (const window of windows) {
    it(`gives no turn between the last node and the workflow completing (${window.name}), then wakes once`, () => {
      const control: Control = { admission: "persist", admissions: 0, texts: [], reads: 0 }
      return run(
        control,
        Effect.gen(function* () {
          const dag = yield* Dag.Service
          const store = yield* DagStore.Service
          yield* seedParent("on")
          const dagID = yield* leafDone("leaf", true)
          // The node event is durable and the loop has not published the workflow's
          // yet. A drain here (the parent went idle, or the inbox tick fired) must
          // not hand the parent a progress or stalled turn about a workflow that
          // finishes a moment later: the completion owes the only turn.
          const delivery = yield* startDelivery(() =>
            liveEntry([{ id: "final", dependsOn: [], required: true, status: window.status }], dag),
          )
          expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          yield* delivery.drain(PARENT)
          yield* delivery.drain(PARENT)
          expect(control.admissions).toBe(0)
          expect((yield* store.getNode(dagID, "final"))?.wakeReported).toBe(false)
          expect(yield* answerParts).toHaveLength(0)

          yield* dag.complete(dagID)
          yield* delivery.drain(PARENT)
          expect(control.admissions).toBe(1)
          expect(control.texts[0]).toContain("[DAG Workflow completed]")
          expect(control.texts[0]).toContain('Node "final" completed: leaf answer')
          expect(yield* answerParts).toHaveLength(1)
          expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(true)
          expect((yield* store.getNode(dagID, "final"))?.wakeReported).toBe(true)

          yield* delivery.drain(PARENT)
          expect(control.admissions).toBe(1)
        }),
      )
    })
  }

  // ADR-0008 decision 4: failing a stalled workflow is the entry's runner write, so it goes through the entry's port
  // (which carries its lease token) and through nothing else.
  it("fails a stalled workflow through the entry's port: nothing runs, nothing is ready, the work is not done", () => {
    const control: Control = { admission: "persist", admissions: 0, texts: [], reads: 0 }
    return run(
      control,
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        yield* seedParent("on")
        const node = (id: string, report: boolean) => ({
          id,
          name: id,
          worker_type: "build",
          depends_on: [],
          required: true,
          prompt_template: { inline: id },
          report_to_parent: report,
        })
        const dagID = yield* dag.create({
          projectID: PROJECT_ID,
          sessionID: PARENT,
          title: "Stalled",
          config: { name: "stalled", nodes: [node("cp", true), node("work", false)] },
        })
        yield* dag.nodeQueued(dagID, "cp")
        yield* dag.nodeStarted(dagID, "cp", "ses_child_cp", Date.now() + 60_000, true)
        yield* dag.nodeQueued(dagID, "work")
        yield* dag.nodeStarted(dagID, "work", "ses_child_work", Date.now() + 60_000, false)
        yield* dag.nodeCompleted(dagID, "cp", "checkpoint verdict")
        const failures: Array<readonly [string, string]> = []
        const port: Dag.Interface = {
          ...dag,
          fail: (id, reason) =>
            Effect.sync(() => void failures.push([id, reason])).pipe(Effect.andThen(dag.fail(id, reason))),
        }

        const delivery = yield* startDelivery(() =>
          liveEntry(
            [
              { id: "cp", dependsOn: [], required: true, status: "satisfied" },
              // Waits only for a skipped node: not ready, not running, not done, until the cascade skips it.
              { id: "gate", dependsOn: [], required: true, status: "skipped" },
              { id: "work", dependsOn: ["gate"], required: true, status: "pending" },
            ],
            port,
          ),
        )
        yield* delivery.drain(PARENT)

        expect(failures).toEqual([[dagID, "orchestrator_unresponsive"]])
        expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
      }),
    )
  })

  it("still delivers a checkpoint's progress turn while a sibling node keeps running", () => {
    const control: Control = { admission: "persist", admissions: 0, texts: [], reads: 0 }
    return run(
      control,
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        yield* seedParent("on")
        const node = (id: string, report: boolean) => ({
          id,
          name: id,
          worker_type: "build",
          depends_on: [],
          required: true,
          prompt_template: { inline: id },
          report_to_parent: report,
        })
        const dagID = yield* dag.create({
          projectID: PROJECT_ID,
          sessionID: PARENT,
          title: "Checkpoint",
          config: { name: "checkpoint", nodes: [node("cp", true), node("work", false)] },
        })
        yield* dag.nodeQueued(dagID, "cp")
        yield* dag.nodeStarted(dagID, "cp", "ses_child_cp", Date.now() + 60_000, true)
        yield* dag.nodeQueued(dagID, "work")
        yield* dag.nodeStarted(dagID, "work", "ses_child_work", Date.now() + 60_000, false)
        yield* dag.nodeCompleted(dagID, "cp", "checkpoint verdict")

        const delivery = yield* startDelivery(() =>
          liveEntry(
            [
              { id: "cp", dependsOn: [], required: true, status: "satisfied" },
              { id: "work", dependsOn: [], required: true, status: "running" },
            ],
            dag,
          ),
        )
        yield* delivery.drain(PARENT)
        expect(control.admissions).toBe(1)
        expect(control.texts[0]).toContain('Node "cp" completed: checkpoint verdict')
        expect((yield* store.getNode(dagID, "cp"))?.wakeReported).toBe(true)
        expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(false)
      }),
    )
  })
})
