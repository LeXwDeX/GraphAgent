// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionProjector } from "@graphagent/core/session/projector"
import { Effect, Layer } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { PrWatchPoller } from "@/pr-watch/poller"
import { testEffect } from "../lib/effect"

/**
 * #1071: deleting a session retires its durable PR watches through the
 * process-level poller, so no watch keeps reading the forge and no notice
 * stays owed to a session that no longer exists. The poller is a stub here:
 * its own retirement behavior is covered by pr-watch/poller.test.ts.
 */

const retired: string[] = []

const pollerLayer = Layer.succeed(
  PrWatchPoller.Service,
  PrWatchPoller.Service.of({
    register: () => Effect.die(new Error("register is not used by this test")),
    query: () => Effect.succeed([]),
    cancel: () => Effect.succeed(undefined),
    retireSession: (sessionID) =>
      Effect.sync(() => {
        retired.push(sessionID)
        return 1
      }),
    pollOnce: () => Effect.succeed(0),
    recoverOnce: () => Effect.succeed(0),
    init: () => Effect.void,
  }),
)

const sessions = LayerNode.buildLayer(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node]))
const it = testEffect(Layer.mergeAll(sessions, pollerLayer))

describe("pr_watch session deletion", () => {
  it.instance("retires the session's watches before the session row goes away", () =>
    Effect.gen(function* () {
      retired.length = 0
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "pr watch removal" })
      yield* session.remove(created.id)
      expect(retired).toEqual([created.id])
    }),
  )
})