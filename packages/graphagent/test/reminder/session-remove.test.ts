// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionProjector } from "@graphagent/core/session/projector"
import { Effect } from "effect"
import { Lifecycle } from "@/lifecycle/service"
import { ReminderClock } from "@/reminder/clock"
import { MessageV2 } from "@/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { testEffect } from "../lib/effect"
import { insertReminder, readReminder } from "./reminder.fixture"

/**
 * #1072: a reminder follows its session. Deleting the session through the real
 * session service removes its reminders with it, whatever state they are in,
 * and leaves another session's reminders alone. Nothing is retired by hand:
 * the cascade is the table's own foreign key.
 */

const clockNode = LayerNode.make(ReminderClock.layer, [Database.node, Lifecycle.node])
const it = testEffect(
  LayerNode.buildLayer(
    LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node, Database.node, Lifecycle.node, clockNode]),
  ),
)

describe("reminder session deletion", () => {
  it.instance("deleting a session deletes its reminders, in every state, and only its own", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const clock = yield* ReminderClock.Service
      // `it.instance` runs on the live clock: the reminders are an hour away, so none is due during the test.
      const later = Date.now() + 60 * 60_000
      const doomed = yield* sessions.create({ title: "doomed" })
      const survivor = yield* sessions.create({ title: "survivor" })

      const scheduled = yield* clock.create({ sessionID: doomed.id, text: "scheduled", fireAt: later })
      const repeating = yield* clock.create({
        sessionID: doomed.id,
        text: "repeating",
        fireAt: later + 60_000,
        everyMs: 3_600_000,
      })
      const kept = yield* clock.create({ sessionID: survivor.id, text: "kept", fireAt: later })
      // One that is already owed: the session is deleted while a notice is waiting for its turn boundary.
      yield* insertReminder({ id: "rmd_owed_then_deleted", session_id: doomed.id, status: "due", fire_at: 1_000 })

      yield* sessions.remove(doomed.id)

      for (const id of [scheduled.id, repeating.id, "rmd_owed_then_deleted"])
        expect(yield* readReminder(id), id).toBeUndefined()
      expect(yield* readReminder(kept.id)).toMatchObject({ status: "scheduled", session_id: survivor.id })
      // Nothing of the deleted session is listed or owed any more; the survivor keeps its reminder.
      expect(yield* clock.list(doomed.id)).toEqual([])
      expect((yield* clock.list(survivor.id)).map((info) => info.id)).toEqual([kept.id])
      // A clock pass over what is left finds nothing to move and does not trip over the deleted rows.
      expect(yield* clock.promoteOnce()).toBe(0)
    }),
  )
})
