// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { lifecycleKey } from "../../../../src/context/lifecycle-mirror"
import { backgroundElapsed, backgroundItems, type BackgroundItem } from "../../../../src/session/background"
import { tmpdir } from "../../../fixture/fixture"
import { advanceUntil, nextTurn } from "../../../fixture/frames"
import type { FetchHandler } from "../../../fixture/tui-sdk"
import { directory, json, mount } from "./sync-fixture"

// #1058: the data layer of background tasks. A background Task part completes as soon as the run starts, so how the
// run ended reaches the store from two other places: the message the server adds to the parent session when the run
// ends (it becomes `taskIndex[child].result`), and the state of the job the run owns (`lifecycle["job:<child>"]`,
// which the client has to ask for when it never saw the transition).
//
// Time is driven by hand, as in the lifecycle mirror tests: events reach the store when a test flushes the frame
// clock, and a read counts as answered when the promise `sdk.client.lifecycle` returned for it settles.

const ROOT = "ses_root"

type Ref = { domain: string; id: string }
type Row = {
  id: string
  slug: string
  projectID: string
  directory: string
  version: string
  title: string
  parentID?: string
  time: { created: number; updated: number }
}

function row(id: string, parentID?: string): Row {
  return {
    id,
    slug: id,
    title: id,
    projectID: "proj_test",
    directory,
    version: "test",
    parentID,
    time: { created: 1_000, updated: 5_000 },
  }
}

const rows = [row(ROOT), ...[1, 2, 3, 4, 5].map((n) => row(`ses_bg${n}`, ROOT))]

function global(payload: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, project: "proj_test", payload } as GlobalEvent
}

let sequence = 0

function partEvent(part: { sessionID: string }, time = 10): GlobalEvent {
  return global({
    id: `evt_bg_${++sequence}`,
    type: "message.part.updated",
    properties: { sessionID: part.sessionID, time, part },
  })
}

function transition(input: { id: string; from?: string; to: string; phase: string; reason?: string }) {
  return global({
    id: `evt_bg_${++sequence}`,
    type: "lifecycle.transitioned",
    properties: {
      domain: "job",
      stateID: input.id,
      sessionID: input.id,
      from: input.from,
      to: input.to,
      phase: input.phase,
      reason: input.reason,
      timestamp: 1_000 + sequence,
    },
  })
}

/** The Task part the parent shows for the background run of `ses_bg<n>`. */
function taskPart(n: number, overrides: { id?: string; messageID?: string; state?: Record<string, unknown> } = {}) {
  return {
    id: overrides.id ?? `prt_task_${n}`,
    sessionID: ROOT,
    messageID: overrides.messageID ?? "msg_tasks",
    type: "tool" as const,
    tool: "task",
    callID: `call_task_${n}`,
    state: {
      status: "completed",
      input: { description: `Scan area ${n}`, subagent_type: "explore" },
      output: "started",
      title: `Scan area ${n}`,
      metadata: { sessionID: `ses_bg${n}`, background: true, initiator: "agent", jobId: `ses_bg${n}` },
      time: { start: 100 * n, end: 100 * n + 1 },
      ...overrides.state,
    },
  }
}

/** The text part of the message the server adds to the parent session when the run of `ses_bg<n>` ends. */
function resultPart(n: number, overrides: { id?: string; messageID?: string; result?: Record<string, unknown> } = {}) {
  return {
    id: overrides.id ?? `prt_result_${n}`,
    sessionID: ROOT,
    messageID: overrides.messageID ?? `msg_result_${n}`,
    type: "text" as const,
    synthetic: true,
    text: `Background task ses_bg${n} finished`,
    metadata: {
      backgroundResult: {
        childSessionID: `ses_bg${n}`,
        initiator: "agent",
        title: `Scan area ${n}`,
        status: "completed",
        startedAt: 100 * n,
        endedAt: 100 * n + 50,
        ...overrides.result,
      },
    },
  }
}

type Loaded = Record<string, Array<{ info: Record<string, unknown>; parts: unknown[] }>>

function message(id: string, role: "user" | "assistant", created: number) {
  return role === "user"
    ? { id, sessionID: ROOT, role, time: { created }, agent: "build" }
    : { id, sessionID: ROOT, role, time: { created, completed: created + 1 }, agent: "build", mode: "build" }
}

function sessionRoutes(messages: () => Loaded) {
  const byID = new Map(rows.map((item) => [item.id, item]))
  return (url: URL) => {
    if (url.pathname === "/session") return json(rows)
    if (url.pathname.startsWith("/dag/session/")) return json([])
    const match = url.pathname.match(/^\/session\/([^/]+)$/)
    if (match && byID.has(match[1])) return json(byID.get(match[1]))
    const loaded = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (loaded) return json(messages()[loaded[1]] ?? [])
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    // No goal: a hydrated session with one would add a `goal` ref to what a reconnect asks about.
    if (/^\/session\/[^/]+\/goal$/.test(url.pathname)) return new Response(null, { status: 404 })
    return undefined
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

/** The values the owner answers with, by job id; a job that is not listed is unknown to it. */
type States = Record<string, { value: string; phase: string; since?: number }>

function answerFor(ref: Ref, states: States) {
  const state = states[ref.id]
  if (!state) return { domain: ref.domain, id: ref.id, state: null }
  return {
    domain: ref.domain,
    id: ref.id,
    state: {
      domain: ref.domain,
      id: ref.id,
      value: state.value,
      phase: state.phase,
      terminal: state.phase !== "running",
      settled: state.phase === "succeeded",
      source: "live",
      observedAt: 5_000,
      ...(state.since === undefined ? {} : { since: state.since }),
    },
  }
}

/** Mounts the sync layer over a fake server that records the refs of every `POST /lifecycle/states`. */
async function open(path: string, input: { messages?: Loaded; states?: States } = {}) {
  const messages = { current: input.messages ?? {} }
  const states: States = input.states ?? {}
  const calls: Ref[][] = []
  const routes = sessionRoutes(() => messages.current)
  const handler: FetchHandler = async (url, request) => {
    if (url.pathname !== "/lifecycle/states") return routes(url)
    const body: unknown = await request?.json()
    const refs =
      typeof body === "object" && body !== null && "refs" in body && Array.isArray(body.refs) ? body.refs : []
    const checked = refs.filter(isRef)
    calls.push(checked)
    return json(checked.map((ref) => answerFor(ref, states)))
  }
  const view = await mount(handler, path)
  const spy = spyOn(view.sdk.client.lifecycle, "states")
  const reads = {
    sent: () => spy.mock.calls.length,
    answered: (index: number) => {
      const read = spy.mock.results[index]
      if (!read) throw new Error(`read ${index} was never sent`)
      return read.value
    },
  }
  return {
    ...view,
    calls,
    states,
    messages,
    reads,
    flush: () => view.sdk.frameClock.flushNow(),
    close() {
      spy.mockRestore()
      view.app.renderer.destroy()
    },
  }
}

type View = Awaited<ReturnType<typeof open>>

/** Emits the parts one frame at a time, so each lands before the next is looked at. */
function emitParts(view: View, ...parts: Array<{ sessionID: string; [key: string]: unknown }>) {
  for (const part of parts) view.emit(partEvent(part))
  view.flush()
}

describe("the result of a background run", () => {
  test("a result message completes the link of its run, and a later write of the Task part keeps it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { sync } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(view, taskPart(1))
      expect(sync.data.taskIndex.ses_bg1).toEqual({
        parentSessionID: ROOT,
        parentMessageID: "msg_tasks",
        partID: "prt_task_1",
        kind: "explore",
        description: "Scan area 1",
        background: true,
        initiator: "agent",
        startedAt: 100,
      })
      // The Task part says nothing about how the run ended, and the link has no key for it.
      expect(sync.data.taskIndex.ses_bg1).not.toHaveProperty("result")

      emitParts(view, resultPart(1))
      expect(sync.data.taskIndex.ses_bg1.result).toEqual({
        status: "completed",
        title: "Scan area 1",
        initiator: "agent",
        startedAt: 100,
        endedAt: 150,
        messageID: "msg_result_1",
        partID: "prt_result_1",
      })
      // The link itself is the Task part's.
      expect(sync.data.taskIndex.ses_bg1).toMatchObject({ partID: "prt_task_1", description: "Scan area 1" })

      // The Task part is written again (a rename here stands for any change): the link follows, the result stays.
      emitParts(view, taskPart(1, { state: { input: { description: "Scan area one", subagent_type: "explore" } } }))
      expect(sync.data.taskIndex.ses_bg1.description).toBe("Scan area one")
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({ status: "completed", endedAt: 150 })
    } finally {
      view.close()
    }
  })

  test("a result that ended earlier than the one held does not replace it; a later one does", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { sync } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(view, taskPart(1), resultPart(1))
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({ status: "completed", endedAt: 150 })

      emitParts(
        view,
        resultPart(1, { id: "prt_older", messageID: "msg_older", result: { status: "error", endedAt: 120 } }),
      )
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({
        status: "completed",
        endedAt: 150,
        partID: "prt_result_1",
      })

      // The same result written again is the same result; a later end replaces it.
      emitParts(view, resultPart(1))
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({ status: "completed", endedAt: 150 })
      emitParts(
        view,
        resultPart(1, { id: "prt_newer", messageID: "msg_newer", result: { status: "error", endedAt: 400 } }),
      )
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({
        status: "error",
        endedAt: 400,
        messageID: "msg_newer",
        partID: "prt_newer",
      })
    } finally {
      view.close()
    }
  })

  test("a call that cancels a task does not overwrite the link of the call that started it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { sync } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(view, taskPart(1), resultPart(1))
      const cancel = (n: number) =>
        taskPart(n, {
          id: `prt_cancel_${n}`,
          messageID: "msg_cancel",
          state: {
            input: { action: "cancel", task_id: `ses_bg${n}` },
            title: "Cancelled",
            metadata: { sessionID: `ses_bg${n}` },
          },
        })

      emitParts(view, cancel(1))
      expect(sync.data.taskIndex.ses_bg1).toMatchObject({
        partID: "prt_task_1",
        parentMessageID: "msg_tasks",
        kind: "explore",
        description: "Scan area 1",
        background: true,
        initiator: "agent",
      })
      expect(sync.data.taskIndex.ses_bg1.result?.status).toBe("completed")

      // Cancelling a task this client holds no link for makes none either.
      emitParts(view, cancel(4))
      expect(sync.data.taskIndex.ses_bg4).toBeUndefined()
      // The parent still counts the call as a tool call: only the link is left out.
      expect(sync.data.summary[ROOT].toolCalls).toBe(3)
    } finally {
      view.close()
    }
  })

  test("a result for a run whose Task part was not seen creates a minimal link, which the part fills later", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { sync } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(view, resultPart(2, { result: { initiator: "user", command: "/scan area 2" } }))
      expect(sync.data.taskIndex.ses_bg2).toEqual({
        parentSessionID: ROOT,
        parentMessageID: "msg_result_2",
        partID: "prt_result_2",
        description: "Scan area 2",
        background: true,
        initiator: "user",
        command: "/scan area 2",
        result: {
          status: "completed",
          title: "Scan area 2",
          initiator: "user",
          command: "/scan area 2",
          startedAt: 200,
          endedAt: 250,
          messageID: "msg_result_2",
          partID: "prt_result_2",
        },
      })

      // The Task part arrives (a replay out of order): it replaces the link's own fields and keeps the result.
      emitParts(
        view,
        taskPart(2, {
          state: {
            metadata: {
              sessionID: "ses_bg2",
              background: true,
              initiator: "user",
              command: "/scan area 2",
              promoted: true,
            },
          },
        }),
      )
      expect(sync.data.taskIndex.ses_bg2).toMatchObject({
        partID: "prt_task_2",
        parentMessageID: "msg_tasks",
        kind: "explore",
        promoted: true,
        initiator: "user",
        command: "/scan area 2",
        startedAt: 200,
      })
      expect(sync.data.taskIndex.ses_bg2.result).toMatchObject({ status: "completed", partID: "prt_result_2" })
    } finally {
      view.close()
    }
  })

  test("malformed result metadata and text that is not synthetic leave the links alone", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { sync } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(
        view,
        taskPart(1),
        { ...resultPart(1, { id: "prt_forged" }), synthetic: false },
        resultPart(3, { id: "prt_bad", result: { status: "running" } }),
        resultPart(4, { id: "prt_nan", result: { endedAt: Number.NaN } }),
      )
      expect(sync.data.taskIndex.ses_bg1).not.toHaveProperty("result")
      expect(sync.data.taskIndex.ses_bg3).toBeUndefined()
      expect(sync.data.taskIndex.ses_bg4).toBeUndefined()
    } finally {
      view.close()
    }
  })

  test("a snapshot of the parent rebuilds the links with their results, and never lowers one it holds", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messages: Loaded = {
      [ROOT]: [
        {
          info: message("msg_tasks", "assistant", 10),
          parts: [
            taskPart(1),
            taskPart(3, { state: { metadata: { sessionID: "ses_bg3", background: false } } }),
            taskPart(4),
          ],
        },
        { info: message("msg_result_1", "user", 20), parts: [resultPart(1)] },
        // The Task part of this run is outside the window the snapshot holds.
        {
          info: message("msg_result_5", "user", 30),
          parts: [resultPart(5, { result: { initiator: "user", command: "/scan area 5" } })],
        },
      ],
    }
    const view = await open(tmp.path, { messages })
    const { sync } = view

    try {
      expect(Object.keys(sync.data.taskIndex)).toEqual([])
      await sync.session.sync(ROOT)

      expect(Object.keys(sync.data.taskIndex).toSorted()).toEqual(["ses_bg1", "ses_bg3", "ses_bg4", "ses_bg5"])
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({
        status: "completed",
        endedAt: 150,
        partID: "prt_result_1",
      })
      expect(sync.data.taskIndex.ses_bg1).toMatchObject({ partID: "prt_task_1", kind: "explore", startedAt: 100 })
      expect(sync.data.taskIndex.ses_bg3).toMatchObject({ background: false })
      expect(sync.data.taskIndex.ses_bg3).not.toHaveProperty("result")
      expect(sync.data.taskIndex.ses_bg4).not.toHaveProperty("result")
      expect(sync.data.taskIndex.ses_bg5).toMatchObject({
        parentSessionID: ROOT,
        parentMessageID: "msg_result_5",
        partID: "prt_result_5",
        background: true,
        initiator: "user",
        command: "/scan area 5",
      })
      expect(sync.data.taskIndex.ses_bg5.result?.status).toBe("completed")

      // The stream was down: the run of ses_bg4 ended meanwhile, and the snapshot holds an older result of ses_bg1.
      messages[ROOT] = [
        ...messages[ROOT],
        { info: message("msg_result_4", "user", 40), parts: [resultPart(4, { result: { status: "error" } })] },
        {
          info: message("msg_result_1_old", "user", 15),
          parts: [
            resultPart(1, {
              id: "prt_result_1_old",
              messageID: "msg_result_1_old",
              result: { status: "error", endedAt: 120 },
            }),
          ],
        },
      ]
      view.reconnect()
      await advanceUntil(view.sdk, () => sync.data.taskIndex.ses_bg4?.result !== undefined)
      expect(sync.data.taskIndex.ses_bg4.result).toMatchObject({ status: "error", endedAt: 450 })
      expect(sync.data.taskIndex.ses_bg4).toMatchObject({ partID: "prt_task_4", kind: "explore" })
      expect(sync.data.taskIndex.ses_bg1.result).toMatchObject({ status: "completed", endedAt: 150 })
    } finally {
      view.close()
    }
  })
})

describe("the job of a background run", () => {
  test("a cold history asks once for the jobs of its background runs that have no result", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messages: Loaded = {
      [ROOT]: [
        {
          info: message("msg_tasks", "assistant", 10),
          parts: [
            taskPart(1),
            taskPart(2),
            taskPart(3, { state: { metadata: { sessionID: "ses_bg3", background: false } } }),
          ],
        },
        { info: message("msg_result_2", "user", 20), parts: [resultPart(2)] },
      ],
    }
    const view = await open(tmp.path, { messages, states: { ses_bg1: { value: "running", phase: "running" } } })
    const { sync, reads } = view

    try {
      await sync.session.sync(ROOT)
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      // ses_bg2 has its result and ses_bg3 ran in the foreground: only ses_bg1 is asked about.
      expect(view.calls[0]).toEqual([{ domain: "job", id: "ses_bg1" }])
      await reads.answered(0)
      expect(sync.data.lifecycle["job:ses_bg1"]).toMatchObject({ value: "running" })
    } finally {
      view.close()
    }
  })

  test("a snapshot of a resumed task does not give the new run the old run's result", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messages: Loaded = {
      [ROOT]: [
        { info: message("msg_result_1", "user", 20), parts: [resultPart(1)] },
        // The same child resumed after its result (ended at 150): the newest Task part started at 500.
        {
          info: message("msg_tasks", "assistant", 30),
          parts: [taskPart(1, { id: "prt_task_1_again", state: { time: { start: 500, end: 501 } } })],
        },
      ],
    }
    const view = await open(tmp.path, { messages, states: { ses_bg1: { value: "running", phase: "running" } } })
    const { sync } = view

    try {
      await sync.session.sync(ROOT)
      expect(sync.data.taskIndex.ses_bg1).toMatchObject({ partID: "prt_task_1_again", startedAt: 500 })
      expect(sync.data.taskIndex.ses_bg1).not.toHaveProperty("result")
      // With no result the run's job is asked about.
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      expect(view.calls[0]).toEqual([{ domain: "job", id: "ses_bg1" }])
    } finally {
      view.close()
    }
  })

  test("a resumed task starts a new run: the result of the old run is dropped and its job asked about", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { sync, reads } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(view, resultPart(1), taskPart(1))
      expect(sync.data.taskIndex.ses_bg1.result?.endedAt).toBe(150)
      expect(reads.sent()).toBe(0)

      // The same child is resumed after its result ended.
      emitParts(view, taskPart(1, { id: "prt_task_1_again", state: { time: { start: 500, end: 501 } } }))
      expect(sync.data.taskIndex.ses_bg1).not.toHaveProperty("result")
      expect(sync.data.taskIndex.ses_bg1).toMatchObject({ partID: "prt_task_1_again", startedAt: 500 })
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      expect(view.calls[0]).toEqual([{ domain: "job", id: "ses_bg1" }])
    } finally {
      view.close()
    }
  })

  test("a background Task part whose job nobody reported asks the owner once", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path, { states: { ses_bg1: { value: "running", phase: "running" } } })
    const { sync, reads } = view

    try {
      // A foreground run has its answer in the Task part: nothing is asked.
      emitParts(view, taskPart(3, { state: { metadata: { sessionID: "ses_bg3", background: false } } }))
      expect(reads.sent()).toBe(0)

      // The same flush that stores the link asks about its job.
      emitParts(view, taskPart(1))
      expect(reads.sent()).toBe(1)
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      expect(view.calls[0]).toEqual([{ domain: "job", id: "ses_bg1" }])
      await reads.answered(0)
      // The job was never seen in a transition: the owner's answer is what the mirror holds, for the child session.
      expect(sync.data.lifecycle["job:ses_bg1"]).toMatchObject({
        domain: "job",
        id: "ses_bg1",
        sessionID: "ses_bg1",
        value: "running",
        phase: "running",
        at: 5_000,
      })

      // The Task part is written again: the link is not new and the job is known, so nothing more is asked.
      emitParts(view, taskPart(1))
      await nextTurn()
      view.flush()
      expect(reads.sent()).toBe(1)
    } finally {
      view.close()
    }
  })

  test("a job whose transition was seen is not asked about twice in one frame", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path, { states: { ses_bg2: { value: "running", phase: "running" } } })
    const { reads } = view

    try {
      view.emit(transition({ id: "ses_bg2", to: "running", phase: "running" }))
      view.emit(partEvent(taskPart(2)))
      view.flush()
      expect(reads.sent()).toBe(1)
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      expect(view.calls[0]).toEqual([{ domain: "job", id: "ses_bg2" }])
    } finally {
      view.close()
    }
  })

  test("a link that already has its result asks nothing, wherever the Task part comes from", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path)
    const { reads } = view

    try {
      await view.sync.session.activate(ROOT)
      emitParts(view, resultPart(3))
      emitParts(view, taskPart(3))
      await nextTurn()
      view.flush()
      expect(reads.sent()).toBe(0)
    } finally {
      view.close()
    }
  })

  test("an answer for a job whose session was deleted while the read was out is not kept", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path, { states: { ses_bg1: { value: "running", phase: "running" } } })
    const { sync, reads } = view

    try {
      emitParts(view, taskPart(1))
      expect(reads.sent()).toBe(1)
      // The parent goes away before the answer is applied: its links go with it.
      view.emit(
        global({
          id: `evt_bg_${++sequence}`,
          type: "session.deleted",
          properties: { sessionID: ROOT, info: rows[0] },
        }),
      )
      view.flush()
      expect(sync.data.taskIndex.ses_bg1).toBeUndefined()
      await reads.answered(0)
      expect(sync.data.lifecycle["job:ses_bg1"]).toBeUndefined()
    } finally {
      view.close()
    }
  })

  test("a reconnect asks again for the jobs of runs no result has ended, even if the mirror holds none", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    // The owner knows no job yet: every answer is null, so the mirror keeps nothing of the first reads.
    const view = await open(tmp.path)
    const { sync, reads } = view

    try {
      await sync.session.activate(ROOT)
      emitParts(
        view,
        taskPart(1),
        taskPart(2),
        taskPart(3, { state: { metadata: { sessionID: "ses_bg3", background: false } } }),
      )
      expect(reads.sent()).toBe(1)
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      expect(view.calls[0]).toEqual([
        { domain: "job", id: "ses_bg1" },
        { domain: "job", id: "ses_bg2" },
      ])
      await reads.answered(0)
      expect(Object.keys(sync.data.lifecycle)).toEqual([])

      // The run of ses_bg1 ends; ses_bg2 is still going and the owner knows it by now.
      emitParts(view, resultPart(1))
      view.states.ses_bg2 = { value: "running", phase: "running" }
      view.reconnect()
      expect(reads.sent()).toBe(2)
      await advanceUntil(view.sdk, () => view.calls.length === 2)
      expect(view.calls[1]).toEqual([{ domain: "job", id: "ses_bg2" }])
      await reads.answered(1)
      expect(sync.data.lifecycle["job:ses_bg2"]).toMatchObject({ value: "running", sessionID: "ses_bg2" })
    } finally {
      view.close()
    }
  })

  test("the reason a transition gave survives the answer that confirms its value, not one that changes it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const view = await open(tmp.path, {
      states: { ses_bg1: { value: "error", phase: "failed" }, ses_bg2: { value: "completed", phase: "succeeded" } },
    })
    const { sync, reads } = view

    try {
      view.emit(transition({ id: "ses_bg1", from: "running", to: "error", phase: "failed", reason: "process_restart" }))
      view.emit(transition({ id: "ses_bg2", from: "running", to: "error", phase: "failed", reason: "process_restart" }))
      view.flush()
      expect(sync.data.lifecycle["job:ses_bg1"]?.reason).toBe("process_restart")
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      await reads.answered(0)

      // The owner agrees with the first (the answer has no reason of its own) and corrects the second.
      expect(sync.data.lifecycle["job:ses_bg1"]).toMatchObject({ value: "error", reason: "process_restart", at: 5_000 })
      expect(sync.data.lifecycle["job:ses_bg2"]).toMatchObject({ value: "completed", at: 5_000 })
      expect(sync.data.lifecycle["job:ses_bg2"]).not.toHaveProperty("reason")
    } finally {
      view.close()
    }
  })
})

// #1407: the queue of background runs. The server tells a run that waits for its slot (`queued`) from one that holds it
// (`running`, with `since`, the moment it began), so the surfaces read the queue instead of guessing it from the child.
describe("the queue of background runs", () => {
  /** The background runs of the root as every surface lists them, from what the data layer holds. */
  function groups(view: View) {
    const { sync } = view
    return backgroundItems({
      taskIndex: sync.data.taskIndex,
      rootID: ROOT,
      job: (id) => sync.data.lifecycle[lifecycleKey({ domain: "job", id })],
      summary: (id) => sync.data.summary[id],
    })
  }
  const ids = (items: BackgroundItem[]) => items.map((item) => item.sessionID)

  test("a limit of one: the first run runs, the second and third wait, and each runs the moment it begins", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    // Three tasks started at 100, 200 and 300; the first holds the slot since 150.
    const view = await open(tmp.path, {
      states: {
        ses_bg1: { value: "running", phase: "running", since: 150 },
        ses_bg2: { value: "queued", phase: "pending", since: 200 },
        ses_bg3: { value: "queued", phase: "pending", since: 300 },
      },
    })
    const { sync, reads } = view

    try {
      await sync.session.activate(ROOT)
      for (const n of [1, 2, 3]) view.emit(transition({ id: `ses_bg${n}`, to: "queued", phase: "pending" }))
      view.emit(transition({ id: "ses_bg1", from: "queued", to: "running", phase: "running" }))
      view.emit(partEvent(taskPart(1)))
      view.emit(partEvent(taskPart(2)))
      view.emit(partEvent(taskPart(3)))
      view.flush()

      // The events alone say it: the second and third are queued, the first runs, though no child has shown anything.
      expect(sync.data.lifecycle["job:ses_bg2"]).toMatchObject({ value: "queued", phase: "pending" })
      expect(ids(groups(view).running)).toEqual(["ses_bg1"])
      expect(ids(groups(view).queued)).toEqual(["ses_bg3", "ses_bg2"])

      // The owner's answer agrees, and brings the moment the first run began.
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      await reads.answered(0)
      expect(sync.data.lifecycle["job:ses_bg1"]).toMatchObject({ value: "running", since: 150, at: 5_000 })
      expect(sync.data.lifecycle["job:ses_bg2"]).toMatchObject({ value: "queued", since: 200 })
      const waiting = groups(view)
      expect(ids(waiting.running)).toEqual(["ses_bg1"])
      expect(ids(waiting.queued)).toEqual(["ses_bg3", "ses_bg2"])
      expect(waiting.running[0].runningAt).toBe(150)
      // The run is timed from the moment it began (150), not from its Task call (100).
      expect(backgroundElapsed(waiting.running[0], 1_150)).toBe(1_000)

      // The first ends. The second is next in line and begins: the owner says so, and its child has not been busy or
      // called a tool, which is exactly where the inference said "queued".
      view.states.ses_bg1 = { value: "completed", phase: "succeeded" }
      view.states.ses_bg2 = { value: "running", phase: "running", since: 950 }
      view.emit(transition({ id: "ses_bg1", from: "running", to: "completed", phase: "succeeded" }))
      view.emit(transition({ id: "ses_bg2", from: "queued", to: "running", phase: "running" }))
      view.emit(partEvent(resultPart(1)))
      view.flush()
      expect(sync.data.summary.ses_bg2?.toolCalls ?? 0).toBe(0)
      expect(sync.data.summary.ses_bg2?.status).not.toBe("busy")
      expect(ids(groups(view).running)).toEqual(["ses_bg2"])
      expect(ids(groups(view).queued)).toEqual(["ses_bg3"])
      expect(ids(groups(view).finished)).toEqual(["ses_bg1"])
      await advanceUntil(view.sdk, () => view.calls.length === 2)
      await reads.answered(1)
      const next = groups(view)
      expect(next.running[0].runningAt).toBe(950)
      expect(backgroundElapsed(next.running[0], 1_450)).toBe(500)
      expect(ids(next.queued)).toEqual(["ses_bg3"])
    } finally {
      view.close()
    }
  })

  test("a server that does not report the queue is read by the inference, as before", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    // An older server starts a job `running` and never says `queued`: no `since` on any answer.
    const view = await open(tmp.path, {
      states: {
        ses_bg1: { value: "running", phase: "running" },
        ses_bg2: { value: "running", phase: "running" },
      },
    })
    const { sync, reads } = view

    try {
      await sync.session.activate(ROOT)
      view.emit(transition({ id: "ses_bg1", to: "running", phase: "running" }))
      view.emit(transition({ id: "ses_bg2", to: "running", phase: "running" }))
      view.emit(partEvent(taskPart(1)))
      view.emit(partEvent(taskPart(2)))
      view.flush()
      await advanceUntil(view.sdk, () => view.calls.length === 1)
      await reads.answered(0)
      expect(sync.data.lifecycle["job:ses_bg1"]).not.toHaveProperty("since")

      // Both children have shown nothing: waiting for a slot, as far as the inference can tell.
      expect(ids(groups(view).queued)).toEqual(["ses_bg2", "ses_bg1"])
      expect(groups(view).queued.map((item) => item.runningAt)).toEqual([undefined, undefined])

      // A child that called a tool runs; the time of such a run is counted from its Task call.
      const read = {
        id: "prt_tool_1",
        sessionID: "ses_bg1",
        messageID: "msg_child",
        type: "tool" as const,
        tool: "read",
        callID: "call_read_1",
        state: {
          status: "completed",
          input: { filePath: "a.ts" },
          output: "",
          title: "a.ts",
          metadata: {},
          time: { start: 400, end: 401 },
        },
      }
      view.emit(partEvent(read))
      view.flush()
      expect(ids(groups(view).running)).toEqual(["ses_bg1"])
      expect(ids(groups(view).queued)).toEqual(["ses_bg2"])
      expect(backgroundElapsed(groups(view).running[0], 1_100)).toBe(1_100 - 100)
    } finally {
      view.close()
    }
  })
})
