// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import type { GlobalEvent, Session, ToolPart } from "@graphagent/sdk"
import { SessionAttentionInput } from "../../../schema/src/session-attention"
import { directory, json } from "../fixture/tui-sdk"
import { sessionFixture, waitFor } from "../routes/dag-mode-harness"
import { mountSessionShell } from "../routes/session-shell"

/**
 * What the session route tells the server about a user who is looking at a background sub-agent (#1033 6).
 *
 * The route owns two attention clients. One follows the open session and reports key activity. The other holds a
 * `backgroundView` lease on the PARENT while the open session is a background sub-agent, and the SDK renews that
 * lease with a 15 second timer. Both send through the fake server of the harness, so every report is read back
 * from the requests it recorded. Whether a session is a background sub-agent comes from the summary layer
 * (`taskIndex`), not from the parent's messages.
 */

const ROOT = "ses_att_root"
const OTHER = "ses_att_other"
const BG_A = "ses_att_bg_a"
const BG_B = "ses_att_bg_b"
const FG = "ses_att_fg"
/** A sub-agent with no Task part behind it, like the session of a workflow node. */
const NODE = "ses_att_node"
const FILLERS = ["ses_att_fill_1", "ses_att_fill_2", "ses_att_fill_3", "ses_att_fill_4"]

type Shell = Awaited<ReturnType<typeof mount>>
type Report = SessionAttentionInput & { sessionID: string }

function taskPart(childID: string, background: boolean): ToolPart {
  return {
    id: `prt_${childID}`,
    sessionID: ROOT,
    messageID: "msg_att_tasks",
    type: "tool",
    callID: `call_${childID}`,
    tool: "task",
    state: {
      status: "completed",
      input: { description: childID, subagent_type: "general" },
      output: "",
      title: childID,
      metadata: { background, sessionID: childID },
      time: { start: 1, end: 2 },
    },
  }
}

/** The Task parts the parent's history holds unless a test says otherwise. */
const defaultParts = () => [taskPart(BG_A, true), taskPart(BG_B, true), taskPart(FG, false)]

/** The parent's message history as the server serves it: one assistant message holding the Task parts. */
function rootHistory(parts: ToolPart[]) {
  if (parts.length === 0) return []
  return [
    {
      info: {
        id: "msg_att_tasks",
        sessionID: ROOT,
        parentID: "msg_att_user",
        role: "assistant",
        agent: "build",
        mode: "build",
        modelID: "m",
        providerID: "test",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, completed: 2 },
        finish: "stop",
      },
      parts,
    },
  ]
}

function child(id: string, created: number): Session {
  return sessionFixture(id, { parentID: ROOT, time: { created, updated: created } })
}

/** Everything a client sent to the attention endpoint, in order. */
function reports(harness: Shell): Report[] {
  return harness.sent.flatMap((item) => {
    const match = item.path.match(/^\/session\/([^/]+)\/attention$/)
    if (!match) return []
    return [{ sessionID: match[1], ...Schema.decodeUnknownSync(SessionAttentionInput)(item.body) }]
  })
}

/** The background-view leases seen so far: one per client that ever reported `backgroundView: true`. */
function leases(harness: Shell) {
  const all = reports(harness)
  const ids = new Set(all.filter((row) => row.backgroundView === true).map((row) => row.clientID))
  return [...ids].map((clientID) => {
    const own = all.filter((row) => row.clientID === clientID)
    return {
      clientID,
      sessionID: own[0].sessionID,
      /** Reports that said the view is open: the first opens the lease, each further one renews it. */
      open: own.filter((row) => row.backgroundView === true && row.closed !== true).length,
      /** Position of the first open report among all reports, to order one lease against another. */
      openedAt: all.findIndex((row) => row.clientID === clientID && row.backgroundView === true),
      /** Position of the close report, or -1 while the lease is still held. */
      closedAt: all.findIndex((row) => row.clientID === clientID && row.closed === true),
    }
  })
}

const HEARTBEAT_MS = 15_000

/**
 * The SDK renews a background view with a 15 second `setInterval`. Bun's fake timers would also stall
 * `Bun.sleep`, which the harness polls with, so only that one timer is taken over: it is held here and fired by
 * hand, once per period that `advance` lets pass. Everything else keeps real timers.
 */
function heartbeatClock() {
  type Handle = Parameters<typeof clearInterval>[0]
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const held = new Map<Handle, () => void>()
  const install = (name: "setInterval" | "clearInterval", value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  install("setInterval", (handler: () => void, timeout?: number, ...args: unknown[]) => {
    if (timeout !== HEARTBEAT_MS) return realSet(handler, timeout, ...args)
    // A real timer that never fires stands in as the handle, so `clearInterval` has something genuine to clear.
    const handle = realSet(() => undefined, 2 ** 31 - 1)
    held.set(handle, handler)
    return handle
  })
  install("clearInterval", (handle: Handle) => {
    held.delete(handle)
    realClear(handle)
  })
  return {
    /** Heartbeat timers the SDK has armed and not cleared. */
    armed: () => held.size,
    /** Fires every armed timer once: one period of the clock. */
    tick() {
      for (const fire of held.values()) fire()
    },
    restore() {
      install("setInterval", realSet)
      install("clearInterval", realClear)
      for (const handle of held.keys()) realClear(handle)
      held.clear()
    },
  }
}

let clock: ReturnType<typeof heartbeatClock> | undefined
afterEach(() => {
  clock?.restore()
  clock = undefined
})

type Options = {
  start?: string
  sessions?: Session[]
  /** The Task parts of the parent's history; read on every `GET`, so a test can change what the server says later. */
  history?: () => ToolPart[]
}

async function mount(options: Options = {}) {
  const heartbeat = heartbeatClock()
  clock = heartbeat
  const history = options.history ?? defaultParts
  const shell = await mountSessionShell({
    sessionID: options.start ?? ROOT,
    sessions: options.sessions ?? [
      sessionFixture(ROOT),
      child(BG_A, 10),
      child(BG_B, 20),
      child(FG, 30),
      child(NODE, 40),
    ],
    handler: (url) => (url.pathname === `/session/${ROOT}/message` ? json(rootHistory(history())) : undefined),
  })
  return { ...shell, heartbeat }
}

/** Every wait gets a generous bound: a slow machine only waits longer, no assertion is weakened. */
const until = (predicate: () => boolean) => waitFor(predicate, 10_000)

function go(harness: Shell, sessionID: string) {
  harness.route().navigate({ type: "session", sessionID })
}

/** Lets `ms` of the heartbeat clock pass one period at a time, each renewal reaching the server before the next. */
async function pass(harness: Shell, ms: number) {
  const open = () => reports(harness).filter((row) => row.backgroundView === true && row.closed !== true).length
  for (let elapsed = HEARTBEAT_MS; elapsed <= ms; elapsed += HEARTBEAT_MS) {
    const expected = open() + harness.heartbeat.armed()
    harness.heartbeat.tick()
    await until(() => open() === expected)
  }
}

function taskPartsInStore(harness: Shell) {
  return Object.values(harness.sync().data.part)
    .flat()
    .filter((part) => part.type === "tool" && part.tool === "task")
}

test("entering a background sub-agent holds one background view on its parent", async () => {
  const harness = await mount()
  try {
    expect(harness.sync().data.taskIndex[BG_A]?.background).toBe(true)
    expect(leases(harness)).toEqual([])
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    const [lease] = leases(harness)
    expect(lease.sessionID).toBe(ROOT)
    expect(lease.open).toBe(1)
    expect(lease.closedAt).toBe(-1)
    expect(reports(harness).filter((row) => row.clientType !== "terminal")).toEqual([])
    expect(harness.heartbeat.armed()).toBe(1)
  } finally {
    await harness.dispose()
  }
})

test("the background view is renewed every fifteen seconds for as long as the view stays open", async () => {
  const harness = await mount()
  try {
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    await pass(harness, 30_000)
    const rows = leases(harness)
    expect(rows).toHaveLength(1)
    expect(rows[0].sessionID).toBe(ROOT)
    // The opening report and one renewal per fifteen seconds, all of one client.
    expect(rows[0].open).toBe(3)
    expect(rows[0].closedAt).toBe(-1)
  } finally {
    await harness.dispose()
  }
})

test("switching to a sibling background sub-agent closes the old lease before the new one opens", async () => {
  const harness = await mount()
  try {
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    go(harness, BG_B)
    await until(() => leases(harness).length === 2)
    await until(() => leases(harness)[0].closedAt >= 0)
    const [closed, current] = leases(harness)
    expect(closed.sessionID).toBe(ROOT)
    expect(current.sessionID).toBe(ROOT)
    expect(closed.clientID).not.toBe(current.clientID)
    expect(closed.closedAt).toBeLessThan(current.openedAt)
    expect(current.closedAt).toBe(-1)

    // Nothing of the old lease is left behind: one timer, and it renews the new lease only.
    expect(harness.heartbeat.armed()).toBe(1)
    const before = reports(harness).filter((row) => row.clientID === closed.clientID).length
    await pass(harness, 30_000)
    expect(reports(harness).filter((row) => row.clientID === closed.clientID)).toHaveLength(before)
    expect(leases(harness)[1].open).toBe(3)
  } finally {
    await harness.dispose()
  }
})

test("moving from a background sub-agent to a foreground sibling closes the lease and opens none", async () => {
  const harness = await mount()
  try {
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    go(harness, FG)
    await until(() => leases(harness)[0].closedAt >= 0)
    await until(() => reports(harness).some((row) => row.sessionID === FG))
    expect(leases(harness)).toHaveLength(1)
    expect(harness.heartbeat.armed()).toBe(0)
  } finally {
    await harness.dispose()
  }
})

test("leaving the sub-agent view closes the lease and stops its heartbeat", async () => {
  const harness = await mount()
  try {
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    go(harness, ROOT)
    await until(() => leases(harness)[0].closedAt >= 0)
    expect(harness.heartbeat.armed()).toBe(0)
    const sent = reports(harness).length
    harness.heartbeat.tick()
    expect(reports(harness)).toHaveLength(sent)
    expect(leases(harness)).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})

test("closing the app closes the lease", async () => {
  const harness = await mount()
  try {
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    harness.app.renderer.destroy()
    await until(() => leases(harness)[0].closedAt >= 0)
    expect(harness.heartbeat.armed()).toBe(0)
    // A close always says the view is no longer open.
    expect(reports(harness).filter((row) => row.closed === true && row.backgroundView !== false)).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("deleting the session being watched closes the lease", async () => {
  const harness = await mount()
  try {
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    // Let the session finish loading first: a snapshot that lands after the deletion would bring it back.
    await until(() => harness.sync().data.message[BG_A] !== undefined)
    const deleted: GlobalEvent = {
      directory,
      payload: {
        id: "evt_att_deleted",
        type: "session.deleted",
        properties: { sessionID: BG_A, info: child(BG_A, 10) },
      },
    }
    harness.events.emit(deleted)
    await until(() => leases(harness)[0].closedAt >= 0)
    expect(harness.heartbeat.armed()).toBe(0)
    expect(leases(harness)).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent that is not a background task holds no background view", async () => {
  const harness = await mount()
  try {
    expect(harness.sync().data.taskIndex[FG]?.background).toBe(false)
    expect(harness.sync().data.taskIndex[NODE]).toBeUndefined()
    for (const id of [FG, NODE]) {
      go(harness, id)
      // The route's own client reports the session it opened, in the same pass that judged it.
      await until(() => reports(harness).some((row) => row.sessionID === id))
      expect(leases(harness), id).toEqual([])
      expect(harness.heartbeat.armed(), id).toBe(0)
    }
  } finally {
    await harness.dispose()
  }
})

test("a background sub-agent still counts after the parent's messages were evicted", async () => {
  let evicted = false
  const harness = await mount({
    sessions: [
      sessionFixture(ROOT),
      child(BG_A, 10),
      child(BG_B, 20),
      child(FG, 30),
      ...FILLERS.map((id) => sessionFixture(id)),
    ],
    history: () => (evicted ? [] : defaultParts()),
  })
  try {
    expect(taskPartsInStore(harness)).not.toEqual([])
    // Opening more sessions than the cache holds pushes the parent out of it, messages and parts with it.
    for (const id of FILLERS) {
      go(harness, id)
      await until(() => harness.sync().data.message[id] !== undefined)
    }
    await until(() => harness.sync().data.message[ROOT] === undefined)
    expect(harness.sync().data.taskIndex[BG_A]?.background).toBe(true)

    // The parent comes back empty when the route loads it again for the sub-agent.
    evicted = true
    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    expect(leases(harness)[0].sessionID).toBe(ROOT)
    expect(taskPartsInStore(harness)).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a background sub-agent counts without the parent's messages ever having been loaded", async () => {
  const harness = await mount({
    start: OTHER,
    sessions: [sessionFixture(OTHER), sessionFixture(ROOT), child(BG_A, 10)],
    history: () => [],
  })
  try {
    // The parent is not open, so only the summary layer hears about its Task part.
    harness.events.emit({
      directory,
      payload: {
        id: "evt_att_task",
        type: "message.part.updated",
        properties: { sessionID: ROOT, time: 5, part: taskPart(BG_A, true) },
      },
    })
    await until(() => harness.sync().data.taskIndex[BG_A]?.background === true)
    expect(harness.sync().data.message[ROOT]).toBeUndefined()

    go(harness, BG_A)
    await until(() => leases(harness).length === 1)
    expect(leases(harness)[0].sessionID).toBe(ROOT)
    expect(taskPartsInStore(harness)).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("keys the keymap handles in a sub-agent view still count as activity", async () => {
  // One sub-agent only: left and right wrap onto the same session, so the activity count stays with one client.
  const harness = await mount({ start: BG_A, sessions: [sessionFixture(ROOT), child(BG_A, 10)] })
  try {
    const counted = () =>
      Math.max(
        0,
        ...reports(harness)
          .filter((row) => row.sessionID === BG_A)
          .map((row) => row.activity ?? 0),
      )
    const keys = {
      right: () => harness.app.mockInput.pressArrow("right"),
      left: () => harness.app.mockInput.pressArrow("left"),
      pagedown: () => harness.app.mockInput.pressKey("\u001B[6~"),
      pageup: () => harness.app.mockInput.pressKey("\u001B[5~"),
      end: () => harness.app.mockInput.pressKey("END"),
      // Bound to nothing in this view: the one kind of key that always counted.
      letter: () => harness.app.mockInput.pressKey("a"),
    }
    let presses = 0
    for (const [name, press] of Object.entries(keys)) {
      press()
      presses++
      // The SDK batches activity per 100 ms, so a later key can take that long to be reported.
      await until(() => counted() === presses)
      expect(counted(), name).toBe(presses)
    }
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
