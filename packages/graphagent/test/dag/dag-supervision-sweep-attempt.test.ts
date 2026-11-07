// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// Regression: DagSupervisionSweep settles a frozen node with the execution
// attempt it observed (replan counter + child session). The row it judged
// frozen was read by an earlier SELECT; the sweep then yields (config read,
// cancel of the old child, location lookup) before the write. If the parent
// restarts that node and the new attempt starts in that window, the attempt
// guard must reject the stale verdict instead of failing the FRESH attempt
// with "deadline supervision lost" while its child keeps running.
import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag } from "@/dag/dag"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionAutomationLease } from "@/session/automation-lease"
import { SessionStatus } from "@/session/status"

describe("DagSupervisionSweep attempt identity", () => {
  it("does not fail a new attempt that started after the sweep observed the frozen one", async () => {
    const hook: { onCancel?: (sessionID: string) => Effect.Effect<void> } = {}
    const cancels: string[] = []
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
    const store = DagStore.layer.pipe(Layer.provide(database))
    const status = SessionStatus.layer.pipe(Layer.provide(bridge))
    const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
    const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
    const prompt = Layer.mock(SessionPrompt.Service, {
      cancel: (sessionID: string) =>
        Effect.suspend(() => {
          cancels.push(sessionID)
          const run = hook.onCancel
          hook.onCancel = undefined
          return run ? run(sessionID) : Effect.void
        }),
    } as never)
    const sweepLayer = DagSupervisionSweep.layerWithoutDeps.pipe(
      Layer.provide(base),
      Layer.provide(prompt),
      Layer.provide(SessionAutomationLease.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database.Service
        const dagSvc = yield* Dag.Service
        const storeSvc = yield* DagStore.Service
        const sweep = yield* DagSupervisionSweep.Service
        yield* db.db
          .insert(ProjectTable)
          .values({ id: "project-1" as never, worktree: process.cwd() as never, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db.db
          .insert(SessionTable)
          .values({
            id: "ses_parent" as never,
            project_id: "project-1" as never,
            slug: "p",
            directory: process.cwd() as never,
            title: "P",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        // No DagLoop: drive the durable lifecycle by hand. One node whose
        // attempt #0 (child ses_old) is running past its deadline with no
        // live watcher (instance gone) — exactly what the sweep targets.
        const dagID = yield* dagSvc.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "sweep",
          config: {
            name: "sweep",
            nodes: [
              {
                id: "n1",
                name: "n1",
                worker_type: "build",
                depends_on: [],
                required: false,
                prompt_template: { inline: "x" },
                worker_config: { timeout_ms: 1_000 },
              },
            ],
          },
        })
        const past = Date.now() - 5_000
        yield* dagSvc.nodeQueued(dagID, "n1", past)
        yield* dagSvc.nodeStarted(dagID, "n1", "ses_old", past)

        // Cancellation must not discard a defect merely because the same
        // Cause also contains an interruption.
        hook.onCancel = () => Effect.failCause(Cause.combine(Cause.interrupt(42), Cause.die("cancel defect")))
        const needed = DagSupervisionSweep.frozenTicksNeeded(1_000)
        let cancellationExit: Exit.Exit<void> = Exit.void
        for (let tick = 0; tick <= needed; tick++) {
          cancellationExit = yield* Effect.exit(sweep.sweepOnce())
          if (Exit.isFailure(cancellationExit)) break
        }
        expect(Exit.isFailure(cancellationExit)).toBe(true)
        if (Exit.isFailure(cancellationExit)) {
          expect(Cause.hasInterrupts(cancellationExit.cause)).toBe(true)
          expect(Cause.hasDies(cancellationExit.cause)).toBe(true)
        }

        // While the sweep is settling (between its SELECT and its write), the
        // parent restarts n1 and the replacement attempt starts with child
        // ses_new and a fresh deadline.
        hook.onCancel = () =>
          Effect.gen(function* () {
            yield* dagSvc.nodeRestarted(dagID, "n1", "ses_old")
            yield* dagSvc.nodeQueued(dagID, "n1", Date.now() + 600_000)
            yield* dagSvc.nodeStarted(dagID, "n1", "ses_new", Date.now() + 600_000)
          }).pipe(Effect.orDie)

        for (let tick = 0; tick <= needed; tick++) yield* sweep.sweepOnce()

        expect(cancels).toEqual(["ses_old", "ses_old"])
        const row = yield* storeSvc.getNode(dagID, "n1")
        // The fresh attempt (ses_new, replanAttempts 1) keeps running, and only
        // the observed attempt's child was cancelled.
        expect({
          status: row?.status,
          child: row?.childSessionId,
          replanAttempts: row?.replanAttempts,
          reason: row?.errorReason ?? null,
        }).toEqual({ status: "running", child: "ses_new", replanAttempts: 1, reason: null })
        void Option
      }).pipe(
        Effect.provide(Layer.merge(base, sweepLayer)),
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
