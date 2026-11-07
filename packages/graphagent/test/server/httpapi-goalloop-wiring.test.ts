import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Option } from "effect"
import { GoalLoop } from "@/goal/loop"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

// Issue #340 regression: standing goals stalled after their first turn on
// headless serve/web, the desktop sidecar, and non-CWD TUI directories.
// GoalLoop's only consumer is InstanceBootstrap's
// `serviceOption(GoalLoop.Service).init()` (idle-event subscription + startup
// goal scan), which runs in the request fiber's ambient context. GoalLoop.node
// was listed only in AppLayer, so the service was absent from the server app
// graph and bootstrap silently skipped goal arming. These tests build the
// exact node graph the server provides to route handlers and assert the
// service is present there.

const appLayer = LayerNode.buildLayer(HttpApiApp.app)

const appIt = testEffect(Layer.mergeAll(appLayer, CrossSpawnSpawner.defaultLayer))

describe("server app graph goal loop wiring", () => {
  appIt.instance("exposes GoalLoop.Service in the ambient context bootstrap runs in", () =>
    Effect.gen(function* () {
      const goalLoop = yield* Effect.serviceOption(GoalLoop.Service)
      expect(Option.isSome(goalLoop)).toBe(true)
    }),
  )

  // The init seam resolves through the app-graph output (not a per-consumer
  // dependency scope): a recorder replacement proves both that serviceOption
  // resolves THIS instance and that the harness's instance bootstrap reaches
  // GoalLoop.init() from the request-fiber ambient context (the #340 bug was
  // exactly that call being a silent no-op).
  const initCalls: number[] = []
  const spyIt = testEffect(
    Layer.mergeAll(
      LayerNode.buildLayer(HttpApiApp.app, {
        replacements: [
          LayerNode.replace(
            GoalLoop.node,
            Layer.mock(GoalLoop.Service, {
              init: () =>
                Effect.sync(() => {
                  initCalls.push(initCalls.length)
                }),
            }),
          ),
        ],
      }),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  spyIt.instance("bootstrap's serviceOption path reaches GoalLoop.init()", () =>
    Effect.gen(function* () {
      // The test harness performs an instance bootstrap while building this
      // context; before the fix that bootstrap found GoalLoop absent and
      // silently skipped init.
      expect(initCalls.length).toBeGreaterThan(0)
      initCalls.length = 0
      const goalLoop = yield* Effect.serviceOption(GoalLoop.Service)
      expect(Option.isSome(goalLoop)).toBe(true)
      if (Option.isNone(goalLoop)) return
      yield* goalLoop.value.init()
      expect(initCalls).toEqual([0])
    }),
  )
})
