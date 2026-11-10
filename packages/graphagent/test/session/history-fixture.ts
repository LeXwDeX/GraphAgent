// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { testEffect } from "../lib/effect"

export const historyLayers = LayerNode.buildLayer(
  LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node]),
)

export const historyEffect = testEffect(historyLayers)

/** Session-backed transcript fixture with monotonically increasing timestamps. */
export const makeFixture = (sessionID: SessionID) => {
  let clock = 1_000
  const tick = () => clock++

  const user = (text?: string, opts?: { consumed?: number; ignored?: boolean }) =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const id = MessageID.ascending()
      yield* session.updateMessage({
        id,
        sessionID,
        role: "user",
        time: { created: tick(), ...(opts?.consumed !== undefined ? { consumed: opts.consumed } : {}) },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } as unknown as SessionV1.Info)
      if (text !== undefined)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text,
          ...(opts?.ignored !== undefined ? { ignored: opts.ignored } : {}),
        })
      return id
    })

  const assistant = (
    parentID: MessageID,
    opts?: { summary?: boolean; finish?: string; error?: SessionV1.Assistant["error"] },
  ) =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const id = MessageID.ascending()
      yield* session.updateMessage({
        id,
        sessionID,
        role: "assistant",
        time: { created: tick() },
        parentID,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "",
        agent: "default",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        summary: opts?.summary,
        finish: opts?.finish,
        error: opts?.error,
      } as unknown as SessionV1.Info)
      return id
    })

  const marker = (tail?: MessageID, id?: MessageID) =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const messageID = id ?? MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID,
        role: "user",
        time: { created: tick() },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID,
        type: "compaction",
        auto: true,
        tail_start_id: tail,
      } as never)
      return messageID
    })

  return { user, assistant, marker }
}

/** Services the session-backed fixture bodies may require under `historyLayers`. */
export type HistoryEnv = SessionNs.Service | Database.Service | Scope.Scope

export const withSession = <A, E>(
  fn: (input: { sessionID: SessionID; f: ReturnType<typeof makeFixture> }) => Effect.Effect<A, E, HistoryEnv>,
): Effect.Effect<A, E, HistoryEnv> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id, f: makeFixture(created.id) }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )