// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cancelSessionJobs } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(BackgroundJob.defaultLayer)

describe("background.cancel", () => {
  it.instance("cancels descendants and keeps jobs marked to survive session cancel", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessionID = SessionID.create()
      yield* jobs.start({
        id: "cancel-root",
        type: "test",
        metadata: { sessionId: sessionID },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "cancel-child",
        type: "test",
        metadata: { sessionId: "cancel-root" },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "cancel-survivor",
        type: "test",
        metadata: { sessionId: sessionID, survivesSessionCancel: true },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "cancel-other",
        type: "test",
        metadata: { sessionId: "elsewhere" },
        run: Effect.never,
      })

      yield* cancelSessionJobs(jobs, sessionID)

      expect((yield* jobs.get("cancel-root"))?.status).toBe("cancelled")
      expect((yield* jobs.get("cancel-child"))?.status).toBe("cancelled")
      expect((yield* jobs.get("cancel-survivor"))?.status).toBe("running")
      expect((yield* jobs.get("cancel-other"))?.status).toBe("running")
    }),
  )

  it.instance("local cleanup skips jobs registered with session cancellation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessionID = SessionID.create()
      yield* jobs.start({
        id: "coordinated",
        type: "test",
        metadata: { sessionId: sessionID },
        run: Effect.never,
      })

      yield* cancelSessionJobs(jobs, sessionID, true)
      expect((yield* jobs.get("coordinated"))?.status).toBe("running")

      yield* cancelSessionJobs(jobs, sessionID)
      expect((yield* jobs.get("coordinated"))?.status).toBe("cancelled")
    }),
  )
})
