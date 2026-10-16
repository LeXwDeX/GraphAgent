import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer, Scope } from "effect"
import { Config } from "@/config/config"
import { GoalLoop } from "@/goal/loop"
import { DagLoop } from "@/dag/runtime/loop"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { Service } from "./bootstrap-service"
import { Memory } from "@/memory/memory"

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
    const dagLoop = yield* DagLoop.Service
    const dagPublisher = yield* DagSummaryPublisher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const scope = yield* Scope.Scope

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // These services own any internal background work; bootstrap awaits their
      // lightweight initialization. MEMORY stays synchronous internally, so
      // bootstrap explicitly schedules it below on the instance scope.
      const initTargets: { init: () => Effect.Effect<void, unknown> }[] = [
        lsp,
        shareNext,
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
      yield* dagLoop.init().pipe(Effect.catchCause((cause) => Effect.logWarning("dag loop init failed", { cause })))
      // DagSummaryPublisher: same lifecycle pattern. Stateless derived-view
      // publisher that pushes per-session workflow summaries to the TUI.
      yield* dagPublisher
        .init()
        .pipe(Effect.catchCause((cause) => Effect.logWarning("dag summary publisher init failed", { cause })))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    DagLoop.defaultLayer,
    DagSummaryPublisher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export const node = LayerNode.make(layer, [
  Config.node,
  DagLoop.node,
  DagSummaryPublisher.node,
  Format.node,
  LSP.node,
  Plugin.node,
  Project.node,
  ShareNext.node,
  Snapshot.node,
  Vcs.node,
  Memory.node,
])

export * as InstanceBootstrap from "./bootstrap"
