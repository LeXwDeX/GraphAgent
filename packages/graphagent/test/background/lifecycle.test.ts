// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { BackgroundJob } from "@/background/job"
import { BackgroundLifecycle } from "@/background/lifecycle"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ref } from "@graphagent/core/lifecycle/state"
import { Effect, Layer, Option } from "effect"
import { testEffect } from "../lib/effect"

/**
 * #1069 P7: the job-domain resolver must expose the live registry through
 * `Lifecycle.get` without becoming a second state store.
 */

const job = (id: string, status: BackgroundJob.Status): BackgroundJob.Info =>
  ({ id, type: "test", status, started_at: 0 }) as BackgroundJob.Info

const jobs = Layer.mock(BackgroundJob.Service, {
  get: (id) =>
    Effect.succeed(
      id === "job_running"
        ? job(id, "running")
        : id === "job_done"
          ? job(id, "completed")
          : id === "job_failed"
            ? job(id, "error")
            : undefined,
    ),
})

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))

const base = Layer.mergeAll(database, events, bridge, jobs, Lifecycle.layer.pipe(Layer.provide(bridge)))

const it = testEffect(Layer.mergeAll(base, BackgroundLifecycle.layer.pipe(Layer.provide(base))))

describe("background lifecycle resolver", () => {
  it.live("reports a live job as non-terminal running state", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const observed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_running")))
      expect(observed?.value).toBe("running")
      expect(observed?.phase).toBe("running")
      expect(observed?.terminal).toBe(false)
      expect(observed?.source).toBe("live")
    }),
  )

  it.live("reports terminal jobs with their vocabulary phase", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const completed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_done")))
      expect(completed?.value).toBe("completed")
      expect(completed?.phase).toBe("succeeded")
      expect(completed?.terminal).toBe(true)
      const failed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_failed")))
      expect(failed?.phase).toBe("failed")
      expect(failed?.terminal).toBe(true)
    }),
  )

  it.live("returns none for a job the registry no longer holds", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      expect(Option.isNone(yield* lifecycle.get(ref("job", "job_missing")))).toBe(true)
    }),
  )
})
