// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Effect, Layer, Option } from "effect"
import { HookRewake } from "@/hook/rewake"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { SessionInbox } from "@/session/inbox"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// PR4 regression: rewake delivery now resolves SessionInbox via serviceOption
// from the request-time ambient context. LayerNode dependency arrays only build
// services via Layer.provide and never re-export them (the same failure class
// as the Memory wiring regression in #311), so SessionInbox.node must be a
// graph-level member of the server app. If it is dropped, HookRewakeLive's
// `if (!inbox) return` silently discards every async Stop rewake — no test
// would otherwise fail, because every consumer resolves the service optionally.

const appLayer = LayerNode.buildLayer(HttpApiApp.app)

const appIt = testEffect(Layer.mergeAll(appLayer, CrossSpawnSpawner.defaultLayer))

describe("server app graph inbox wiring", () => {
  appIt.instance(
    "exposes SessionInbox.Service in the ambient context hook rewake runs in",
    () =>
      Effect.gen(function* () {
        const inbox = yield* Effect.serviceOption(SessionInbox.Service)
        expect(Option.isSome(inbox)).toBe(true)
      }),
    { git: true },
  )

  const submitCalls: { source: string; sessionID: string; item: unknown }[] = []
  // Same node graph with SessionInbox.node swapped for a recorder: proves the
  // live rewake implementation reaches the app-graph inbox instance rather
  // than silently returning on a missing service.
  const spyIt = testEffect(
    Layer.mergeAll(
      LayerNode.buildLayer(HttpApiApp.app, {
        replacements: [
          LayerNode.replace(
            SessionInbox.node,
            Layer.mock(SessionInbox.Service, {
              submit: (sourceID, sessionID, item) =>
                Effect.sync(() => {
                  submitCalls.push({ source: sourceID, sessionID, item })
                  return { state: "pending" as const }
                }),
            }),
          ),
        ],
      }),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  spyIt.instance(
    "delivers an async rewake through the app graph's inbox submit port",
    () =>
      Effect.gen(function* () {
        submitCalls.length = 0
        const rewake = yield* HookRewake.Service
        yield* rewake.rewake({
          sessionID: SessionID.make("ses-inbox-wiring"),
          text: "wiring rewake",
          rewakeToken: { epoch: 1, generation: 2 },
        })

        expect(submitCalls).toHaveLength(1)
        expect(submitCalls[0].source).toBe("hook.rewake")
        expect(submitCalls[0].sessionID).toBe("ses-inbox-wiring")
        expect(submitCalls[0].item).toEqual({
          prompt: { parts: [{ type: "text", text: "wiring rewake" }] },
          admissionOptions: { continueToolBudget: true, rewakeToken: { epoch: 1, generation: 2 } },
        })
      }),
    { git: true },
  )
})