// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { BackgroundResult, TaskIndexEntry } from "../../src/context/session-summary"
import {
  backgroundElapsed,
  backgroundItems,
  backgroundStatus,
  isActive,
  type BackgroundItem,
  type BackgroundJob,
  type BackgroundStatus,
  type BackgroundSummary,
} from "../../src/session/background"

const ROOT = "ses_root"

function entry(overrides: Partial<TaskIndexEntry> = {}): TaskIndexEntry {
  return { parentSessionID: ROOT, parentMessageID: "msg_1", partID: "prt_1", background: true, ...overrides }
}

function result(overrides: Partial<BackgroundResult> = {}): BackgroundResult {
  return {
    status: "completed",
    title: "Scan",
    startedAt: 1_000,
    endedAt: 5_000,
    messageID: "msg_r",
    partID: "prt_r",
    ...overrides,
  }
}

const job = (value: string, reason?: string): BackgroundJob => ({ value, reason })
const summary = (status: BackgroundSummary["status"], toolCalls?: number): BackgroundSummary => ({ status, toolCalls })

describe("backgroundStatus: the result", () => {
  test("the status the server reported for the run wins", () => {
    for (const status of ["completed", "error", "interrupted"] as const) {
      expect(backgroundStatus({ entry: entry({ result: result({ status }) }) })).toBe(status)
    }
  })

  test("beats the state of the job and the summary of the child", () => {
    const ended = entry({ result: result({ status: "error" }) })
    expect(backgroundStatus({ entry: ended, job: job("running"), summary: summary("busy", 10) })).toBe("error")
    expect(backgroundStatus({ entry: ended, job: job("completed"), summary: summary("idle", 10) })).toBe("error")
    expect(backgroundStatus({ entry: entry({ result: result() }), job: job("cancelled") })).toBe("completed")
    expect(backgroundStatus({ entry: entry({ result: result({ status: "interrupted" }) }), job: job("error") })).toBe(
      "interrupted",
    )
  })
})

describe("backgroundStatus: the state of the job", () => {
  test("an ended job says how", () => {
    expect(backgroundStatus({ entry: entry(), job: job("cancelled") })).toBe("cancelled")
    expect(backgroundStatus({ entry: entry(), job: job("completed") })).toBe("completed")
    expect(backgroundStatus({ entry: entry(), job: job("error") })).toBe("error")
    expect(backgroundStatus({ entry: entry(), job: job("error", "timeout") })).toBe("error")
  })

  test("an error the process restart caused is an interruption", () => {
    expect(backgroundStatus({ entry: entry(), job: job("error", "process_restart") })).toBe("interrupted")
    // The reason only changes an error.
    expect(backgroundStatus({ entry: entry(), job: job("completed", "process_restart") })).toBe("completed")
    expect(backgroundStatus({ entry: entry(), job: job("cancelled", "process_restart") })).toBe("cancelled")
  })

  test("beats the summary of the child", () => {
    expect(backgroundStatus({ entry: entry(), job: job("completed"), summary: summary("busy", 10) })).toBe("completed")
    expect(backgroundStatus({ entry: entry(), job: job("cancelled"), summary: summary("retry", 10) })).toBe("cancelled")
    expect(backgroundStatus({ entry: entry(), job: job("error"), summary: summary("busy", 10) })).toBe("error")
  })
})

describe("backgroundStatus: a job that has not ended", () => {
  test("a running job whose child runs no turn and called no tool is queued", () => {
    expect(backgroundStatus({ entry: entry(), job: job("running") })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("unknown") })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("idle") })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("idle", 0) })).toBe("queued")
  })

  test("a child that called a tool runs, even between turns", () => {
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("idle", 1) })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("unknown", 3) })).toBe("running")
  })

  test("a child that is busy or retrying runs", () => {
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("busy") })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("retry") })).toBe("running")
  })

  test("a settling job is finishing: it runs", () => {
    expect(backgroundStatus({ entry: entry(), job: job("settling") })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: job("settling"), summary: summary("idle") })).toBe("running")
  })
})

describe("backgroundStatus: no job state", () => {
  test("a busy or retrying child runs", () => {
    expect(backgroundStatus({ entry: entry(), summary: summary("busy") })).toBe("running")
    expect(backgroundStatus({ entry: entry(), summary: summary("retry", 10) })).toBe("running")
  })

  test("anything else is unknown, which a cold start reads as", () => {
    expect(backgroundStatus({ entry: entry() })).toBe("unknown")
    expect(backgroundStatus({ entry: entry(), summary: summary("unknown") })).toBe("unknown")
    // Idle is not proof of an end: the run may be between turns, or the job state may not have arrived.
    expect(backgroundStatus({ entry: entry(), summary: summary("idle", 10) })).toBe("unknown")
  })

  test("a job value the contract does not name counts as no job", () => {
    expect(backgroundStatus({ entry: entry(), job: job("pending"), summary: summary("busy") })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: job("pending"), summary: summary("idle", 10) })).toBe("unknown")
  })
})

describe("isActive", () => {
  test("only a queued or a running run is active", () => {
    const active: BackgroundStatus[] = ["queued", "running"]
    const over: BackgroundStatus[] = ["completed", "error", "interrupted", "cancelled", "unknown"]
    for (const status of active) expect(isActive(status)).toBe(true)
    for (const status of over) expect(isActive(status)).toBe(false)
  })
})

describe("backgroundItems", () => {
  /** Looks a run's job and summary up by its child id, as the data layer does. */
  function lookups(jobs: Record<string, BackgroundJob> = {}, summaries: Record<string, BackgroundSummary> = {}) {
    return { job: (id: string) => jobs[id], summary: (id: string) => summaries[id] }
  }
  const ids = (items: BackgroundItem[]) => items.map((item) => item.sessionID)

  test("nothing to show is four empty groups", () => {
    expect(backgroundItems({ taskIndex: {}, rootID: ROOT, ...lookups() })).toEqual({
      running: [],
      queued: [],
      finished: [],
      unknown: [],
    })
  })

  test("keeps the background runs the root started and nothing else", () => {
    const groups = backgroundItems({
      taskIndex: {
        ses_bg: entry(),
        ses_fg: entry({ background: false }),
        ses_plain: entry({ background: undefined }),
        ses_other: entry({ parentSessionID: "ses_elsewhere" }),
        ses_gone: undefined,
      },
      rootID: ROOT,
      ...lookups(
        { ses_bg: job("running"), ses_fg: job("running"), ses_other: job("running") },
        { ses_bg: summary("busy") },
      ),
    })
    expect(ids(groups.running)).toEqual(["ses_bg"])
    expect(ids([...groups.queued, ...groups.finished, ...groups.unknown])).toEqual([])
  })

  test("sorts each run into the group of its status", () => {
    const runningLink = entry()
    const groups = backgroundItems({
      taskIndex: {
        ses_running: runningLink,
        ses_queued: entry(),
        ses_done: entry({ result: result() }),
        ses_failed: entry({ result: result({ status: "error" }) }),
        ses_lost: entry({ result: result({ status: "interrupted" }) }),
        ses_stopped: entry(),
        ses_cold: entry(),
      },
      rootID: ROOT,
      ...lookups(
        { ses_running: job("running"), ses_queued: job("running"), ses_stopped: job("cancelled") },
        { ses_running: summary("busy", 10) },
      ),
    })
    expect(ids(groups.running)).toEqual(["ses_running"])
    expect(ids(groups.queued)).toEqual(["ses_queued"])
    expect(ids(groups.finished).toSorted()).toEqual(["ses_done", "ses_failed", "ses_lost", "ses_stopped"])
    expect(ids(groups.unknown)).toEqual(["ses_cold"])
    expect(groups.finished.map((item) => item.status).toSorted()).toEqual([
      "cancelled",
      "completed",
      "error",
      "interrupted",
    ])
    // Each item carries the link it was made from.
    expect(groups.running[0].entry).toBe(runningLink)
    expect(groups.finished.find((item) => item.sessionID === "ses_done")?.entry.result?.status).toBe("completed")
  })

  test("each group lists the newest start first, then settles ties by session id", () => {
    const running = (startedAt: number) => entry({ startedAt })
    const jobs = Object.fromEntries(["ses_a", "ses_b", "ses_c", "ses_d"].map((id) => [id, job("running")]))
    const summaries = Object.fromEntries(["ses_a", "ses_b", "ses_c", "ses_d"].map((id) => [id, summary("busy", 1)]))
    const groups = backgroundItems({
      taskIndex: { ses_d: running(300), ses_b: running(100), ses_c: running(300), ses_a: running(200) },
      rootID: ROOT,
      ...lookups(jobs, summaries),
    })
    expect(ids(groups.running)).toEqual(["ses_c", "ses_d", "ses_a", "ses_b"])
  })

  test("a run without a start of its own is placed by its result's start, then by zero", () => {
    const groups = backgroundItems({
      taskIndex: {
        // The link's own start wins over the result's.
        ses_own: entry({ startedAt: 250, result: result({ startedAt: 10 }) }),
        ses_result: entry({ result: result({ startedAt: 200 }) }),
        ses_none: entry({ result: result({ startedAt: 0 }) }),
        ses_job_only: entry(),
        ses_later: entry({ result: result({ startedAt: 300 }) }),
      },
      rootID: ROOT,
      ...lookups({ ses_job_only: job("completed") }),
    })
    expect(ids(groups.finished)).toEqual(["ses_later", "ses_own", "ses_result", "ses_job_only", "ses_none"])
  })

  test("looks the job and the summary up by the child's own id", () => {
    const asked: string[] = []
    backgroundItems({
      taskIndex: { ses_x: entry(), ses_y: entry({ background: false }) },
      rootID: ROOT,
      job: (id) => {
        asked.push(`job:${id}`)
        return undefined
      },
      summary: (id) => {
        asked.push(`summary:${id}`)
        return undefined
      },
    })
    expect(asked.toSorted()).toEqual(["job:ses_x", "summary:ses_x"])
  })
})

describe("backgroundElapsed", () => {
  const item = (status: BackgroundStatus, overrides: Partial<TaskIndexEntry> = {}): BackgroundItem => ({
    sessionID: "ses_x",
    entry: entry(overrides),
    status,
  })

  test("an active run has taken the time since it started", () => {
    expect(backgroundElapsed(item("running", { startedAt: 1_000 }), 4_500)).toBe(3_500)
    expect(backgroundElapsed(item("queued", { startedAt: 1_000 }), 1_000)).toBe(0)
  })

  test("an active run with no known start has no elapsed time", () => {
    expect(backgroundElapsed(item("running"), 4_500)).toBeUndefined()
    expect(backgroundElapsed(item("queued"), 4_500)).toBeUndefined()
  })

  test("a clock that reads before the start counts as zero", () => {
    expect(backgroundElapsed(item("running", { startedAt: 5_000 }), 4_000)).toBe(0)
  })

  test("a run that ended took the span of its result, whatever the time is now", () => {
    const ended = { startedAt: 1_000, result: result({ startedAt: 2_000, endedAt: 9_500 }) }
    expect(backgroundElapsed(item("completed", ended), 1_000_000)).toBe(7_500)
    expect(backgroundElapsed(item("error", ended), 0)).toBe(7_500)
    expect(backgroundElapsed(item("interrupted", ended), 3_000)).toBe(7_500)
    expect(backgroundElapsed(item("completed", { result: result({ startedAt: 5_000, endedAt: 4_000 }) }), 0)).toBe(0)
  })

  test("an end only the job reported has no elapsed time, and neither has an unknown run", () => {
    expect(backgroundElapsed(item("cancelled", { startedAt: 1_000 }), 4_500)).toBeUndefined()
    expect(backgroundElapsed(item("completed", { startedAt: 1_000 }), 4_500)).toBeUndefined()
    expect(backgroundElapsed(item("unknown", { startedAt: 1_000 }), 4_500)).toBeUndefined()
  })
})
