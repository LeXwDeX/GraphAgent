import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventResidueSweep } from "@opencode-ai/core/event/residue-sweep"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Option } from "effect"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

// #524 wiring regression: the default-on event residue sweep must reach every
// serving process. Mirrors httpapi-sweep-wiring.test.ts — the desktop sidecar
// and headless serve build this app node graph without AppLayer, so listing
// EventResidueSweep.node here (not just app-runtime.ts) is what makes the
// startup pass run on those paths.

const appIt = testEffect(
  Layer.mergeAll(LayerNode.buildLayer(HttpApiApp.app), CrossSpawnSpawner.defaultLayer),
)

describe("server app graph event residue sweep wiring", () => {
  appIt.instance("exposes EventResidueSweep.Service in the serving context", () =>
    Effect.gen(function* () {
      const sweep = yield* Effect.serviceOption(EventResidueSweep.Service)
      expect(Option.isSome(sweep)).toBe(true)
    }),
  )
})
