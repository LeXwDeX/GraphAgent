// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import type { GlobalEvent, Goal } from "@graphagent/sdk"
import { advanceUntil } from "../../../fixture/frames"
import { tmpdir } from "../../../fixture/fixture"
import type { FetchHandler } from "../../../fixture/tui-sdk"
import { directory, json, mount } from "./sync-fixture"

// Reconnect refresh of the goal slice (AGENTS.md: the goal slice refreshes in
// full). The lifecycle contract reports the goal status only, so the goal
// itself (text, turns, limits, subgoals) must be read again for every stored
// session; sessions that are hydrated reload it in `sync`.

type Ref = { domain: string; id: string }

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return { goal: "ship the feature", status: "active", turnsUsed: 1, maxTurns: 20, subgoals: ["design"], ...overrides }
}

function goalUpdated(sessionID: string, goal: Goal): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_goal_${sessionID}_${goal.turnsUsed}`, type: "goal.updated", properties: { sessionID, goal } },
  } as GlobalEvent
}

function row(id: string) {
  return {
    id,
    slug: id,
    title: id,
    projectID: "proj_test",
    directory,
    version: "test",
    time: { created: 1, updated: 2 },
  }
}

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

/** Holds replies back until the test lets them go. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/**
 * A fake server for the goal reads and the lifecycle batch. `goal` answers
 * `GET /session/:id/goal` (and gets the ordinal of the read); `states` answers
 * `POST /lifecycle/states`, by default with an unknown state for every ref.
 */
function createServer(input: {
  sessions?: string[]
  goal: (sessionID: string, ordinal: number) => Response | Promise<Response>
  states?: (refs: Ref[]) => Response
}) {
  const goalReads: string[] = []
  const stateCalls: Ref[][] = []
  let inFlight = 0
  let maxInFlight = 0
  const handler: FetchHandler = async (url, request) => {
    const read = url.pathname.match(/^\/session\/([^/]+)\/goal$/)
    if (read) {
      goalReads.push(read[1])
      const ordinal = goalReads.length
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        return await input.goal(read[1], ordinal)
      } finally {
        inFlight--
      }
    }
    if (url.pathname === "/lifecycle/states") {
      const body: unknown = await request?.json()
      const refs =
        typeof body === "object" && body !== null && "refs" in body && Array.isArray(body.refs) ? body.refs : []
      const checked = refs.filter(isRef)
      stateCalls.push(checked)
      return input.states?.(checked) ?? json(checked.map((ref) => ({ domain: ref.domain, id: ref.id, state: null })))
    }
    const ids = input.sessions ?? []
    if (url.pathname === "/session") return json(ids.map(row))
    const session = url.pathname.match(/^\/session\/([^/]+)$/)
    if (session && ids.includes(session[1])) return json(row(session[1]))
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json([])
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    if (url.pathname.startsWith("/dag/session/")) return json([])
    return undefined
  }
  return {
    handler,
    goalReads,
    stateCalls,
    get maxInFlight() {
      return maxInFlight
    },
  }
}

function pausedState(ref: Ref) {
  return {
    domain: ref.domain,
    id: ref.id,
    state: {
      domain: ref.domain,
      id: ref.id,
      value: "paused",
      phase: "paused",
      terminal: false,
      settled: false,
      source: "persisted",
      observedAt: 1,
    },
  }
}

const updated = goalOf({
  goal: "ship the feature faster",
  status: "paused",
  turnsUsed: 7,
  maxTurns: 40,
  subgoals: ["design", "review"],
  pausedReason: "waiting for review",
})

describe("goal slice on reconnect", () => {
  test("a session that is not loaded gets its goal read in full, next to one lifecycle batch", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const server = createServer({ goal: () => json(updated) })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const states = spyOn(sdk.client.lifecycle, "states")

    try {
      emit(goalUpdated("ses_a", goalOf()))
      await advanceUntil(sdk, () => sync.data.goal.ses_a !== undefined)
      expect(sync.data.goal.ses_a).toEqual(goalOf())

      // The goal changed in every field the lifecycle contract does not carry.
      reconnect()
      await advanceUntil(sdk, () => sync.data.goal.ses_a?.turnsUsed === 7)
      expect(sync.data.goal.ses_a).toEqual(updated)
      expect(server.goalReads).toEqual(["ses_a"])
      // The lifecycle batch is still one request, naming the goal's session.
      expect(states).toHaveBeenCalledTimes(1)
      expect(server.stateCalls).toEqual([[{ domain: "goal", id: "ses_a" }]])
    } finally {
      states.mockRestore()
      app.renderer.destroy()
    }
  })

  test("one lifecycle request covers every stored goal however many are read", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const ids = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e", "ses_f"]
    const server = createServer({ goal: () => json(updated) })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const states = spyOn(sdk.client.lifecycle, "states")

    try {
      for (const id of ids) emit(goalUpdated(id, goalOf()))
      await advanceUntil(sdk, () => ids.every((id) => sync.data.goal[id] !== undefined))

      reconnect()
      expect(states).toHaveBeenCalledTimes(1)
      await advanceUntil(sdk, () => ids.every((id) => sync.data.goal[id]?.turnsUsed === 7))
      expect(states).toHaveBeenCalledTimes(1)
      expect(server.stateCalls[0].map((ref) => ref.id).toSorted()).toEqual(ids)
      expect(server.goalReads.toSorted()).toEqual(ids)
    } finally {
      states.mockRestore()
      app.renderer.destroy()
    }
  })

  test("reads run a few at a time", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const ids = Array.from({ length: 10 }, (_, index) => `ses_${index}`)
    const server = createServer({
      goal: async () => {
        await release.opened
        return json(updated)
      },
    })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)

    try {
      for (const id of ids) emit(goalUpdated(id, goalOf()))
      await advanceUntil(sdk, () => ids.every((id) => sync.data.goal[id] !== undefined))

      reconnect()
      await advanceUntil(sdk, () => server.goalReads.length >= 4)
      // The first round holds four; the rest wait for it to finish.
      expect(server.goalReads).toHaveLength(4)

      release.open()
      await advanceUntil(sdk, () => ids.every((id) => sync.data.goal[id]?.turnsUsed === 7))
      expect(server.goalReads.toSorted()).toEqual(ids)
      expect(server.maxInFlight).toBe(4)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a hydrated session reloads its goal in sync and is not read a second time", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const bodies: Record<string, Goal> = { ses_h: goalOf({ turnsUsed: 2 }), ses_a: goalOf({ turnsUsed: 3 }) }
    const server = createServer({ sessions: ["ses_h"], goal: (sessionID) => json(bodies[sessionID]) })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)

    try {
      await sync.session.activate("ses_h")
      expect(sync.data.goal.ses_h?.turnsUsed).toBe(2)
      emit(goalUpdated("ses_a", goalOf({ turnsUsed: 3 })))
      await advanceUntil(sdk, () => sync.data.goal.ses_a !== undefined)
      const before = server.goalReads.length

      bodies.ses_h = goalOf({ turnsUsed: 12 })
      bodies.ses_a = goalOf({ turnsUsed: 13 })
      reconnect()
      await advanceUntil(sdk, () => sync.data.goal.ses_h?.turnsUsed === 12 && sync.data.goal.ses_a?.turnsUsed === 13)

      // One read each: ses_h through its sync, ses_a through the refresh.
      expect(server.goalReads.slice(before).toSorted()).toEqual(["ses_a", "ses_h"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a goal event that lands while a read is out wins over its answer", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = createServer({
      goal: async () => {
        await release.opened
        return json(goalOf({ turnsUsed: 7 }))
      },
    })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const read = spyOn(sdk.client.session, "goal")

    try {
      emit(goalUpdated("ses_a", goalOf()))
      await advanceUntil(sdk, () => sync.data.goal.ses_a !== undefined)

      reconnect()
      await advanceUntil(sdk, () => server.goalReads.length === 1)
      emit(goalUpdated("ses_a", goalOf({ turnsUsed: 9 })))
      await advanceUntil(sdk, () => sync.data.goal.ses_a?.turnsUsed === 9)

      release.open()
      // The answer is processed before this resolves: it was attached first.
      await read.mock.results[0].value
      expect(sync.data.goal.ses_a?.turnsUsed).toBe(9)
    } finally {
      read.mockRestore()
      app.renderer.destroy()
    }
  })

  test("a newer reconnect supersedes a round that has not finished", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = createServer({
      goal: async (_sessionID, ordinal) => {
        if (ordinal > 1) return json(goalOf({ turnsUsed: 8 }))
        await release.opened
        return json(goalOf({ turnsUsed: 3 }))
      },
    })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const read = spyOn(sdk.client.session, "goal")

    try {
      emit(goalUpdated("ses_a", goalOf()))
      await advanceUntil(sdk, () => sync.data.goal.ses_a !== undefined)

      reconnect()
      await advanceUntil(sdk, () => server.goalReads.length === 1)
      reconnect()
      await advanceUntil(sdk, () => sync.data.goal.ses_a?.turnsUsed === 8)

      // The first round's read comes back last and predates the second reconnect.
      release.open()
      await read.mock.results[0].value
      expect(sync.data.goal.ses_a?.turnsUsed).toBe(8)
    } finally {
      read.mockRestore()
      app.renderer.destroy()
    }
  })

  test("a lifecycle answer that does not know the goal does not clear one the read still returns", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    // The lifecycle resolver is stricter about directories than the goal read.
    const server = createServer({ goal: () => json(updated) })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const states = spyOn(sdk.client.lifecycle, "states")

    try {
      emit(goalUpdated("ses_a", goalOf()))
      await advanceUntil(sdk, () => sync.data.goal.ses_a !== undefined)

      reconnect()
      await advanceUntil(sdk, () => sync.data.goal.ses_a?.turnsUsed === 7)
      await states.mock.results[0].value
      expect(sync.data.goal.ses_a).toEqual(updated)
    } finally {
      states.mockRestore()
      app.renderer.destroy()
    }
  })

  test("a status hint from the lifecycle contract does not invalidate the full read", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = createServer({
      goal: async () => {
        await release.opened
        return json(updated)
      },
      states: (refs) => json(refs.map(pausedState)),
    })
    const { app, emit, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const states = spyOn(sdk.client.lifecycle, "states")
    const read = spyOn(sdk.client.session, "goal")

    try {
      emit(goalUpdated("ses_a", goalOf()))
      await advanceUntil(sdk, () => sync.data.goal.ses_a !== undefined)

      // The lifecycle answer lands first and moves the status...
      reconnect()
      await states.mock.results[0].value
      expect(sync.data.goal.ses_a).toEqual(goalOf({ status: "paused" }))

      // ...and the full read that was already out still replaces the goal.
      release.open()
      await read.mock.results[0].value
      expect(sync.data.goal.ses_a).toEqual(updated)
    } finally {
      states.mockRestore()
      read.mockRestore()
      app.renderer.destroy()
    }
  })

  test("the same holds for a hydrated session whose sync reloads the goal", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const release = gate()
    const server = createServer({
      sessions: ["ses_h"],
      goal: async (_sessionID, ordinal) => {
        if (ordinal === 1) return json(goalOf({ turnsUsed: 2 }))
        await release.opened
        return json(goalOf({ turnsUsed: 12, status: "paused" }))
      },
      states: (refs) => json(refs.map(pausedState)),
    })
    const { app, reconnect, sdk, sync } = await mount(server.handler, tmp.path)
    const states = spyOn(sdk.client.lifecycle, "states")
    const read = spyOn(sdk.client.session, "goal")

    try {
      await sync.session.activate("ses_h")
      expect(sync.data.goal.ses_h?.turnsUsed).toBe(2)

      reconnect()
      await states.mock.results[0].value
      expect(sync.data.goal.ses_h?.status).toBe("paused")

      release.open()
      // The second read is the one `sync` made on reconnect.
      await read.mock.results[1].value
      expect(sync.data.goal.ses_h).toMatchObject({ turnsUsed: 12, status: "paused" })
    } finally {
      states.mockRestore()
      read.mockRestore()
      app.renderer.destroy()
    }
  })
})
