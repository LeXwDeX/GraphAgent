// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { ref } from "@graphagent/core/lifecycle/state"
import { Effect, Layer, Option } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { Lifecycle } from "@/lifecycle/service"
import type { InstanceContext } from "@/project/instance-context"
import { ReminderLifecycle } from "@/reminder/lifecycle"
import { testEffect } from "../lib/effect"
import { base, insertReminder, seedSession } from "./reminder.fixture"

/**
 * #1072: the reminder resolver answers from the durable row, scoped to the
 * directory that owns the reminder's session. The clock keeps no other state,
 * so there is no live entry to prefer.
 */

const it = testEffect(Layer.mergeAll(base, ReminderLifecycle.layer.pipe(Layer.provide(base))))

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the resolver reads only the directory.
const own = { directory: "/own" } as unknown as InstanceContext
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the resolver reads only the directory.
const other = { directory: "/other" } as unknown as InstanceContext

const read = (id: string, instance: InstanceContext) =>
  Effect.gen(function* () {
    const lifecycle = yield* Lifecycle.Service
    return yield* lifecycle.get(ref("reminder", id)).pipe(Effect.provideService(InstanceRef, instance))
  })

describe("reminder lifecycle resolver", () => {
  it.live("answers from the durable row with the vocabulary phase", () =>
    Effect.gen(function* () {
      const sessionID = yield* seedSession("ses_remlife_own", "/own")
      yield* insertReminder({ id: "rmd_scheduled", session_id: sessionID, status: "scheduled" })
      yield* insertReminder({ id: "rmd_due", session_id: sessionID, status: "due" })

      expect(Option.getOrUndefined(yield* read("rmd_scheduled", own))).toMatchObject({
        domain: "reminder",
        id: "rmd_scheduled",
        value: "scheduled",
        phase: "pending",
        terminal: false,
        settled: false,
        source: "persisted",
      })
      expect(Option.getOrUndefined(yield* read("rmd_due", own))).toMatchObject({
        value: "due",
        phase: "settling",
        terminal: false,
        settled: false,
      })
    }),
  )

  it.live("reports terminal values with their terminal and settled flags", () =>
    Effect.gen(function* () {
      const sessionID = yield* seedSession("ses_remlife_terminal", "/own")
      yield* insertReminder({ id: "rmd_delivered", session_id: sessionID, status: "delivered" })
      yield* insertReminder({ id: "rmd_cancelled", session_id: sessionID, status: "cancelled" })

      expect(Option.getOrUndefined(yield* read("rmd_delivered", own))).toMatchObject({
        phase: "succeeded",
        terminal: true,
        settled: true,
      })
      expect(Option.getOrUndefined(yield* read("rmd_cancelled", own))).toMatchObject({
        phase: "cancelled",
        terminal: true,
        settled: false,
      })
    }),
  )

  it.live("hides a reminder whose session belongs to another directory", () =>
    Effect.gen(function* () {
      const sessionID = yield* seedSession("ses_remlife_foreign", "/other")
      yield* insertReminder({ id: "rmd_foreign", session_id: sessionID })

      expect(Option.isNone(yield* read("rmd_foreign", own))).toBe(true)
      expect(Option.isSome(yield* read("rmd_foreign", other))).toBe(true)
    }),
  )

  it.live("treats a row with an unknown status as no state instead of failing the read", () =>
    Effect.gen(function* () {
      const sessionID = yield* seedSession("ses_remlife_odd", "/own")
      yield* insertReminder({ id: "rmd_odd", session_id: sessionID, status: "archived" })
      expect(Option.isNone(yield* read("rmd_odd", own))).toBe(true)
    }),
  )

  it.live("returns none for a reminder that does not exist", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* read("rmd_missing", own))).toBe(true)
    }),
  )
})
