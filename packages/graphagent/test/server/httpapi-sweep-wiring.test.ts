import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Option } from "effect"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

// Issue #341 regression: the host-level deadline supervision sweep (response
// to the 2026-08-18 orphaned-nodes incident) was constructed only in AppLayer.
// The desktop sidecar calls Server.listen without effectCmd, so AppLayer never
// existed there — the sweep never ran on the desktop default path. Any process
// that serves HTTP builds the server app graph exactly once per listener, so
// listing DagSupervisionSweep.node there covers serve/web/TUI/sidecar alike.

const appIt = testEffect(
  Layer.mergeAll(LayerNode.buildLayer(HttpApiApp.app), CrossSpawnSpawner.defaultLayer),
)

describe("server app graph supervision sweep wiring", () => {
  appIt.instance("exposes DagSupervisionSweep.Service in the serving context", () =>
    Effect.gen(function* () {
      const sweep = yield* Effect.serviceOption(DagSupervisionSweep.Service)
      expect(Option.isSome(sweep)).toBe(true)
    }),
  )

  // The real graph now forks a live sweep fiber (per-listener scope). A
  // recorder replacement proves the app graph resolves THIS node's output —
  // i.e. the sidecar's Server.listen path reaches the sweep construction —
  // without depending on tick timing.
  const sweepInits: number[] = []
  const spyIt = testEffect(
    Layer.mergeAll(
      LayerNode.buildLayer(HttpApiApp.app, {
        replacements: [
          LayerNode.replace(
            DagSupervisionSweep.node,
            Layer.mock(DagSupervisionSweep.Service, {
              sweepOnce: () =>
                Effect.sync(() => {
                  sweepInits.push(sweepInits.length)
                }),
            }),
          ),
        ],
      }),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  spyIt.instance("resolves DagSupervisionSweep.Service from the app-graph output", () =>
    Effect.gen(function* () {
      const sweep = yield* Effect.serviceOption(DagSupervisionSweep.Service)
      expect(Option.isSome(sweep)).toBe(true)
      if (Option.isNone(sweep)) return
      yield* sweep.value.sweepOnce()
      expect(sweepInits.length).toBeGreaterThanOrEqual(1)
    }),
  )
})
