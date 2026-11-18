// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { BackgroundResult, TaskIndexEntry } from "../../src/context/session-summary"
import {
  backgroundElapsed,
  backgroundItems,
  backgroundRunningAt,
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
/** A job as a server that reports the queue states it: with the moment it entered the value (#1407). */
const reported = (value: string, since = 1_000): BackgroundJob => ({ value, since })
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

describe("backgroundStatus: a server that reports the queue", () => {
  test("a queued job is queued, and nothing the child shows moves it", () => {
    expect(backgroundStatus({ entry: entry(), job: reported("queued") })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: reported("queued"), summary: summary("idle", 0) })).toBe("queued")
    // The server's word beats the summary, as the end of a job does.
    expect(backgroundStatus({ entry: entry(), job: reported("queued"), summary: summary("busy", 4) })).toBe("queued")
  })

  test("a running job is running before its child is busy and before the first tool call", () => {
    // Exactly what the inference got wrong: the run holds its slot, and its child has not shown anything yet.
    expect(backgroundStatus({ entry: entry(), job: reported("running") })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: reported("running"), summary: summary("unknown") })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: reported("running"), summary: summary("idle", 0) })).toBe("running")
    // Nor is the idle gap between two turns of a run that has called no tool a queue.
    expect(backgroundStatus({ entry: entry(), job: reported("running"), summary: summary("idle") })).toBe("running")
  })

  test("a queued job without `since` is queued too: the value alone is the server's word", () => {
    expect(backgroundStatus({ entry: entry(), job: job("queued") })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: job("queued"), summary: summary("busy") })).toBe("queued")
  })

  test("the end of the job and the result still come first", () => {
    expect(backgroundStatus({ entry: entry(), job: reported("completed") })).toBe("completed")
    expect(backgroundStatus({ entry: entry(), job: reported("cancelled"), summary: summary("busy") })).toBe("cancelled")
    expect(backgroundStatus({ entry: entry({ result: result() }), job: reported("queued") })).toBe("completed")
  })

  test("a server that does not report the queue says `running` without `since`, and the inference stands", () => {
    // The same job value, told by an older server: no mark, so the child decides as it always did.
    expect(backgroundStatus({ entry: entry(), job: job("running") })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("idle", 0) })).toBe("queued")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("idle", 2) })).toBe("running")
    expect(backgroundStatus({ entry: entry(), job: job("running"), summary: summary("busy") })).toBe("running")
  })
})

describe("backgroundRunningAt", () => {
  test("is the moment a running job began, as the server says", () => {
    expect(backgroundRunningAt(reported("running", 4_200))).toBe(4_200)
    expect(backgroundRunningAt(reported("running", 0))).toBe(0)
  })

  test("is not the start of the wait of a queued job, and is unknown without the server's word", () => {
    expect(backgroundRunningAt(reported("queued", 900))).toBeUndefined()
    expect(backgroundRunningAt(job("running"))).toBeUndefined()
    expect(backgroundRunningAt(reported("completed", 7_000))).toBeUndefined()
    expect(backgroundRunningAt(undefined)).toBeUndefined()
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

  // The acceptance of #1407: three background tasks with a limit of one. The first runs; the second and the third wait,
  // and the one that is next in line starts running when the first ends, before it has been busy or called a tool.
  test("a limit of one: one run runs, the others are queued, and a run that begins is running at once", () => {
    const taskIndex = {
      ses_1: entry({ startedAt: 100 }),
      ses_2: entry({ startedAt: 200 }),
      ses_3: entry({ startedAt: 300 }),
    }
    const idle = { ses_1: summary("busy", 2), ses_2: summary("idle", 0), ses_3: summary("unknown") }
    const waiting = backgroundItems({
      taskIndex,
      rootID: ROOT,
      ...lookups(
        { ses_1: reported("running", 150), ses_2: reported("queued", 200), ses_3: reported("queued", 300) },
        idle,
      ),
    })
    expect(ids(waiting.running)).toEqual(["ses_1"])
    expect(ids(waiting.queued)).toEqual(["ses_3", "ses_2"])
    expect(ids(waiting.unknown)).toEqual([])

    // The first ended and the second began: a `running` job whose child has shown nothing yet.
    const next = backgroundItems({
      taskIndex: { ...taskIndex, ses_1: entry({ startedAt: 100, result: result({ startedAt: 100, endedAt: 900 }) }) },
      rootID: ROOT,
      ...lookups(
        { ses_1: reported("completed"), ses_2: reported("running", 950), ses_3: reported("queued", 300) },
        { ses_2: summary("idle", 0) },
      ),
    })
    expect(ids(next.running)).toEqual(["ses_2"])
    expect(ids(next.queued)).toEqual(["ses_3"])
    expect(ids(next.finished)).toEqual(["ses_1"])
    // The run that began is timed from then, not from the Task call that queued it.
    expect(next.running[0].runningAt).toBe(950)
    expect(backgroundElapsed(next.running[0], 1_450)).toBe(500)
    expect(next.queued[0]).not.toHaveProperty("runningAt")
  })

  test("the same runs told by an older server are told apart by the inference, as before", () => {
    const groups = backgroundItems({
      taskIndex: {
        ses_1: entry({ startedAt: 100 }),
        ses_2: entry({ startedAt: 200 }),
        ses_3: entry({ startedAt: 300 }),
      },
      rootID: ROOT,
      ...lookups(
        { ses_1: job("running"), ses_2: job("running"), ses_3: job("running") },
        { ses_1: summary("busy", 2), ses_2: summary("idle", 0) },
      ),
    })
    expect(ids(groups.running)).toEqual(["ses_1"])
    expect(ids(groups.queued)).toEqual(["ses_3", "ses_2"])
    for (const item of [...groups.running, ...groups.queued]) expect(item).not.toHaveProperty("runningAt")
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

  test("a running run is timed from the moment it began, without the wait for its slot (#1407)", () => {
    // Started at 1 s, waited until 4 s, now 6.5 s: it has run for 2.5 s.
    const began = { ...item("running", { startedAt: 1_000 }), runningAt: 4_000 }
    expect(backgroundElapsed(began, 6_500)).toBe(2_500)
    expect(backgroundElapsed(began, 4_000)).toBe(0)
    expect(backgroundElapsed(began, 3_000)).toBe(0)
    // With no start of its own the moment it began still times it.
    expect(backgroundElapsed({ ...item("running"), runningAt: 4_000 }, 6_500)).toBe(2_500)
  })

  test("a queued run is not timed from a moment it has not reached", () => {
    // The wait so far, from the Task call: nothing shows it, and it never counts as run time.
    const waiting = { ...item("queued", { startedAt: 1_000 }), runningAt: 4_000 }
    expect(backgroundElapsed(waiting, 2_000)).toBe(1_000)
  })

  test("a run that ended took the span from the moment it began to its end", () => {
    const began = { startedAt: 1_000, result: result({ startedAt: 1_000, runningAt: 4_000, endedAt: 9_500 }) }
    expect(backgroundElapsed(item("completed", began), 1_000_000)).toBe(5_500)
    expect(backgroundElapsed(item("error", began), 0)).toBe(5_500)
    // Without it (an older server, a run lost with its process) the span runs from the start.
    const unknown = { result: result({ startedAt: 1_000, endedAt: 9_500 }) }
    expect(backgroundElapsed(item("completed", unknown), 0)).toBe(8_500)
    // A moment after the end counts as zero.
    expect(backgroundElapsed(item("completed", { result: result({ runningAt: 12_000, endedAt: 9_500 }) }), 0)).toBe(0)
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
