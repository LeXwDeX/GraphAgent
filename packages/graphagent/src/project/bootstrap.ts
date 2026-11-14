import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Database } from "@graphagent/core/database/database"
import { ProviderAdapters } from "@/provider/adapter/registry"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Scope } from "effect"
import { Config } from "@/config/config"
import { GoalLoop } from "@/goal/loop"
import { DagLoop } from "@/dag/runtime/loop"
import { DagNodePublisher } from "@/dag/runtime/node-publisher"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { Service } from "./bootstrap-service"
import { Memory } from "@/memory/memory"
import { SessionInbox } from "@/session/inbox"
import { Turns } from "@/session/turns"
import { ChildRuns } from "@/session/child/run"
import { ChildResults } from "@/session/child/result-source"
import { PrWatchSource } from "@/pr-watch/source"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    //
    // GoalLoop is intentionally NOT yielded here: it pulls heavyweight transitive
    // deps (Provider/SessionPrompt → HttpClient) that don't belong in bootstrap's
    // construction context. It is resolved lazily via serviceOption in `run`,
    // mirroring how SettingsHook consumers treat their optional dep.
    // (GoalLoop.defaultLayer still appears in BootstrapLayer — bootstrap-runtime.ts —
    // purely so bootstrap-built entry points can serviceOption it; no bootstrap
    // caller invokes its init, and the shared memoMap dedups construction.)
    const config = yield* Config.Service
    const database = yield* Effect.serviceOption(Database.Service)
    const dagLoop = yield* DagLoop.Service
    const dagPublisher = yield* DagSummaryPublisher.Service
    const dagNodePublisher = yield* DagNodePublisher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const adapters = yield* Effect.serviceOption(ProviderAdapters.Service)
    const project = yield* Project.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const scope = yield* Scope.Scope

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // Turn rows from a previous process cannot still be running. Settle them
      // before any new admission in this instance can observe `running`. Child
      // runs follow the same rule: a run whose runner is gone must not keep
      // its child session busy (the active-run unique index) for a driver that
      // no longer exists.
      if (database._tag === "Some") {
        yield* Turns.recover(database.value).pipe(
          Effect.catchCause((cause) => Effect.logWarning("session turn recovery failed", { cause })),
        )
        yield* ChildRuns.recover(database.value).pipe(
          Effect.catchCause((cause) => Effect.logWarning("child run recovery failed", { cause })),
        )
      }
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Provider adapters own per-instance construction and must initialize before other services.
      if (adapters._tag === "Some") yield* adapters.value.init()
      // These services own any internal background work; bootstrap awaits their
      // lightweight initialization. MEMORY stays synchronous internally, so
      // bootstrap explicitly schedules it below on the instance scope.
      const initTargets: { init: () => Effect.Effect<void, unknown> }[] = [
        lsp,
        format,
        vcs,
        snapshot,
        project,
      ]
      yield* Effect.forEach(
        initTargets,
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      const memory = yield* Effect.serviceOption(Memory.Service)
      if (memory._tag === "Some") {
        yield* memory.value.init().pipe(
          Effect.catchCause((cause) => Effect.logWarning("memory init failed", { cause })),
          Effect.forkIn(scope),
        )
      }
      // GoalLoop is provided by AppLayer (provideMerge). Activate its idle-event
      // subscription only when available; skipped in test/standalone contexts.
      const goalLoop = yield* Effect.serviceOption(GoalLoop.Service)
      if (goalLoop._tag === "Some") {
        yield* goalLoop.value
          .init()
          .pipe(Effect.catchCause((cause) => Effect.logWarning("goal loop init failed", { cause })))
      }
      // SessionInbox owns the single per-instance idle subscription and the
      // process-level nudge route. init registers this instance's route and
      // arms the 30s durable tick; GoalLoop.init registered its source.
      const inbox = yield* Effect.serviceOption(SessionInbox.Service)
      if (inbox._tag === "Some") {
        // The result ledger of detached child runs (#1026). After the recovery above, so the startup
        // delivery also tells parents about the runs recovery just ended; skipped where the app layer is absent.
        if (database._tag === "Some")
          yield* ChildResults.init({ inbox: inbox.value, database: database.value, scope }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("child result source init failed", { cause })),
          )
        // Forge outcome notices (#1071 PR3): the deliverable half of the durable
        // `pr_watch` rows the process-level poller writes. Registered before the
        // inbox arms its tick so the startup scan's drains are backed by it.
        if (database._tag === "Some")
          yield* PrWatchSource.init({ inbox: inbox.value, database: database.value, scope }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("pr watch source init failed", { cause })),
          )
        yield* inbox.value
          .init()
          .pipe(Effect.catchCause((cause) => Effect.logWarning("session inbox init failed", { cause })))
      }
      yield* dagLoop.init().pipe(Effect.catchCause((cause) => Effect.logWarning("dag loop init failed", { cause })))
      // DagSummaryPublisher: same lifecycle pattern. Stateless derived-view
      // publisher that pushes per-session workflow summaries to the TUI.
      yield* dagPublisher
        .init()
        .pipe(Effect.catchCause((cause) => Effect.logWarning("dag summary publisher init failed", { cause })))
      // DagNodePublisher: incremental per-workflow node rows on the same
      // ephemeral GlobalBus channel as the summary push.
      yield* dagNodePublisher
        .init()
        .pipe(Effect.catchCause((cause) => Effect.logWarning("dag node publisher init failed", { cause })))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    Database.defaultLayer,
    DagLoop.defaultLayer,
    DagSummaryPublisher.defaultLayer,
    DagNodePublisher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Project.defaultLayer,
      Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Database.node,
  DagLoop.node,
  DagSummaryPublisher.node,
  DagNodePublisher.node,
  Format.node,
  LSP.node,
  Project.node,
  Snapshot.node,
  Vcs.node,
  Memory.node,
])

export * as InstanceBootstrap from "./bootstrap"
