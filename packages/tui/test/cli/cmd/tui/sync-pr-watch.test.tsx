// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import type { GlobalEvent, PrWatchEntry, SessionReminder } from "@graphagent/sdk"
import { createEventGate } from "../../../../src/context/event-gate"
import { advanceUntil, nextTurn } from "../../../fixture/frames"
import { tmpdir } from "../../../fixture/fixture"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import type { FetchHandler } from "../../../fixture/tui-sdk"
import { directory, json, mount } from "./sync-fixture"

// #1036 F6 data layer: the `pr_watch` and `reminder` slices of the sync store.
//
// `pr.watch.updated` is not durable, so the slice is an upsert of events plus a full read (`GET /session/:id/pr-watch`)
// when a tree is first entered and on reconnect. No event carries the reminders: a `lifecycle.transitioned` of the
// `reminder` domain reads the session's list again.
//
// Time is driven by hand: events reach the store when a test flushes the frame clock, and a read counts as answered
// when the promise the SDK returned for it settles. No test waits for a duration.

let sequence = 0

function global(payload: Record<string, unknown>, workspace?: string): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, project: "proj_test", ...(workspace ? { workspace } : {}), payload } as GlobalEvent
}

/** A fresh object per call: the store reconciles the objects it is handed in place. */
function watch(overrides: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return {
    sessionID: "ses_root",
    watchID: "w1",
    url: "https://forge.test/acme/app/pull/7",
    provider: "github",
    number: 7,
    phase: "watching",
    startedAt: 1_000,
    updatedAt: 2_000,
    deadlineAt: 90_000,
    ...overrides,
  }
}

/** A watch that carries every optional field. */
function busy(overrides: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return watch({
    checks: { total: 3, pending: 2, failed: 0, passed: 1 },
    head: "abc1234",
    review: "approved",
    delivery: { state: "pending" },
    ...overrides,
  })
}

function updated(entry: PrWatchEntry, workspace?: string): GlobalEvent {
  return global({ id: `evt_pr_${++sequence}`, type: "pr.watch.updated", properties: entry }, workspace)
}

function reminder(overrides: Partial<SessionReminder> = {}): SessionReminder {
  return {
    id: "rem_1",
    sessionID: "ses_root",
    text: "check the deploy",
    fireAt: 50_000,
    everyMs: null,
    status: "scheduled",
    createdAt: 1_000,
    ...overrides,
  }
}

function transition(input: {
  domain: string
  id: string
  sessionID?: string
  to: string
  phase: string
  workspace?: string
}): GlobalEvent {
  return global(
    {
      id: `evt_lifecycle_${++sequence}`,
      type: "lifecycle.transitioned",
      properties: {
        domain: input.domain,
        stateID: input.id,
        sessionID: input.sessionID,
        to: input.to,
        phase: input.phase,
        timestamp: 1_000 + sequence,
      },
    },
    input.workspace,
  )
}

function deleted(sessionID: string): GlobalEvent {
  return global({
    id: `evt_deleted_${++sequence}`,
    type: "session.deleted",
    properties: {
      sessionID,
      info: {
        id: sessionID,
        slug: sessionID,
        projectID: "proj_test",
        directory,
        title: sessionID,
        version: "test",
        time: { created: 0, updated: 0 },
      },
    },
  })
}

function row(id: string, parentID?: string) {
  return {
    id,
    slug: id,
    title: id,
    projectID: "proj_test",
    directory,
    version: "test",
    time: { created: 1, updated: 2 },
    ...(parentID ? { parentID } : {}),
  }
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
 * A fake server for the two reads. `prWatch` and `reminder` answer `GET /session/:id/pr-watch` and `/reminder` and get
 * the ordinal of the read; by default a session has nothing. The lifecycle batch a transition queues is answered with
 * no known state.
 */
function createServer(
  input: {
    sessions?: Array<{ id: string; parentID?: string }>
    prWatch?: (sessionID: string, ordinal: number) => Response | Promise<Response>
    reminder?: (sessionID: string, ordinal: number) => Response | Promise<Response>
  } = {},
) {
  const prWatchReads: string[] = []
  const reminderReads: string[] = []
  const workspaces: Array<string | null> = []
  let inFlight = 0
  let maxInFlight = 0
  const track = async (reply: () => Response | Promise<Response>) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      return await reply()
    } finally {
      inFlight--
    }
  }
  const handler: FetchHandler = async (url, request) => {
    const watchRead = url.pathname.match(/^\/session\/([^/]+)\/pr-watch$/)
    if (watchRead) {
      prWatchReads.push(watchRead[1])
      workspaces.push(request?.headers.get("x-graphagent-workspace") ?? null)
      const ordinal = prWatchReads.length
      return track(async () => (await input.prWatch?.(watchRead[1], ordinal)) ?? json({ entries: [] }))
    }
    const reminderRead = url.pathname.match(/^\/session\/([^/]+)\/reminder$/)
    if (reminderRead) {
      reminderReads.push(reminderRead[1])
      const ordinal = reminderReads.length
      return track(async () => (await input.reminder?.(reminderRead[1], ordinal)) ?? json({ entries: [] }))
    }
    if (url.pathname === "/lifecycle/states") return json([])
    const sessions = input.sessions ?? []
    if (url.pathname === "/session") return json(sessions.map((item) => row(item.id, item.parentID)))
    const session = url.pathname.match(/^\/session\/([^/]+)$/)
    const known = sessions.find((item) => item.id === session?.[1])
    if (known) return json(row(known.id, known.parentID))
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json([])
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    // No goal: an empty body would read as an empty goal object.
    if (/^\/session\/[^/]+\/goal$/.test(url.pathname)) return json(null)
    if (url.pathname.startsWith("/dag/session/")) return json([])
    return undefined
  }
  return {
    handler,
    prWatchReads,
    reminderReads,
    workspaces,
    get maxInFlight() {
      return maxInFlight
    },
  }
}

async function withMount(
  server: ReturnType<typeof createServer>,
  run: (ctx: Awaited<ReturnType<typeof mount>>) => Promise<void>,
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const ctx = await mount(server.handler, tmp.path)
  try {
    await run(ctx)
  } finally {
    ctx.app.renderer.destroy()
  }
}

/** Let requests that should never have been sent show up as reads: some event-loop turns, no timer. */
async function settle(turns = 10) {
  for (let turn = 0; turn < turns; turn++) await nextTurn()
}

describe("tui sync pr_watch slice: events", () => {
  test("pr.watch.updated upserts the entry under its root session and watch", async () => {
    await withMount(createServer(), async ({ emit, sdk, sync }) => {
      expect(sync.data.pr_watch).toEqual({})

      emit(updated(busy()))
      emit(updated(watch({ watchID: "w2", number: 8 })))
      emit(updated(watch({ sessionID: "ses_other", watchID: "w3", number: 9 })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_other?.w3 !== undefined)

      expect(sync.data.pr_watch.ses_root.w1).toEqual(busy())
      expect(sync.data.pr_watch.ses_root.w2).toEqual(watch({ watchID: "w2", number: 8 }))
      expect(Object.keys(sync.data.pr_watch.ses_root).toSorted()).toEqual(["w1", "w2"])
      expect(Object.keys(sync.data.pr_watch.ses_other)).toEqual(["w3"])
    })
  })

  test("a later event replaces the entry whole: a field the new state lacks does not linger", async () => {
    await withMount(createServer(), async ({ emit, sdk, sync }) => {
      emit(updated(busy()))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1?.checks !== undefined)

      const ended = watch({ phase: "succeeded", outcome: "success", updatedAt: 3_000 })
      emit(updated(ended))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root.w1.phase === "succeeded")

      const stored = sync.data.pr_watch.ses_root.w1
      expect(stored).toEqual(watch({ phase: "succeeded", outcome: "success", updatedAt: 3_000 }))
      // `toEqual` skips undefined keys; the keys themselves must be gone.
      expect(Object.keys(stored).toSorted()).toEqual(Object.keys(ended).toSorted())
      expect("checks" in stored).toBe(false)
      expect("delivery" in stored).toBe(false)
      expect("head" in stored).toBe(false)
      expect("review" in stored).toBe(false)
    })
  })

  test("an event older than the entry held is ignored", async () => {
    await withMount(createServer(), async ({ emit, sdk, sync }) => {
      emit(updated(watch({ phase: "succeeded", outcome: "success", updatedAt: 5_000 })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)

      // Delivered late: the watch has left this state. The next event is the marker that this one was handled.
      emit(updated(busy({ phase: "watching", updatedAt: 4_000 })))
      emit(updated(watch({ watchID: "w2" })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root.w2 !== undefined)

      expect(sync.data.pr_watch.ses_root.w1).toEqual(
        watch({ phase: "succeeded", outcome: "success", updatedAt: 5_000 }),
      )
    })
  })

  test("an event with the same stamp as the entry held is applied: a redelivery changes nothing", async () => {
    await withMount(createServer(), async ({ emit, sdk, sync }) => {
      emit(updated(busy({ updatedAt: 3_000 })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)

      emit(updated(busy({ updatedAt: 3_000, head: "def5678" })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root.w1.head === "def5678")
      expect(sync.data.pr_watch.ses_root.w1).toEqual(busy({ updatedAt: 3_000, head: "def5678" }))
    })
  })

  test("an event routed to another workspace is ignored", async () => {
    await withMount(createServer(), async ({ emit, project, sdk, sync }) => {
      project.workspace.set("wrk-current")
      emit(updated(watch(), "wrk-foreign"))
      // The marker: handled after the foreign event, in the current workspace.
      emit(updated(watch({ watchID: "w2" }), "wrk-current"))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w2 !== undefined)

      expect(Object.keys(sync.data.pr_watch.ses_root)).toEqual(["w2"])
    })
  })

  test("the gate delivers the event for a session that is not in the full set", () => {
    const gate = createEventGate(() => new Set())
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture.
    expect(gate(updated(watch()).payload as never)).toBe("deliver")
  })

  test("events write no message or part, and nothing outside their own slice", async () => {
    await withMount(createServer(), async ({ emit, sdk, sync }) => {
      const probe = probeStoreWrites(sync.data, ["message", "part", "summary", "pr_watch", "reminder"])
      try {
        emit(updated(busy()))
        emit(updated(watch({ phase: "succeeded", outcome: "success", updatedAt: 3_000 })))
        emit(updated(watch({ sessionID: "ses_other", watchID: "w3" })))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_other?.w3 !== undefined)

        expect(probe.writes("message")).toBe(0)
        expect(probe.writes("part")).toBe(0)
        expect(probe.writes("summary")).toBe(0)
        expect(probe.writes("reminder")).toBe(0)
        expect(probe.writes("pr_watch")).toBeGreaterThan(0)
      } finally {
        probe.dispose()
      }
    })
  })
})

describe("tui sync pr_watch and reminder slices: reads", () => {
  test("entering a tree reads the PR watches and the reminders of its root, once", async () => {
    const server = createServer({
      sessions: [{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }],
      prWatch: () => json({ entries: [busy()] }),
      reminder: () => json({ entries: [reminder()] }),
    })
    await withMount(server, async ({ sdk, sync }) => {
      // Entering through a child: the watches and the reminders belong to the root.
      await sync.session.activate("ses_child")
      await advanceUntil(
        sdk,
        () => sync.data.pr_watch.ses_root !== undefined && sync.data.reminder.ses_root !== undefined,
      )

      expect(sync.data.pr_watch.ses_root).toEqual({ w1: busy() })
      expect(sync.data.reminder.ses_root).toEqual([reminder()])
      expect(sync.data.pr_watch.ses_child).toBeUndefined()
      expect(sync.data.reminder.ses_child).toBeUndefined()
      expect(server.prWatchReads).toEqual(["ses_root"])
      expect(server.reminderReads).toEqual(["ses_root"])

      // Entering any session of the tree again, or the root itself, finds the slices held.
      await sync.session.activate("ses_root")
      await sync.session.activate("ses_child")
      await settle()
      expect(server.prWatchReads).toEqual(["ses_root"])
      expect(server.reminderReads).toEqual(["ses_root"])
    })
  })

  test("a tree with nothing to show holds empty slices and is not read again on re-entry", async () => {
    const server = createServer({ sessions: [{ id: "ses_root" }] })
    await withMount(server, async ({ sdk, sync }) => {
      await sync.session.activate("ses_root")
      await advanceUntil(
        sdk,
        () => sync.data.pr_watch.ses_root !== undefined && sync.data.reminder.ses_root !== undefined,
      )

      expect(sync.data.pr_watch.ses_root).toEqual({})
      expect(sync.data.reminder.ses_root).toEqual([])
      sync.session.deactivate()
      await sync.session.activate("ses_root")
      await settle()
      expect(server.prWatchReads).toEqual(["ses_root"])
      expect(server.reminderReads).toEqual(["ses_root"])
    })
  })

  test("an event that reaches a root before its first entry does not stand in for the snapshot", async () => {
    const server = createServer({
      sessions: [{ id: "ses_root" }],
      prWatch: () => json({ entries: [watch({ watchID: "w2", number: 8 }), watch()] }),
    })
    await withMount(server, async ({ emit, sdk, sync }) => {
      // The event creates the root's map with the one watch it names; the server holds two.
      emit(updated(watch({ updatedAt: 3_000 })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)

      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w2 !== undefined)
      expect(server.prWatchReads).toEqual(["ses_root"])
      // The event is newer than the answer's w1 and stays; the watch only the read knows is added.
      expect(sync.data.pr_watch.ses_root).toEqual({
        w1: watch({ updatedAt: 3_000 }),
        w2: watch({ watchID: "w2", number: 8 }),
      })

      // Once the read answered, the next entry finds the snapshot held.
      sync.session.deactivate()
      await sync.session.activate("ses_root")
      await settle()
      expect(server.prWatchReads).toEqual(["ses_root"])
    })
  })

  test("a failed first read leaves the slice absent, and the next entry reads it again", async () => {
    const server = createServer({
      sessions: [{ id: "ses_root" }],
      prWatch: (_sessionID, ordinal) =>
        ordinal === 1
          ? new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
          : json({ entries: [watch()] }),
    })
    await withMount(server, async ({ sdk, sync }) => {
      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => server.prWatchReads.length === 1 && sync.data.reminder.ses_root !== undefined)
      await settle()
      expect(sync.data.pr_watch.ses_root).toBeUndefined()

      sync.session.deactivate()
      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root !== undefined)
      expect(sync.data.pr_watch.ses_root).toEqual({ w1: watch() })
      expect(server.prWatchReads).toEqual(["ses_root", "ses_root"])
    })
  })

  test("a reconnect reads the root of the route again when its first read failed", async () => {
    const server = createServer({
      sessions: [{ id: "ses_root" }],
      prWatch: (_sessionID, ordinal) =>
        ordinal === 1
          ? new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
          : json({ entries: [watch()] }),
    })
    await withMount(server, async ({ reconnect, sdk, sync }) => {
      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => server.prWatchReads.length === 1 && sync.data.reminder.ses_root !== undefined)
      await settle()
      // Nothing is held for the root, so only the route says it is worth reading.
      expect(sync.data.pr_watch.ses_root).toBeUndefined()

      reconnect()
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)
      expect(server.prWatchReads).toEqual(["ses_root", "ses_root"])
    })
  })

  test("a read that returns what is held writes nothing", async () => {
    const server = createServer({
      prWatch: () => json({ entries: [busy()] }),
      reminder: () => json({ entries: [reminder(), reminder({ id: "rem_2", fireAt: 70_000 })] }),
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      emit(updated(busy()))
      emit(transition({ domain: "reminder", id: "rem_1", sessionID: "ses_root", to: "scheduled", phase: "waiting" }))
      await advanceUntil(
        sdk,
        () => sync.data.pr_watch.ses_root !== undefined && sync.data.reminder.ses_root !== undefined,
      )
      const watches = spyOn(sdk.client.session, "prWatch")
      const reminders = spyOn(sdk.client.session, "reminder")
      const probe = probeStoreWrites(sync.data, ["pr_watch", "reminder"])
      try {
        reconnect()
        await advanceUntil(sdk, () => watches.mock.calls.length === 1 && reminders.mock.calls.length === 1)
        await watches.mock.results[0].value
        await reminders.mock.results[0].value

        // The answers matched the store field for field: no node was rewritten, so nothing that reads them reruns.
        expect(probe.writes("pr_watch")).toBe(0)
        expect(probe.writes("reminder")).toBe(0)
      } finally {
        probe.dispose()
        watches.mockRestore()
        reminders.mockRestore()
      }
    })
  })

  test("a read carries the current workspace", async () => {
    const server = createServer({ sessions: [{ id: "ses_root" }] })
    await withMount(server, async ({ project, sdk, sync }) => {
      project.workspace.set("wrk-current")
      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root !== undefined)

      expect(server.workspaces).toEqual(["wrk-current"])
    })
  })

  test("a reconnect reads every root held again and replaces its map: a watch the answer lacks is dropped", async () => {
    const answers: Record<string, PrWatchEntry[]> = {
      ses_root: [busy({ phase: "delivering", updatedAt: 4_000 })],
      ses_other: [],
    }
    const server = createServer({ prWatch: (sessionID) => json({ entries: answers[sessionID] ?? [] }) })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      emit(updated(busy()))
      emit(updated(watch({ watchID: "w2", number: 8 })))
      emit(updated(watch({ sessionID: "ses_other", watchID: "w3", number: 9 })))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_other?.w3 !== undefined)

      reconnect()
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w2 === undefined)

      expect(sync.data.pr_watch.ses_root).toEqual({ w1: busy({ phase: "delivering", updatedAt: 4_000 }) })
      // The answer for the other root is empty: its map stays, with nothing in it.
      expect(sync.data.pr_watch.ses_other).toEqual({})
      expect(server.prWatchReads.toSorted()).toEqual(["ses_other", "ses_root"])
    })
  })

  test("a reconnect also reads the root of the route, whether it held anything or not", async () => {
    let answer: PrWatchEntry[] = []
    const server = createServer({
      sessions: [{ id: "ses_root" }],
      prWatch: () => json({ entries: answer }),
    })
    await withMount(server, async ({ reconnect, sdk, sync }) => {
      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root !== undefined)
      expect(sync.data.pr_watch.ses_root).toEqual({})

      // The watch was registered while the stream was down: no event, only the read can tell.
      answer = [watch()]
      const before = server.prWatchReads.length
      reconnect()
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)
      expect(server.prWatchReads.slice(before)).toEqual(["ses_root"])
    })
  })

  test("a reconnect reads nothing when no root is held and no route is open", async () => {
    const server = createServer()
    await withMount(server, async ({ reconnect }) => {
      reconnect()
      await settle()
      expect(server.prWatchReads).toEqual([])
      expect(server.reminderReads).toEqual([])
    })
  })

  test("a write that disposes the instance reads the root of the route and every root held again", async () => {
    const watches: Record<string, PrWatchEntry[]> = {
      ses_root: [watch()],
      ses_other: [watch({ sessionID: "ses_other", watchID: "w3", number: 9 })],
    }
    const reminders: Record<string, SessionReminder[]> = { ses_root: [reminder()] }
    const server = createServer({
      sessions: [{ id: "ses_root" }],
      prWatch: (sessionID) => json({ entries: watches[sessionID] ?? [] }),
      reminder: (sessionID) => json({ entries: reminders[sessionID] ?? [] }),
    })
    await withMount(server, async ({ emit, sdk, sync }) => {
      await sync.session.activate("ses_root")
      emit(updated(watch({ sessionID: "ses_other", watchID: "w3", number: 9 })))
      await advanceUntil(
        sdk,
        () =>
          sync.data.pr_watch.ses_root?.w1 !== undefined &&
          sync.data.pr_watch.ses_other?.w3 !== undefined &&
          sync.data.reminder.ses_root !== undefined,
      )
      const watchReads = server.prWatchReads.length
      const reminderReads = server.reminderReads.length

      // The new instance holds other state, and no event says so: the watch ended, the reminder is gone.
      watches.ses_root = [watch({ phase: "succeeded", outcome: "success", updatedAt: 4_000 })]
      watches.ses_other = []
      reminders.ses_root = []
      emit(global({ id: `evt_disposed_${++sequence}`, type: "server.instance.disposed", properties: { directory } }))
      await advanceUntil(
        sdk,
        () => sync.data.pr_watch.ses_root.w1.phase === "succeeded" && sync.data.reminder.ses_root.length === 0,
      )

      expect(server.prWatchReads.slice(watchReads).toSorted()).toEqual(["ses_other", "ses_root"])
      expect(server.reminderReads.slice(reminderReads)).toEqual(["ses_root"])
      expect(sync.data.pr_watch.ses_other).toEqual({})
    })
  })

  test("a write that disposes the instance reads the root of the route even when it held nothing", async () => {
    let answer: PrWatchEntry[] = []
    const server = createServer({ sessions: [{ id: "ses_root" }], prWatch: () => json({ entries: answer }) })
    await withMount(server, async ({ emit, sdk, sync }) => {
      await sync.session.activate("ses_root")
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root !== undefined)
      expect(sync.data.pr_watch.ses_root).toEqual({})

      answer = [watch()]
      emit(global({ id: `evt_disposed_${++sequence}`, type: "server.instance.disposed", properties: { directory } }))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)
      expect(server.prWatchReads).toEqual(["ses_root", "ses_root"])
    })
  })

  test("a write that disposes the instance reads nothing when no root is held and no route is open", async () => {
    const server = createServer()
    await withMount(server, async ({ emit }) => {
      emit(global({ id: `evt_disposed_${++sequence}`, type: "server.instance.disposed", properties: { directory } }))
      await settle()
      expect(server.prWatchReads).toEqual([])
      expect(server.reminderReads).toEqual([])
    })
  })

  test("a reconnect reads the reminders of every session held again and replaces the list", async () => {
    const answers: Record<string, SessionReminder[]> = {
      ses_root: [reminder()],
      ses_other: [reminder({ id: "rem_9", sessionID: "ses_other" })],
    }
    const server = createServer({ reminder: (sessionID) => json({ entries: answers[sessionID] ?? [] }) })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      emit(transition({ domain: "reminder", id: "rem_1", sessionID: "ses_root", to: "scheduled", phase: "waiting" }))
      emit(transition({ domain: "reminder", id: "rem_9", sessionID: "ses_other", to: "scheduled", phase: "waiting" }))
      await advanceUntil(
        sdk,
        () => sync.data.reminder.ses_root !== undefined && sync.data.reminder.ses_other !== undefined,
      )
      expect(sync.data.reminder.ses_root).toEqual([reminder()])
      server.reminderReads.length = 0

      // While the stream was down the first reminder fired, a second was set, and the other session's was cancelled.
      answers.ses_root = [reminder({ id: "rem_2", fireAt: 60_000, status: "due" })]
      answers.ses_other = []
      reconnect()
      await advanceUntil(
        sdk,
        () => sync.data.reminder.ses_root?.[0]?.id === "rem_2" && sync.data.reminder.ses_other?.length === 0,
      )

      expect(sync.data.reminder.ses_root).toEqual([reminder({ id: "rem_2", fireAt: 60_000, status: "due" })])
      expect(sync.data.reminder.ses_other).toEqual([])
      expect(server.reminderReads.toSorted()).toEqual(["ses_other", "ses_root"])
    })
  })

  test("reads run a few at a time", async () => {
    const release = gate()
    const ids = Array.from({ length: 10 }, (_, index) => `ses_${index}`)
    const server = createServer({
      prWatch: async () => {
        await release.opened
        return json({ entries: [] })
      },
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      for (const id of ids) emit(updated(watch({ sessionID: id, watchID: `w_${id}` })))
      await advanceUntil(sdk, () => ids.every((id) => sync.data.pr_watch[id] !== undefined))

      reconnect()
      await advanceUntil(sdk, () => server.prWatchReads.length >= 4)
      await settle()
      // The first round holds four; the rest wait for it to finish.
      expect(server.prWatchReads).toHaveLength(4)

      release.open()
      await advanceUntil(sdk, () => ids.every((id) => Object.keys(sync.data.pr_watch[id]).length === 0))
      expect(server.prWatchReads.toSorted()).toEqual(ids)
      expect(server.maxInFlight).toBe(4)
    })
  })
})

describe("tui sync pr_watch slice: reads racing events and each other", () => {
  test("a newer reconnect supersedes a round that has not finished", async () => {
    const release = gate()
    const ids = Array.from({ length: 10 }, (_, index) => `ses_${index}`)
    const server = createServer({
      prWatch: async (_sessionID, ordinal) => {
        // Only the first round's reads wait; the second reconnect's are answered at once.
        if (ordinal <= 4) await release.opened
        return json({ entries: [] })
      },
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      for (const id of ids) emit(updated(watch({ sessionID: id, watchID: `w_${id}` })))
      await advanceUntil(sdk, () => ids.every((id) => sync.data.pr_watch[id] !== undefined))

      reconnect()
      await advanceUntil(sdk, () => server.prWatchReads.length === 4)
      reconnect()
      await advanceUntil(sdk, () => ids.every((id) => Object.keys(sync.data.pr_watch[id]).length === 0))
      // Four reads of the first round, and every root again for the second.
      expect(server.prWatchReads).toHaveLength(4 + ids.length)

      // The first round resumes: its answers are stale and it starts nothing more.
      release.open()
      await settle(30)
      expect(server.prWatchReads).toHaveLength(4 + ids.length)
    })
  })

  test("an entry an event delivers while a read is out stays; the answer fills in and drops the rest", async () => {
    const release = gate()
    const server = createServer({
      prWatch: async () => {
        await release.opened
        // Written before the events below: it knows w1 as it was, and w2, but not w3.
        return json({ entries: [busy({ updatedAt: 2_000 }), watch({ watchID: "w2", number: 8, updatedAt: 2_500 })] })
      },
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      const read = spyOn(sdk.client.session, "prWatch")
      try {
        emit(updated(busy()))
        emit(updated(watch({ watchID: "w4", number: 10 })))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w4 !== undefined)

        reconnect()
        await advanceUntil(sdk, () => server.prWatchReads.length === 1)
        emit(updated(busy({ phase: "delivering", updatedAt: 3_000 })))
        emit(updated(watch({ watchID: "w3", number: 9, updatedAt: 3_100 })))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root.w3 !== undefined)

        release.open()
        await read.mock.results[0].value

        const stored = sync.data.pr_watch.ses_root
        // w1: the event is newer than the answer. w2: only the answer knows it. w3: only the event does.
        // w4: held before the read, and the answer does not return it.
        expect(Object.keys(stored).toSorted()).toEqual(["w1", "w2", "w3"])
        expect(stored.w1).toEqual(busy({ phase: "delivering", updatedAt: 3_000 }))
        expect(stored.w2).toEqual(watch({ watchID: "w2", number: 8, updatedAt: 2_500 }))
        expect(stored.w3).toEqual(watch({ watchID: "w3", number: 9, updatedAt: 3_100 }))
      } finally {
        read.mockRestore()
      }
    })
  })

  test("an answer that carries a later state of an entry an event touched wins over the event", async () => {
    const release = gate()
    const server = createServer({
      prWatch: async () => {
        await release.opened
        return json({ entries: [watch({ phase: "succeeded", outcome: "success", updatedAt: 6_000 })] })
      },
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      const read = spyOn(sdk.client.session, "prWatch")
      try {
        emit(updated(watch()))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)

        reconnect()
        await advanceUntil(sdk, () => server.prWatchReads.length === 1)
        emit(updated(watch({ phase: "delivering", updatedAt: 3_000 })))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root.w1.phase === "delivering")

        release.open()
        await read.mock.results[0].value
        expect(sync.data.pr_watch.ses_root.w1).toEqual(
          watch({ phase: "succeeded", outcome: "success", updatedAt: 6_000 }),
        )
      } finally {
        read.mockRestore()
      }
    })
  })

  test("a newer read supersedes one that has not finished: the slower, older answer is dropped", async () => {
    const release = gate()
    const server = createServer({
      prWatch: async (_sessionID, ordinal) => {
        if (ordinal > 1) return json({ entries: [watch({ watchID: "new", updatedAt: 8_000 })] })
        await release.opened
        return json({ entries: [watch({ watchID: "old", updatedAt: 3_000 })] })
      },
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      const read = spyOn(sdk.client.session, "prWatch")
      try {
        emit(updated(watch()))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)

        reconnect()
        await advanceUntil(sdk, () => server.prWatchReads.length === 1)
        reconnect()
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.new !== undefined)

        // The first read comes back last and predates the second reconnect.
        release.open()
        await read.mock.results[0].value
        expect(Object.keys(sync.data.pr_watch.ses_root)).toEqual(["new"])
      } finally {
        read.mockRestore()
      }
    })
  })

  test("a read that is out when its session is deleted does not bring the entries back", async () => {
    const release = gate()
    const server = createServer({
      prWatch: async () => {
        await release.opened
        return json({ entries: [watch()] })
      },
    })
    await withMount(server, async ({ emit, reconnect, sdk, sync }) => {
      const read = spyOn(sdk.client.session, "prWatch")
      try {
        emit(updated(watch()))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)

        reconnect()
        await advanceUntil(sdk, () => server.prWatchReads.length === 1)
        emit(deleted("ses_root"))
        await advanceUntil(sdk, () => sync.data.pr_watch.ses_root === undefined)

        release.open()
        await read.mock.results[0].value
        expect(sync.data.pr_watch.ses_root).toBeUndefined()
      } finally {
        read.mockRestore()
      }
    })
  })
})

describe("tui sync reminder slice", () => {
  test("a lifecycle transition of a reminder reads that session's list once and replaces the slice", async () => {
    let list: SessionReminder[] = [reminder(), reminder({ id: "rem_2", fireAt: 70_000 })]
    const server = createServer({ reminder: () => json({ entries: list }) })
    await withMount(server, async ({ emit, sdk, sync }) => {
      expect(sync.data.reminder).toEqual({})

      emit(transition({ domain: "reminder", id: "rem_1", sessionID: "ses_root", to: "scheduled", phase: "waiting" }))
      await advanceUntil(sdk, () => sync.data.reminder.ses_root !== undefined)
      expect(sync.data.reminder.ses_root).toEqual([reminder(), reminder({ id: "rem_2", fireAt: 70_000 })])
      expect(server.reminderReads).toEqual(["ses_root"])

      // The first one fired and is no longer in the list; the second moved up.
      list = [reminder({ id: "rem_2", fireAt: 70_000, status: "due" })]
      emit(transition({ domain: "reminder", id: "rem_1", sessionID: "ses_root", to: "fired", phase: "succeeded" }))
      await advanceUntil(sdk, () => sync.data.reminder.ses_root.length === 1)
      expect(sync.data.reminder.ses_root).toEqual([reminder({ id: "rem_2", fireAt: 70_000, status: "due" })])
      expect(server.reminderReads).toEqual(["ses_root", "ses_root"])
    })
  })

  test("transitions of other domains, and of a reminder with no session, read nothing", async () => {
    const server = createServer()
    await withMount(server, async ({ emit, sdk, sync }) => {
      emit(transition({ domain: "goal", id: "ses_root", sessionID: "ses_root", to: "active", phase: "running" }))
      emit(transition({ domain: "pr_watch", id: "w1", sessionID: "ses_root", to: "watching", phase: "running" }))
      emit(transition({ domain: "job", id: "job_1", sessionID: "ses_root", to: "running", phase: "running" }))
      emit(transition({ domain: "reminder", id: "rem_1", to: "scheduled", phase: "waiting" }))
      // The marker: handled after the transitions above.
      emit(updated(watch()))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)
      await settle()

      expect(server.reminderReads).toEqual([])
      expect(server.prWatchReads).toEqual([])
      expect(sync.data.reminder).toEqual({})
    })
  })

  test("a transition routed to another workspace reads nothing", async () => {
    const server = createServer()
    await withMount(server, async ({ emit, project, sdk, sync }) => {
      project.workspace.set("wrk-current")
      emit(
        transition({
          domain: "reminder",
          id: "rem_1",
          sessionID: "ses_root",
          to: "due",
          phase: "waiting",
          workspace: "wrk-foreign",
        }),
      )
      emit(updated(watch(), "wrk-current"))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root?.w1 !== undefined)
      await settle()

      expect(server.reminderReads).toEqual([])
    })
  })

  test("a read that finishes after a newer one does not overwrite it", async () => {
    const release = gate()
    const server = createServer({
      reminder: async (_sessionID, ordinal) => {
        if (ordinal > 1) return json({ entries: [reminder({ id: "rem_new", fireAt: 90_000 })] })
        await release.opened
        return json({ entries: [reminder({ id: "rem_old" })] })
      },
    })
    await withMount(server, async ({ emit, sdk, sync }) => {
      const read = spyOn(sdk.client.session, "reminder")
      try {
        emit(
          transition({ domain: "reminder", id: "rem_old", sessionID: "ses_root", to: "scheduled", phase: "waiting" }),
        )
        await advanceUntil(sdk, () => server.reminderReads.length === 1)
        emit(
          transition({ domain: "reminder", id: "rem_new", sessionID: "ses_root", to: "scheduled", phase: "waiting" }),
        )
        await advanceUntil(sdk, () => sync.data.reminder.ses_root?.[0]?.id === "rem_new")

        release.open()
        await read.mock.results[0].value
        expect(sync.data.reminder.ses_root.map((item) => item.id)).toEqual(["rem_new"])
      } finally {
        read.mockRestore()
      }
    })
  })

  test("the transition writes no message or part", async () => {
    const server = createServer({ reminder: () => json({ entries: [reminder()] }) })
    await withMount(server, async ({ emit, sdk, sync }) => {
      const probe = probeStoreWrites(sync.data, ["message", "part", "summary", "reminder"])
      try {
        emit(transition({ domain: "reminder", id: "rem_1", sessionID: "ses_root", to: "scheduled", phase: "waiting" }))
        await advanceUntil(sdk, () => sync.data.reminder.ses_root !== undefined)

        expect(probe.writes("message")).toBe(0)
        expect(probe.writes("part")).toBe(0)
        expect(probe.writes("summary")).toBe(0)
        expect(probe.writes("reminder")).toBe(1)
      } finally {
        probe.dispose()
      }
    })
  })
})

describe("tui sync pr_watch and reminder slices: deleting the session", () => {
  test("session.deleted clears both slices of that session and leaves the others", async () => {
    const server = createServer({ reminder: () => json({ entries: [reminder()] }) })
    await withMount(server, async ({ emit, sdk, sync }) => {
      emit(updated(watch()))
      emit(updated(watch({ sessionID: "ses_other", watchID: "w3" })))
      emit(transition({ domain: "reminder", id: "rem_1", sessionID: "ses_root", to: "scheduled", phase: "waiting" }))
      await advanceUntil(
        sdk,
        () =>
          sync.data.pr_watch.ses_other?.w3 !== undefined &&
          sync.data.pr_watch.ses_root?.w1 !== undefined &&
          sync.data.reminder.ses_root !== undefined,
      )

      emit(deleted("ses_root"))
      await advanceUntil(sdk, () => sync.data.pr_watch.ses_root === undefined)

      expect(sync.data.reminder.ses_root).toBeUndefined()
      expect(sync.data.pr_watch.ses_other.w3).toEqual(watch({ sessionID: "ses_other", watchID: "w3" }))
    })
  })
})
