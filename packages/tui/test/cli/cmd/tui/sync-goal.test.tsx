// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@graphagent/sdk"

const sid = "ses_goal_1"

function goalUpdated(
  overrides: Partial<{ goal: string; status: "active" | "paused" | "done"; turnsUsed: number; maxTurns: number }> = {},
): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_goal_updated_${Date.now()}_${Math.random()}`,
      type: "goal.updated",
      properties: {
        sessionID: sid,
        goal: {
          goal: overrides.goal ?? "ship the feature",
          status: overrides.status ?? "active",
          turnsUsed: overrides.turnsUsed ?? 0,
          maxTurns: overrides.maxTurns ?? 20,
          subgoals: [],
        },
      },
    },
  }
}

function goalCleared(): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_goal_cleared_${Date.now()}_${Math.random()}`,
      type: "goal.cleared",
      properties: { sessionID: sid },
    },
  }
}

describe("tui sync goal slice", () => {
  test("goal.updated writes the goal state into store.goal[sessionID]", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.goal[sid]).toBeUndefined()

      emit(goalUpdated())
      await wait(() => sync.data.goal[sid] !== undefined)

      expect(sync.data.goal[sid]).toMatchObject({
        goal: "ship the feature",
        status: "active",
        turnsUsed: 0,
        maxTurns: 20,
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("subsequent goal.updated events replace the slice", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(goalUpdated())
      await wait(() => sync.data.goal[sid] !== undefined)

      emit(goalUpdated({ status: "paused", turnsUsed: 3 }))
      await wait(() => sync.data.goal[sid]?.status === "paused")

      expect(sync.data.goal[sid]).toMatchObject({ status: "paused", turnsUsed: 3, goal: "ship the feature" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("goal.cleared removes the slice", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(goalUpdated())
      await wait(() => sync.data.goal[sid] !== undefined)

      emit(goalCleared())
      await wait(() => sync.data.goal[sid] === undefined)

      expect(sync.data.goal[sid]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})

// #1069: the reconnect refill of the goal slice is the lifecycle batch. The
// owner's answer for the goal ref replaces the status, an unknown ref clears
// the goal, and a failed read leaves it alone.
const goalState = {
  domain: "goal",
  id: sid,
  value: "paused",
  phase: "paused",
  terminal: false,
  settled: false,
  source: "persisted",
  observedAt: 1,
}

const refills = [
  {
    label: "a known state",
    outcome: "status",
    reply: () => Response.json([{ domain: "goal", id: sid, state: goalState }]),
  },
  {
    label: "an unknown ref",
    outcome: "cleared",
    reply: () => Response.json([{ domain: "goal", id: sid, state: null }]),
  },
  {
    label: "HTTP 500",
    outcome: "kept",
    reply: () => Response.json({ message: "failed" }, { status: 500 }),
  },
] as const

for (const refill of refills) {
  test(`Goal reconnect handles ${refill.label}`, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const bodies: unknown[] = []
    const { app, emit, reconnect, sync } = await mount(async (url, request) => {
      if (url.pathname !== "/lifecycle/states") return undefined
      bodies.push(await request?.json())
      return refill.reply()
    }, tmp.path)
    try {
      emit(goalUpdated())
      await wait(() => sync.data.goal[sid] !== undefined)
      reconnect()
      await wait(() => bodies.length === 1)
      // One batched read, naming the goal of the session that has one.
      expect(bodies[0]).toEqual({ refs: [{ domain: "goal", id: sid }] })
      if (refill.outcome === "cleared") {
        await wait(() => sync.data.goal[sid] === undefined)
        expect(sync.data.goal[sid]).toBeUndefined()
      } else if (refill.outcome === "status") {
        await wait(() => sync.data.goal[sid]?.status === "paused")
        // Only the status comes from the contract; the goal itself stays.
        expect(sync.data.goal[sid]?.goal).toBe("ship the feature")
      } else {
        // Starting another request proves the first reconnect finished.
        await wait(() => {
          reconnect()
          return bodies.length >= 2
        })
        expect(sync.data.goal[sid]).toMatchObject({ goal: "ship the feature", status: "active" })
      }
    } finally {
      app.renderer.destroy()
    }
  })
}
