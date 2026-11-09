// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@graphagent/sdk/v2"

const sid = "ses_goal_1"

function goalUpdated(overrides: Partial<{ goal: string; status: "active" | "paused" | "done"; turnsUsed: number; maxTurns: number }> = {}): GlobalEvent {
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

for (const status of [200, 404, 500]) {
  test(`Goal reconnect handles HTTP ${status}`, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reads = 0
    const { app, emit, reconnect, sync } = await mount((url) => {
      if (!url.pathname.endsWith("/goal")) return
      reads++
      return Response.json(
        status === 200
          ? {
              goal: "updated goal",
              status: "paused",
              turnsUsed: 3,
              maxTurns: 20,
              subgoals: [],
            }
          : { message: "failed" },
        { status },
      )
    }, tmp.path)
    try {
      emit(goalUpdated())
      await wait(() => sync.data.goal[sid] !== undefined)
      reconnect()
      await wait(() => reads === 1)
      if (status === 404) {
        await wait(() => sync.data.goal[sid] === undefined)
        expect(sync.data.goal[sid]).toBeUndefined()
      } else {
        // Starting another request proves the first reconnect finished.
        await wait(() => {
          reconnect()
          return reads >= 2
        })
        expect(sync.data.goal[sid]?.goal).toBe(status === 200 ? "updated goal" : "ship the feature")
      }
    } finally {
      app.renderer.destroy()
    }
  })
}
