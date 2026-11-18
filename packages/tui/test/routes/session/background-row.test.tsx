// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { TextRenderable, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { produce } from "solid-js/store"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { GlobalEvent, Session, TextPart, ToolPart } from "@graphagent/sdk"
import { DEFAULT_THEME } from "../../../src/context/theme"
import type { Ticker } from "../../../src/context/ticker"
import { setLanguage } from "../../../src/i18n"
import { WINDOW_MIN_ROWS } from "../../../src/routes/session/rows"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
import { AppRoutes } from "../../fixture/route-frame"
import {
  assistantMessage,
  taskCall,
  textPart,
  userMessage,
  type MessageEntry as Entry,
} from "../../fixture/session-records"
import { directory, json, type FetchHandler } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor } from "../dag-mode-harness"

/**
 * The Task row of a background run (#1058): the title says who asked for the run and where it runs, the line under it
 * says what the run is doing, and the time on it moves with the one-second clock only while the row is on screen.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

const ROOT = "ses_bgrow_root"
/** The clock of the tests, and the start of every run: 1m 5s before it. */
const NOW = 2_000_000
const START = NOW - 65_000

const root = sessionFixture(ROOT, { title: "root", time: { created: 1, updated: 2 } })
const childID = (key: string) => `ses_bgrow_${key}`
const child = (key: string) =>
  sessionFixture(childID(key), {
    parentID: ROOT,
    title: key,
    agent: "explore",
    time: { created: 1_000, updated: 2_000 },
  })

type TaskOptions = { initiator?: "user" | "agent"; promoted?: boolean; background?: boolean; status?: "running" }

/** The Task call that started the run `key`; its description is `Scan <key>`. */
function task(key: string, options: TaskOptions = {}) {
  return taskCall({
    parentID: ROOT,
    messageID: "msg_bgrow_assistant",
    id: `prt_bgrow_${key}`,
    childID: childID(key),
    description: `Scan ${key}`,
    background: true,
    initiator: "agent",
    start: START,
    ...options,
  })
}

type Status = "completed" | "error" | "interrupted"

/** The text part of the message the server adds to the parent session when the run `key` has ended. */
function resultPart(key: string, status: Status): TextPart {
  return {
    id: `prt_bgrow_result_${key}`,
    sessionID: ROOT,
    messageID: `msg_bgrow_result_${key}`,
    type: "text",
    synthetic: true,
    text: `Background task ${childID(key)} finished`,
    metadata: {
      backgroundResult: {
        childSessionID: childID(key),
        initiator: "agent",
        title: `Scan ${key}`,
        status,
        startedAt: START,
        endedAt: START + 65_000,
      },
    },
  }
}

let sequence = 0
function partEvent(part: TextPart | ToolPart): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    payload: {
      id: `evt_bgrow_${++sequence}`,
      type: "message.part.updated",
      properties: { sessionID: part.sessionID, time: 40, part },
    },
  } as GlobalEvent
}

/** What the owner of the jobs answers, by child session id; a run that is not listed is unknown to it. */
type States = Record<string, { value: string; phase: string }>

const RUNNING = { value: "running", phase: "running" }
const COMPLETED = { value: "completed", phase: "succeeded" }
const FAILED = { value: "error", phase: "failed" }
const CANCELLED = { value: "cancelled", phase: "cancelled" }

function lifecycle(states: States): FetchHandler {
  return async (url, request) => {
    if (url.pathname !== "/lifecycle/states") return undefined
    const body: unknown = await request?.json()
    const refs =
      typeof body === "object" && body !== null && "refs" in body && Array.isArray(body.refs) ? body.refs : []
    return json(
      refs.map((ref: { domain: string; id: string }) => {
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
            observedAt: NOW,
          },
        }
      }),
    )
  }
}

/** Text parts enough to make the parent's transcript windowed: 90 messages of a few dozen parts each. */
function bulk(): Entry[] {
  const entries: Entry[] = []
  const perMessage = Math.ceil(WINDOW_MIN_ROWS / 90)
  for (let index = 0; index < 90; index++) {
    const id = `msg_bgrow_bulk_${index}`
    entries.push({
      info: assistantMessage(id, ROOT, "msg_bgrow_user", 15 + index / 100),
      parts: Array.from({ length: perMessage }, (_, part) =>
        textPart(id, ROOT, `prt_bgrow_bulk_${index}_${part}`, `bulk ${index}.${part}`),
      ),
    })
  }
  return entries
}

type MountOptions = {
  language?: "zh-CN" | "en"
  ambiguousWidth?: 1 | 2
  width?: number
  height?: number
  /** The runs, by key: one Task call and one child session each. */
  tasks: Array<ReturnType<typeof task>>
  results?: TextPart[]
  states?: States
  /** Enough rows before the Task calls for the transcript to be windowed. */
  windowed?: boolean
  ticker?: Ticker
}

async function mount(options: MountOptions) {
  const keys = options.tasks.map((part) => part.id.replace("prt_bgrow_", ""))
  const entries: Entry[] = [
    {
      info: userMessage("msg_bgrow_user", ROOT, 10),
      parts: [textPart("msg_bgrow_user", ROOT, "prt_bgrow_prompt", "scan everything")],
    },
    ...(options.windowed ? bulk() : []),
    { info: assistantMessage("msg_bgrow_assistant", ROOT, "msg_bgrow_user", 20), parts: options.tasks },
    ...(options.results ?? []).map((part, index) => ({
      info: userMessage(part.messageID, ROOT, 30 + index),
      parts: [part],
    })),
  ]
  const answers = lifecycle(options.states ?? {})
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <AppRoutes />,
    frame: true,
    sessions: [root, ...keys.map(child)] satisfies Session[],
    handler: (url, request) => (url.pathname === `/session/${ROOT}/message` ? json(entries) : answers(url, request)),
    language: options.language,
    kv: options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : undefined,
    ticker: options.ticker,
    width: options.width ?? 80,
    height: options.height ?? 50,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

type Harness = Awaited<ReturnType<typeof mount>>

/** The first line that holds `needle`, without its margins; the row under it is `after`. */
function rowOf(frame: string, needle: string, after = 0) {
  const lines = frame.split("\n")
  const index = lines.findIndex((line) => line.includes(needle))
  return index < 0 ? undefined : lines[index + after]?.trim()
}

/** The color of the first span that holds `needle`. */
async function colorOf(harness: Harness, needle: string) {
  const frame = await harness.spans()
  for (const line of frame.lines) {
    const span = line.spans.find((item) => item.text.includes(needle))
    if (span) return span.fg
  }
  return undefined
}

/** A one-second clock the test drives; it counts who listens to it. */
function clockTicker(start = NOW) {
  const [second, setSecond] = createSignal(0)
  let now = start
  const calls = { frame: 0, second: 0, released: 0 }
  const ticker: Ticker = {
    frame: () => 0,
    second,
    subscribe() {
      calls.frame++
      return () => {}
    },
    subscribeSecond() {
      calls.second++
      return () => {
        calls.released++
      }
    },
    at: () => () => {},
    now: () => now,
  }
  return {
    ticker,
    calls,
    /** Subscriptions to the second clock that are held now. */
    listeners: () => calls.second - calls.released,
    advance(ms: number) {
      now += ms
      setSecond((value) => value + 1)
    },
  }
}

/** One run of each status, and what the line under its title says in each language. */
const RUNS = [
  { key: "queued", en: "queued · waiting for a slot", zh: "排队中 · 等待并发槽位" },
  { key: "running", en: "running · 3 tool calls · 1m 5s", zh: "运行中 · 3 次工具调用 · 1m 5s" },
  { key: "done", en: "done · 1m 5s · result below", zh: "完成 · 1m 5s · 结果见下方" },
  { key: "bare", en: "done · —", zh: "完成 · —" },
  { key: "failed", en: "failed · boom: connection refused", zh: "失败 · boom: connection refused" },
  { key: "nocause", en: "failed", zh: "失败" },
  { key: "interrupted", en: "interrupted · can be run again", zh: "已中断 · 可重新运行" },
  { key: "cancelled", en: "cancelled", zh: "已取消" },
  // Nothing says how it stands: the line of a call that has ended, with the span the child's own times give.
  { key: "unknown", en: "— · 1.0s", zh: "— · 1.0s" },
] as const

const STATES: States = {
  [childID("queued")]: RUNNING,
  [childID("running")]: RUNNING,
  [childID("done")]: COMPLETED,
  [childID("bare")]: COMPLETED,
  [childID("failed")]: FAILED,
  [childID("nocause")]: FAILED,
  [childID("interrupted")]: FAILED,
  [childID("cancelled")]: CANCELLED,
}

/** The runs of `RUNS` on screen, with what the child sessions say of them. */
async function mountRuns(options: Pick<MountOptions, "language" | "ambiguousWidth" | "ticker"> = {}) {
  const harness = await mount({
    ticker: clockTicker().ticker,
    ...options,
    height: 60,
    tasks: RUNS.map((run) => task(run.key)),
    results: [resultPart("done", "completed"), resultPart("interrupted", "interrupted")],
    states: STATES,
  })
  harness.sync().set("summary", childID("running"), "status", "busy")
  harness.sync().set("summary", childID("running"), "toolCalls", 3)
  harness.sync().set("summary", childID("failed"), "error", "boom: connection refused\n    at run (task.ts:42)")
  return harness
}

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`every status is one line under the title, and all of it fits 80 columns, in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      const harness = await mountRuns({ language, ambiguousWidth })
      try {
        const lang = language === "en" ? "en" : "zh"
        const labels = language === "en" ? "main agent · background" : "主 agent · 后台"
        const frame = await harness.waitForFrame(
          (value) => RUNS.every((run) => rowOf(value, `Scan ${run.key} `, 1) === `↳ ${run[lang]}`),
          "every status line",
        )
        for (const run of RUNS) {
          expect(rowOf(frame, `Scan ${run.key} `)).toEndWith(`Explore Task — Scan ${run.key} · ${labels}`)
          // The line is one row: the row after it is the gap before the next run.
          expect(rowOf(frame, `Scan ${run.key} `, 2)).toBe("")
        }
        // The rows of the runs, from the first title to the last status line; the prompt's own border below them is
        // drawn with glyphs whose width the setting changes, and is not what is measured here.
        const lines = frame.split("\n")
        const first = lines.findIndex((line) => line.includes("Scan queued "))
        const last = lines.findIndex((line) => line.includes("Scan unknown ")) + 1
        expect(first).toBeGreaterThan(0)
        for (const line of lines.slice(first, last + 1)) {
          expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        }
        expect(harness.writes()).toEqual([])
      } finally {
        await harness.dispose()
      }
    })
  }
}

test("a call that cancels a task names the task it stops, not a run of its own", async () => {
  const started = task("target")
  const cancel = task("cancel")
  // The cancel call carries the task it stops and no description; its metadata points at that task's child.
  cancel.state = {
    ...cancel.state,
    input: { action: "cancel", task_id: childID("target") },
    metadata: { parentSessionID: ROOT, sessionID: childID("target"), background: true, jobId: childID("target") },
  } as typeof cancel.state
  for (const language of ["en", "zh-CN"] as const) {
    const harness = await mount({ language, tasks: [started, cancel] })
    try {
      const expected = language === "en" ? "cancel background task “Scan target”" : "取消后台任务「Scan target」"
      const frame = await harness.waitForFrame((value) => value.includes(expected), "the cancel call")
      expect(frame).not.toContain(language === "en" ? "Delegating..." : "委派中…")
      // The started task keeps its own row: the cancel call did not overwrite its link.
      expect(frame).toContain("Explore Task — Scan target")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  }
})

test("a streamed call whose arguments arrive after it mounted becomes the cancel row", async () => {
  const started = task("target")
  const streamed = task("cancel")
  // The part is first published with no arguments, the way a streamed tool call starts.
  streamed.state = { ...streamed.state, status: "running", input: {}, metadata: {} } as typeof streamed.state
  const harness = await mount({ language: "en", tasks: [started, streamed] })
  try {
    await harness.waitForFrame((value) => value.includes("Explore Task — Scan target"), "the started task")
    const cancel = {
      ...streamed,
      state: {
        ...streamed.state,
        input: { action: "cancel", task_id: childID("target") },
        metadata: { parentSessionID: ROOT, sessionID: childID("target"), background: true, jobId: childID("target") },
      },
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the event carries a tool part; the helper is typed for text parts.
    harness.events.emit(partEvent(cancel as unknown as TextPart))
    await harness.waitForFrame((value) => value.includes("cancel background task “Scan target”"), "the cancel row")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

const LANGUAGES: Array<"en" | "zh-CN"> = ["en", "zh-CN"]

/**
 * The call that reads a task's log, as the tool records it (#1453): the task it reads and no description, and metadata
 * that names no session, since the call started none. `key` makes its part and the message of its row.
 */
function readCall(
  key: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  status: "running" | "completed" = "completed",
) {
  const part = task(key)
  part.state =
    status === "running"
      ? { status, input, metadata, time: { start: START } }
      : { status, input, output: "task_id: ses", title: "Task log", metadata, time: { start: START, end: START + 1 } }
  return part
}

test("a call that reads a task's log names the task it reads, in one line, not a run of its own", async () => {
  const started = task("target")
  const named = readCall("read", { action: "read", task_id: childID("target"), page: 2 }, { taskID: childID("target") })
  // A task the data layer knows nothing of is named by its id.
  const byID = readCall(
    "unknown",
    { action: "read", task_id: "ses_bgrow_elsewhere" },
    { taskID: "ses_bgrow_elsewhere" },
  )
  for (const language of LANGUAGES) {
    const harness = await mount({ language, tasks: [started, named, byID] })
    try {
      const forNamed = language === "en" ? "read the log of task “Scan target”" : "读取任务「Scan target」的日志"
      const forID =
        language === "en" ? "read the log of task “ses_bgrow_elsewhere”" : "读取任务「ses_bgrow_elsewhere」的日志"
      const frame = await harness.waitForFrame(
        (value) => value.includes(forNamed) && value.includes(forID),
        "the read calls",
      )
      // Not the waiting state a call with no description would keep in a run's row.
      expect(frame).not.toContain(language === "en" ? "Delegating..." : "委派中…")
      // The started task keeps its own row: the read call did not overwrite its link.
      expect(frame).toContain("Explore Task — Scan target")
      // One line: no run title, no status line under it.
      expect(rowOf(frame, forNamed, 1) ?? "").not.toStartWith("↳")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  }
})

test("a streamed call whose arguments arrive after it mounted becomes the read row", async () => {
  const started = task("target")
  // The part is first published with no arguments, the way a streamed tool call starts.
  const streamed = readCall("read", {}, {}, "running")
  const harness = await mount({ language: "en", tasks: [started, streamed] })
  try {
    await harness.waitForFrame((value) => value.includes("Explore Task — Scan target"), "the started task")
    const read = readCall("read", { action: "read", task_id: childID("target") }, { taskID: childID("target") })
    harness.events.emit(partEvent(read))
    await harness.waitForFrame((value) => value.includes("read the log of task “Scan target”"), "the read row")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a run's color and icon say how it stands", async () => {
  const harness = await mountRuns({ language: "en" })
  try {
    const frame = await harness.waitForFrame(
      (value) => RUNS.every((run) => rowOf(value, `Scan ${run.key} `, 1) === `↳ ${run.en}`),
      "every status line",
    )
    const icon = (key: string) => rowOf(frame, `Scan ${key} `)?.slice(0, 1)
    // A finished run keeps its mark; one that has not started or has not ended, or ended without a verdict, keeps the
    // bar of a call in progress; a running one has the spinner instead.
    expect(icon("done")).toBe("✓")
    expect(icon("bare")).toBe("✓")
    expect(icon("failed")).toBe("✗")
    expect(icon("nocause")).toBe("✗")
    for (const key of ["queued", "interrupted", "cancelled"]) expect(icon(key)).toBe("│")
    expect(icon("running")).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/)

    const expected = {
      queued: palette().statusQueued,
      running: palette().statusRunning,
      done: palette().success,
      bare: palette().success,
      failed: palette().error,
      nocause: palette().error,
      interrupted: palette().warning,
      cancelled: palette().textMuted,
    }
    for (const [key, color] of Object.entries(expected)) {
      expect({ key, title: (await colorOf(harness, `Scan ${key} `))?.equals(color) }).toEqual({ key, title: true })
    }
    // The line under the title is drawn in the same color as the title.
    expect((await colorOf(harness, "↳ queued"))?.equals(palette().statusQueued)).toBe(true)
    expect((await colorOf(harness, "↳ failed · boom"))?.equals(palette().error)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("the title says who asked for the run and where it runs", async () => {
  const labels = {
    en: [
      "you · background",
      "main agent · background",
      "main agent · background (moved)",
      "you · foreground",
      "main agent · foreground",
    ],
    "zh-CN": ["你发起 · 后台", "主 agent · 后台", "主 agent · 后台（已转）", "你发起 · 前台", "主 agent · 前台"],
  } as const
  const keys = ["byuser", "byagent", "moved", "front", "plain"]
  const tasks = () => [
    task("byuser", { initiator: "user" }),
    task("byagent", { initiator: "agent" }),
    task("moved", { promoted: true }),
    task("front", { background: false, initiator: "user" }),
    task("plain", { background: false, initiator: undefined }),
  ]
  for (const language of ["en", "zh-CN"] as const) {
    const harness = await mount({ language, tasks: tasks(), ticker: clockTicker().ticker })
    try {
      const frame = await harness.waitForFrame(
        (value) => keys.every((key) => rowOf(value, `Scan ${key} `)?.includes(" · ")),
        "every title",
      )
      keys.forEach((key, index) => {
        expect(rowOf(frame, `Scan ${key} `)).toEndWith(`Explore Task — Scan ${key} · ${labels[language][index]}`)
      })
    } finally {
      await harness.dispose()
    }
  }
})

test("the title reads the link the data layer holds, and the part's own metadata when there is none", async () => {
  const harness = await mount({ language: "en", tasks: [task("byuser", { initiator: "user" })] })
  try {
    const title = (value: string) => rowOf(value, "Scan byuser ")
    expect(await harness.waitForFrame((value) => title(value) !== undefined, "the row").then(title)).toEndWith(
      "· you · background",
    )

    // The link wins over the part while it is there...
    harness.sync().set("taskIndex", childID("byuser"), "initiator", "agent")
    const linked = await harness.waitForFrame(
      (value) => title(value)?.endsWith("· main agent · background") === true,
      "the link",
    )
    expect(title(linked)).toEndWith("· main agent · background")

    // ...and the part says it again once the link is gone.
    harness.sync().set(
      "taskIndex",
      produce((index) => {
        delete index[childID("byuser")]
      }),
    )
    const unlinked = await harness.waitForFrame(
      (value) => title(value)?.endsWith("· you · background") === true,
      "the part",
    )
    expect(title(unlinked)).toEndWith("· you · background")
  } finally {
    await harness.dispose()
  }
})

test("a running run in retry says so, in the color of an error", async () => {
  for (const [language, line] of [
    ["en", "↳ Retrying (attempt 2) · rate limited"],
    ["zh-CN", "↳ 重试中（第 2 次）· rate limited"],
  ] as const) {
    const harness = await mount({
      language,
      tasks: [task("retry")],
      states: { [childID("retry")]: RUNNING },
      ticker: clockTicker().ticker,
    })
    try {
      harness.sync().set("summary", childID("retry"), "status", "retry")
      harness
        .sync()
        .set("session_status", childID("retry"), { type: "retry", attempt: 2, message: "rate limited", next: NOW })
      const frame = await harness.waitForFrame((value) => rowOf(value, "Scan retry ", 1) === line, "the retry line")
      expect(rowOf(frame, "Scan retry ", 1)).toBe(line)
      expect((await colorOf(harness, "Scan retry "))?.equals(palette().error)).toBe(true)
    } finally {
      await harness.dispose()
    }
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  for (const width of [80, 60]) {
    test(`the reason a run failed is the first line that has text, cleaned and cut to one row at ${width} columns, ambiguous_width ${ambiguousWidth}`, async () => {
      const reasons: Record<string, string> = {
        one: "\n\n   first real line   \nsecond line",
        two: "\u001b[31mred\u001b[0m boom\u0007",
        cut: `${"网络错误：".repeat(20)}${"connection refused ".repeat(10)}`,
      }
      const harness = await mount({
        language: "en",
        ambiguousWidth,
        width,
        tasks: Object.keys(reasons).map((key) => task(key)),
        states: Object.fromEntries(Object.keys(reasons).map((key) => [childID(key), FAILED])),
        ticker: clockTicker().ticker,
      })
      try {
        for (const [key, reason] of Object.entries(reasons)) {
          harness.sync().set("summary", childID(key), "error", reason)
        }
        const frame = await harness.waitForFrame(
          (value) => Object.keys(reasons).every((key) => rowOf(value, `Scan ${key} `, 1)?.startsWith("↳ failed · ")),
          "the reasons",
        )
        expect(rowOf(frame, "Scan one ", 1)).toBe("↳ failed · first real line")
        expect(rowOf(frame, "Scan two ", 1)).toBe("↳ failed · red boom")

        const line = rowOf(frame, "Scan cut ", 1) ?? ""
        expect(line).toEndWith("…")
        expect(line.length).toBeGreaterThan("↳ failed · ".length + 10)
        // One row: nothing of it is left under it, and it fits what the row has: the width less the transcript's
        // padding (4) and the row's indent and icon (5).
        expect(rowOf(frame, "Scan cut ", 2)).toBe("")
        expect(cellWidth(line, ambiguousWidth)).toBeLessThanOrEqual(width - 4 - 5)
      } finally {
        await harness.dispose()
      }
    })
  }
}

test("the time of a running row moves with the one-second clock, and only that row listens to it", async () => {
  const clock = clockTicker()
  const harness = await mount({
    language: "en",
    tasks: [task("queued"), task("running"), task("done"), task("front", { background: false })],
    results: [resultPart("done", "completed")],
    states: { [childID("queued")]: RUNNING, [childID("running")]: RUNNING, [childID("done")]: COMPLETED },
    ticker: clock.ticker,
  })
  try {
    harness.sync().set("summary", childID("running"), "status", "busy")
    harness.sync().set("summary", childID("running"), "toolCalls", 3)
    const line = (frame: string, key: string) => rowOf(frame, `Scan ${key} `, 1)
    const first = await harness.waitForFrame(
      (value) =>
        line(value, "running") === "↳ running · 3 tool calls · 1m 5s" &&
        line(value, "done")?.startsWith("↳ done") === true,
      "the lines",
    )
    // The queued row, the finished one and the foreground one show nothing that moves: they do not listen.
    expect(line(first, "queued")).toBe("↳ queued · waiting for a slot")
    await waitFor(() => clock.listeners() === 1)
    expect(clock.calls.second).toBe(1)

    clock.advance(5_000)
    await harness.waitForFrame((value) => line(value, "running") === "↳ running · 3 tool calls · 1m 10s", "5s later")
    clock.advance(60_000)
    const later = await harness.waitForFrame(
      (value) => line(value, "running") === "↳ running · 3 tool calls · 2m 10s",
      "a minute later",
    )
    // What has ended keeps the span the server reported, whatever the clock says.
    expect(line(later, "done")).toBe("↳ done · 1m 5s · result below")

    // The result of the running one arrives: the line is the span it reports, and nobody listens any longer.
    harness.events.emit(partEvent(resultPart("running", "completed")))
    const ended = await harness.waitForFrame(
      (value) => line(value, "running") === "↳ done · 1m 5s · result below",
      "the result",
    )
    await waitFor(() => clock.listeners() === 0)
    clock.advance(30_000)
    await harness.settle()
    expect(line(await harness.frame(), "running")).toBe(line(ended, "running"))
    expect(clock.calls.second).toBe(1)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a running row that is scrolled out of the viewport stops listening to the clock, and listens again once it is back", async () => {
  const clock = clockTicker()
  const harness = await mount({
    language: "en",
    windowed: true,
    height: 30,
    tasks: [task("running")],
    states: { [childID("running")]: RUNNING },
    ticker: clock.ticker,
  })
  try {
    harness.sync().set("summary", childID("running"), "status", "busy")
    harness.sync().set("summary", childID("running"), "toolCalls", 3)
    // At the end the transcript follows its tail, which holds the row.
    await harness.waitForFrame(
      (value) => rowOf(value, "Scan running ", 1) === "↳ running · 3 tool calls · 1m 5s",
      "the row",
    )
    await waitFor(() => clock.listeners() === 1)

    // At the top the row is one of the last rows of a long transcript: still mounted, not in the viewport.
    harness.app.mockInput.pressKey("g", { ctrl: true })
    await harness.waitForFrame((value) => value.includes("scan everything"), "the top")
    await waitFor(() => clock.listeners() === 0)
    expect(mountedText(harness.app.renderer.root).join("\n")).toContain("Scan running")
    // The time the row shows is its own: the clock moving while it is away changes nothing it has to draw.
    clock.advance(10_000)
    await harness.settle()
    expect(clock.listeners()).toBe(0)

    harness.app.mockInput.pressKey("g", { ctrl: true, meta: true })
    await harness.waitForFrame(
      (value) => rowOf(value, "Scan running ", 1) === "↳ running · 3 tool calls · 1m 15s",
      "the row again",
    )
    await waitFor(() => clock.listeners() === 1)
  } finally {
    await harness.dispose()
  }
})

test("the hints under a Task call are words in both languages", async () => {
  for (const [language, view, move] of [
    ["en", "view subagents", "background"],
    ["zh-CN", "查看子 agent", "转后台"],
  ] as const) {
    const harness = await mount({
      language,
      tasks: [task("front", { background: false, status: "running" })],
      ticker: clockTicker().ticker,
    })
    try {
      const frame = await harness.waitForFrame((value) => value.includes(view), "the hint")
      // A foreground run that is still going can be moved to the background; the hint says how.
      const hint = rowOf(frame, view) ?? ""
      expect(hint).toMatch(new RegExp(`${view} · \\S.* ${move}$`))
    } finally {
      await harness.dispose()
    }
  }
})

test("a foreground row keeps its lines, in both languages", async () => {
  for (const [language, retryLine, callsLine] of [
    ["en", "↳ Retrying (attempt 3) · slow", "↳ 2 tool calls · 1.0s"],
    ["zh-CN", "↳ 重试中（第 3 次）· slow", "↳ 2 次工具调用 · 1.0s"],
  ] as const) {
    const harness = await mount({
      language,
      tasks: [task("front", { background: false }), task("retry", { background: false, status: "running" })],
      ticker: clockTicker().ticker,
    })
    try {
      harness.sync().set("summary", childID("front"), "toolCalls", 2)
      harness.sync().set("summary", childID("retry"), "status", "retry")
      harness.sync().set("session_status", childID("retry"), { type: "retry", attempt: 3, message: "slow", next: NOW })
      const frame = await harness.waitForFrame(
        (value) => rowOf(value, "Scan front ", 1) === callsLine && rowOf(value, "Scan retry ", 1) === retryLine,
        "the lines",
      )
      expect(rowOf(frame, "Scan front ")).toStartWith("✓ ")
      expect((await colorOf(harness, "Scan retry "))?.equals(palette().error)).toBe(true)
      expect(rowOf(frame, "Scan retry ")).toEndWith(
        language === "en" ? "· main agent · foreground" : "· 主 agent · 前台",
      )
    } finally {
      await harness.dispose()
    }
  }
})

/** The text of every text node that is mounted: a row the transcript unmounted is not in it. */
function mountedText(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [node.plainText] : []), ...node.getChildren().flatMap(mountedText)]
}
