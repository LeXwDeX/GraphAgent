// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { LIFECYCLE_MIRROR_MAX } from "../../../../src/context/lifecycle-mirror"
import type { useSDK } from "../../../../src/context/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { advanceUntil, nextTurn } from "../../../fixture/frames"
import type { FetchHandler } from "../../../fixture/tui-sdk"
import { directory, json, mount } from "./sync-fixture"

// #1069 TUI mirror: `lifecycle.transitioned` seeds the mirror, the owner is
// asked about the queued refs in one `POST /lifecycle/states` per frame, and
// a reconnect asks about everything held, goals included.
//
// Time is driven by hand: events reach the store when a test flushes the frame
// clock, and a read counts as answered when the promise `sdk.client.lifecycle`
// returned for it settles. No test waits for a duration.

type Ref = { domain: string; id: string }

const sid = "ses_goal_1"
let eventCount = 0

function global(payload: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, project: "proj_test", payload } as GlobalEvent
}

function transition(input: {
  domain: string
  id: string
  sessionID?: string
  from?: string
  to: string
  phase: string
  at?: number
}) {
  return global({
    id: `evt_lifecycle_${++eventCount}`,
    type: "lifecycle.transitioned",
    properties: {
      domain: input.domain,
      stateID: input.id,
      sessionID: input.sessionID,
      from: input.from,
      to: input.to,
      phase: input.phase,
      timestamp: input.at ?? 1_000 + eventCount,
    },
  })
}

function goalUpdated(turnsUsed = 0) {
  return global({
    id: `evt_goal_${++eventCount}`,
    type: "goal.updated",
    properties: {
      sessionID: sid,
      goal: { goal: "ship the feature", status: "active", turnsUsed, maxTurns: 20, subgoals: [] },
    },
  })
}

function answer(ref: Ref, value: string, phase: string) {
  return {
    domain: ref.domain,
    id: ref.id,
    state: {
      domain: ref.domain,
      id: ref.id,
      value,
      phase,
      terminal: phase === "succeeded",
      settled: phase === "succeeded",
      source: "live",
      observedAt: 5_000,
    },
  }
}

const unknown = (ref: Ref) => ({ domain: ref.domain, id: ref.id, state: null })

function isRef(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    "domain" in value &&
    typeof value.domain === "string" &&
    "id" in value &&
    typeof value.id === "string"
  )
}

/** Records the refs of every `POST /lifecycle/states`; `reply` decides the answer. */
function lifecycleServer(reply: (refs: Ref[], call: number) => Response | Promise<Response>) {
  const calls: Ref[][] = []
  const handler: FetchHandler = async (url, request) => {
    if (url.pathname !== "/lifecycle/states") return undefined
    const body: unknown = await request?.json()
    const refs =
      typeof body === "object" && body !== null && "refs" in body && Array.isArray(body.refs) ? body.refs : []
    const checked = refs.filter(isRef)
    calls.push(checked)
    return reply(checked, calls.length)
  }
  return { calls, handler }
}

/** Holds an answer back until the test lets it go. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/**
 * Watches the SDK call that sends the batch. The call itself is synchronous, so
 * its count shows what one flush of the frame clock sent; the promise it
 * returned is the one the sync layer chained its answer handling onto, so
 * awaiting `answered(n)` means read `n` came back and its answer was applied.
 */
function watchReads(sdk: ReturnType<typeof useSDK>) {
  const spy = spyOn(sdk.client.lifecycle, "states")
  return {
    sent: () => spy.mock.calls.length,
    answered: (index: number) => {
      const read = spy.mock.results[index]
      if (!read) throw new Error(`read ${index} was never sent`)
      return read.value
    },
    restore: () => spy.mockRestore(),
  }
}

const key = (ref: Ref) => `${ref.domain}:${ref.id}`

describe("lifecycle mirror", () => {
  test("a transition seeds the mirror at once and the owner confirms it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = lifecycleServer(async (refs) => {
      await release.opened
      return json(refs.map((ref) => answer(ref, "completed", "succeeded")))
    })
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      // `lifecycle.transitioned` is a summary-scope event: it is delivered
      // although no session has full interest.
      emit(
        transition({
          domain: "job",
          id: "job_1",
          sessionID: "ses_a",
          from: "running",
          to: "settling",
          phase: "settling",
        }),
      )
      sdk.frameClock.flushNow()
      expect(sync.data.lifecycle["job:job_1"]).toMatchObject({
        value: "settling",
        phase: "settling",
        sessionID: "ses_a",
      })

      // The same flush asked the owner.
      expect(reads.sent()).toBe(1)
      await advanceUntil(sdk, () => server.calls.length === 1)
      expect(server.calls[0]).toEqual([{ domain: "job", id: "job_1" }])
      release.open()
      await reads.answered(0)
      // The answer does not name the session; it stays with the entry.
      expect(sync.data.lifecycle["job:job_1"]).toMatchObject({
        value: "completed",
        phase: "succeeded",
        sessionID: "ses_a",
        at: 5_000,
      })
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("transitions of one frame are asked in one request, each ref once", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer((refs) => json(refs.map((ref) => answer(ref, "running", "running"))))
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_a", to: "running", phase: "running" }))
      emit(transition({ domain: "job", id: "job_b", to: "running", phase: "running" }))
      emit(transition({ domain: "job", id: "job_a", from: "running", to: "settling", phase: "settling" }))
      emit(transition({ domain: "goal", id: sid, sessionID: sid, to: "active", phase: "running" }))
      emit(
        transition({ domain: "turn", id: "turn_1", sessionID: sid, from: "running", to: "ended", phase: "succeeded" }),
      )
      sdk.frameClock.flushNow()
      expect(reads.sent()).toBe(1)

      await advanceUntil(sdk, () => server.calls.length === 1)
      // The turn is mirrored from its event but is not part of the request: the
      // server has no resolver for it.
      expect(server.calls[0]).toEqual([
        { domain: "job", id: "job_a" },
        { domain: "job", id: "job_b" },
        { domain: "goal", id: sid },
      ])
      expect(sync.data.lifecycle["turn:turn_1"]).toMatchObject({ value: "ended", phase: "succeeded" })
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_a"]?.value).toBe("running")

      // A later frame is a later request.
      emit(transition({ domain: "job", id: "job_c", to: "running", phase: "running" }))
      await advanceUntil(sdk, () => server.calls.length === 2)
      expect(server.calls[1]).toEqual([{ domain: "job", id: "job_c" }])
      expect(reads.sent()).toBe(2)
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("refs that queue while a read is out go in one follow-up request", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const first = gate()
    const server = lifecycleServer(async (refs, call) => {
      if (call === 1) await first.opened
      return json(refs.map((ref) => answer(ref, "running", "running")))
    })
    const { app, emit, sdk } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_a", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)

      // Two more frames while the first read is out: nothing goes out for them.
      emit(transition({ domain: "job", id: "job_b", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      emit(transition({ domain: "job", id: "job_c", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      expect(reads.sent()).toBe(1)

      first.open()
      await advanceUntil(sdk, () => server.calls.length === 2)
      expect(server.calls[1]).toEqual([
        { domain: "job", id: "job_b" },
        { domain: "job", id: "job_c" },
      ])
      await reads.answered(1)
      // Everything queued has been sent: another frame sends nothing.
      await nextTurn()
      sdk.frameClock.flushNow()
      expect(reads.sent()).toBe(2)
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("an older answer does not undo a newer transition", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const first = gate()
    const second = gate()
    const server = lifecycleServer(async (refs, call) => {
      await (call === 1 ? first : second).opened
      return json(
        refs.map((ref) => (call === 1 ? answer(ref, "running", "running") : answer(ref, "completed", "succeeded"))),
      )
    })
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_x", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)
      emit(transition({ domain: "job", id: "job_x", from: "running", to: "completed", phase: "succeeded" }))
      sdk.frameClock.flushNow()
      expect(sync.data.lifecycle["job:job_x"]?.value).toBe("completed")

      // The first read was asked before the transition: its answer is stale.
      first.open()
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_x"]?.value).toBe("completed")

      // The transition queued its own read, which confirms it.
      await advanceUntil(sdk, () => server.calls.length === 2)
      second.open()
      await reads.answered(1)
      expect(sync.data.lifecycle["job:job_x"]).toMatchObject({ value: "completed", phase: "succeeded", at: 5_000 })
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("a read that never returns neither blocks the reconnect refill nor lands after it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const hung = gate()
    const server = lifecycleServer(async (refs, call) => {
      if (call === 1) {
        await hung.opened
        return json(refs.map((ref) => answer(ref, "running", "running")))
      }
      return json(refs.map((ref) => answer(ref, "completed", "succeeded")))
    })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_h", sessionID: "ses_h", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)

      // The refill goes out at once although the first read is still out.
      reconnect()
      expect(reads.sent()).toBe(2)
      await advanceUntil(sdk, () => server.calls.length === 2)
      expect(server.calls[1]).toEqual([{ domain: "job", id: "job_h" }])
      await reads.answered(1)
      expect(sync.data.lifecycle["job:job_h"]?.value).toBe("completed")

      // The old read finally comes back; what it carries predates the refill.
      hung.open()
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_h"]).toMatchObject({ value: "completed", phase: "succeeded" })
      expect(reads.sent()).toBe(2)
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("a ref the owner does not know is dropped", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = lifecycleServer(async (refs) => {
      await release.opened
      return json(refs.map(unknown))
    })
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_9", from: "running", to: "completed", phase: "succeeded" }))
      sdk.frameClock.flushNow()
      expect(sync.data.lifecycle["job:job_9"]).toBeDefined()
      await advanceUntil(sdk, () => server.calls.length === 1)

      release.open()
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_9"]).toBeUndefined()
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("a domain the server cannot resolve is mirrored from its events and never asked about", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer((refs) => json(refs.map(unknown)))
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      // Every turn ends with one transition; none of them may cost a request.
      for (let turn = 1; turn <= 3; turn++) {
        emit(
          transition({
            domain: "turn",
            id: `turn_${turn}`,
            sessionID: sid,
            from: "running",
            to: "ended",
            phase: "succeeded",
          }),
        )
        sdk.frameClock.flushNow()
      }
      expect(reads.sent()).toBe(0)
      for (let turn = 1; turn <= 3; turn++) {
        expect(sync.data.lifecycle[`turn:turn_${turn}`]).toMatchObject({ value: "ended", sessionID: sid })
      }

      // Neither does a reconnect refill ask about what the mirror holds for it.
      reconnect()
      expect(reads.sent()).toBe(0)
      await nextTurn()
      expect(server.calls).toHaveLength(0)
      expect(sync.data.lifecycle["turn:turn_1"]).toBeDefined()

      // A domain that is resolvable still goes out, alone.
      emit(transition({ domain: "job", id: "job_t", to: "running", phase: "running" }))
      await advanceUntil(sdk, () => server.calls.length === 1)
      expect(server.calls[0]).toEqual([{ domain: "job", id: "job_t" }])
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("a failed read keeps what the events described", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer(() => Response.json({ message: "failed" }, { status: 500 }))
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_f", to: "settling", phase: "settling" }))
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_f"]).toMatchObject({ value: "settling", phase: "settling" })
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("without transitions nothing is asked, not even on reconnect", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer(() => json([]))
    const { app, emit, reconnect, sdk } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(
        global({
          id: "evt_idle",
          type: "session.status",
          properties: { sessionID: "ses_idle", status: { type: "idle" } },
        }),
      )
      sdk.frameClock.flushNow()
      // The reconnect handlers run inline: a read would already have been sent.
      reconnect()
      expect(reads.sent()).toBe(0)
      await nextTurn()
      expect(server.calls).toHaveLength(0)
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("deleting a session drops its entries", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer((refs) => json(refs.map((ref) => answer(ref, "running", "running"))))
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_gone", sessionID: "ses_gone", to: "running", phase: "running" }))
      emit(transition({ domain: "job", id: "job_kept", sessionID: "ses_kept", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_gone"]?.at).toBe(5_000)

      emit(
        global({
          id: "evt_deleted",
          type: "session.deleted",
          properties: { sessionID: "ses_gone", info: { id: "ses_gone" } },
        }),
      )
      sdk.frameClock.flushNow()
      expect(sync.data.lifecycle["job:job_gone"]).toBeUndefined()
      expect(sync.data.lifecycle["job:job_kept"]).toBeDefined()

      reconnect()
      await advanceUntil(sdk, () => server.calls.length === 2)
      expect(server.calls[1]).toEqual([{ domain: "job", id: "job_kept" }])
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("the mirror is bounded and gives up finished entries first", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer(() => Response.json({ message: "failed" }, { status: 500 }))
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)
    const live = 100
    const finished = LIFECYCLE_MIRROR_MAX - live + 24

    try {
      for (let index = 0; index < live; index++) {
        emit(transition({ domain: "job", id: `job_live_${index}`, to: "running", phase: "running", at: index }))
      }
      for (let index = 0; index < finished; index++) {
        emit(
          transition({
            domain: "job",
            id: `job_done_${index}`,
            to: "completed",
            phase: "succeeded",
            at: 1_000 + index,
          }),
        )
      }
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)
      await reads.answered(0)

      const keys = Object.keys(sync.data.lifecycle)
      expect(keys).toHaveLength(LIFECYCLE_MIRROR_MAX)
      // Every live entry survived; the oldest finished ones went.
      for (let index = 0; index < live; index++) expect(keys).toContain(`job:job_live_${index}`)
      expect(keys).not.toContain("job:job_done_0")
      expect(keys).not.toContain("job:job_done_23")
      expect(keys).toContain("job:job_done_24")
      expect(keys).toContain(`job:job_done_${finished - 1}`)
      // The evicted refs are not asked about.
      expect(server.calls[0]).toHaveLength(LIFECYCLE_MIRROR_MAX)
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })
})

describe("goal slice through the lifecycle mirror", () => {
  test("a goal transition updates the status at once and the owner's answer settles it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = lifecycleServer(async (refs) => {
      await release.opened
      return json(refs.map((ref) => answer(ref, "waiting", "waiting")))
    })
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(goalUpdated())
      sdk.frameClock.flushNow()
      expect(sync.data.goal[sid]).toBeDefined()

      emit(transition({ domain: "goal", id: sid, sessionID: sid, from: "active", to: "paused", phase: "paused" }))
      sdk.frameClock.flushNow()
      expect(sync.data.goal[sid]?.status).toBe("paused")
      // The transition carries the status only; the goal itself stays.
      expect(sync.data.goal[sid]).toMatchObject({ goal: "ship the feature", maxTurns: 20 })

      await advanceUntil(sdk, () => server.calls.length === 1)
      expect(server.calls[0]).toEqual([{ domain: "goal", id: sid }])
      release.open()
      await reads.answered(0)
      expect(sync.data.goal[sid]?.status).toBe("waiting")
      expect(sync.data.lifecycle[`goal:${sid}`]).toMatchObject({ value: "waiting", sessionID: sid })
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("a goal transition without a stored goal creates none", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer((refs) => json(refs.map((ref) => answer(ref, "paused", "paused"))))
    const { app, emit, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "goal", id: sid, sessionID: sid, to: "paused", phase: "paused" }))
      sdk.frameClock.flushNow()
      await reads.answered(0)
      expect(sync.data.lifecycle[`goal:${sid}`]?.at).toBe(5_000)
      expect(sync.data.goal[sid]).toBeUndefined()
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("reconnect asks about the mirror and about every stored goal in one request", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = lifecycleServer((refs, call) =>
      json(
        refs.map((ref) => {
          if (call === 1) return answer(ref, "running", "running")
          return ref.domain === "goal" ? answer(ref, "paused", "paused") : unknown(ref)
        }),
      ),
    )
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(transition({ domain: "job", id: "job_r", sessionID: "ses_r", to: "running", phase: "running" }))
      sdk.frameClock.flushNow()
      await advanceUntil(sdk, () => server.calls.length === 1)
      await reads.answered(0)
      expect(sync.data.lifecycle["job:job_r"]?.at).toBe(5_000)
      emit(goalUpdated())
      sdk.frameClock.flushNow()
      expect(sync.data.goal[sid]).toBeDefined()

      // One batch, sent by the reconnect itself.
      reconnect()
      expect(reads.sent()).toBe(2)
      await advanceUntil(sdk, () => server.calls.length === 2)
      expect(server.calls[1].map(key).toSorted()).toEqual(["goal:ses_goal_1", "job:job_r"])

      // The job is gone for its owner; the goal status followed the answer.
      await reads.answered(1)
      expect(sync.data.lifecycle["job:job_r"]).toBeUndefined()
      expect(sync.data.goal[sid]?.status).toBe("paused")
      expect(reads.sent()).toBe(2)
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })

  test("a goal event that lands while a read is out wins over the answer", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = lifecycleServer(async (refs) => {
      await release.opened
      return json(refs.map((ref) => answer(ref, "paused", "paused")))
    })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const reads = watchReads(sdk)

    try {
      emit(goalUpdated(1))
      sdk.frameClock.flushNow()
      expect(sync.data.goal[sid]?.turnsUsed).toBe(1)

      reconnect()
      await advanceUntil(sdk, () => server.calls.length === 1)
      emit(goalUpdated(7))
      sdk.frameClock.flushNow()
      expect(sync.data.goal[sid]?.turnsUsed).toBe(7)

      release.open()
      await reads.answered(0)
      expect(sync.data.goal[sid]).toMatchObject({ status: "active", turnsUsed: 7 })
      // The skipped answer left no stale entry behind either.
      expect(sync.data.lifecycle[`goal:${sid}`]).toBeUndefined()
    } finally {
      reads.restore()
      app.renderer.destroy()
    }
  })
})
