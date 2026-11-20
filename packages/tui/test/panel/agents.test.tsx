// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Session } from "@graphagent/sdk"
import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, onCleanup, Show, type ParentProps } from "solid-js"
import type { PromptRef } from "../../src/component/prompt"
import { usePromptRef } from "../../src/context/prompt"
import { createSummary, type BackgroundResult, type TaskIndexEntry } from "../../src/context/session-summary"
import { DEFAULT_THEME } from "../../src/context/theme"
import type { Ticker } from "../../src/context/ticker"
import { setLanguage } from "../../src/i18n"
import { AgentsPanel } from "../../src/panel/agents"
import type { PanelHostApi } from "../../src/panel/host"
import { childSessions } from "../../src/session/siblings"
import { SUBAGENT_MARKER_GLYPH, subagentMarkerToken } from "../../src/session/subagents"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth } from "../../src/ui/width"
import { json, type FetchHandler } from "../fixture/tui-sdk"
import { createCounters } from "../perf/counters"
import { readFrame, readSpans, sessionFixture, waitFor } from "../routes/dag-mode-harness"
import { mountSessionShell } from "../routes/session-shell"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"
import { fakePromptRef } from "./prompt-ref"

// The /agents panel, mounted for real over the data layer and the panel host: what it lists and in which order, how
// it draws the three states, that it asks the server for nothing, and that its one action only fills the main
// session's input (#1033 5).

afterEach(() => {
  setLanguage("zh-CN")
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

const ROOT = "ses_ag_root"
// Created in this order: REVIEW and BUILD at the same instant (the id settles it), SCAN later. Their ids sort the
// other way round, so the list cannot be right by accident.
const SCAN = "ses_ag_a"
const REVIEW = "ses_ag_b"
const BUILD = "ses_ag_c"
const GRAND = "ses_ag_grand"
const OTHER = "ses_ag_other"
const STRANGER = "ses_ag_stranger"

const T0 = 1_700_000_000_000
const at = (seconds: number) => T0 + seconds * 1000

function tree(): Session[] {
  const sessions = [
    sessionFixture(ROOT, { title: "发布准备", time: { created: at(0), updated: at(100) } }),
    sessionFixture(SCAN, {
      parentID: ROOT,
      agent: "explore",
      title: "扫描破坏性变更 (@explore subagent)",
      time: { created: at(30), updated: at(38) },
    }),
    sessionFixture(REVIEW, {
      parentID: ROOT,
      title: "复核最终补丁 (@review subagent)",
      time: { created: at(10), updated: at(70) },
    }),
    sessionFixture(BUILD, { parentID: ROOT, agent: "build", title: "x", time: { created: at(10), updated: at(24) } }),
    sessionFixture(GRAND, { parentID: SCAN, title: "孙会话不列出", time: { created: at(31), updated: at(32) } }),
    sessionFixture(OTHER, { title: "另一棵树", time: { created: at(1), updated: at(2) } }),
    sessionFixture(STRANGER, { parentID: OTHER, title: "别处的子会话", time: { created: at(15), updated: at(16) } }),
  ]
  // The store keeps sessions in id order.
  return sessions.toSorted((left, right) => (left.id < right.id ? -1 : 1))
}

function link(description: string | undefined, kind?: string): TaskIndexEntry {
  return { parentSessionID: ROOT, parentMessageID: "msg_root", partID: `prt_${description}`, kind, description }
}

/** What the data layer holds for these sessions on a cold start: a summary each, no status, no count. */
function coldStart(ctx: AppPanelTestContext, sessions: readonly Session[] = tree()) {
  for (const session of sessions) ctx.sync.set("summary", session.id, createSummary(session))
  ctx.sync.set("taskIndex", SCAN, link("扫描破坏性变更", "explore"))
  ctx.sync.set("taskIndex", BUILD, link("重新生成 SDK", "build"))
}

/** One sub-agent in each state: SCAN runs, REVIEW failed, BUILD is done. */
function threeStates(ctx: AppPanelTestContext) {
  coldStart(ctx)
  const sessions = tree()
  const byID = (id: string) => sessions.find((session) => session.id === id)!
  ctx.sync.set("summary", SCAN, { ...createSummary(byID(SCAN), { type: "busy" }), toolCalls: 7 })
  ctx.sync.set("summary", REVIEW, {
    ...createSummary(byID(REVIEW), { type: "idle" }),
    toolCalls: 3,
    error: "boom",
    lastActivityAt: at(70),
  })
  ctx.sync.set("summary", BUILD, { ...createSummary(byID(BUILD), { type: "idle" }), toolCalls: 12 })
}

/** The one-second clock by hand: it says what time it is and counts who listens to it. */
function fakeTicker(start: number) {
  let current = start
  let seconds = 0
  const [second, setSecond] = createSignal(0)
  const ticker: Ticker = {
    frame: () => 0,
    second,
    subscribe: () => () => {},
    subscribeSecond: () => {
      seconds += 1
      return () => {
        seconds -= 1
      }
    },
    at: () => () => {},
    now: () => current,
  }
  return {
    ticker,
    listeners: () => seconds,
    advance(ms: number) {
      current += ms
      setSecond((value) => value + 1)
    },
  }
}

function PromptRefHarness(props: ParentProps<{ value: PromptRef; sessionID: string }>) {
  const prompt = usePromptRef()
  prompt.set(props.value, props.sessionID)
  onCleanup(() => prompt.set(undefined))
  return <>{props.children}</>
}

function DeferredPanel(props: { ready: () => boolean; onHost: (host: PanelHostApi) => void }) {
  return (
    <Show when={props.ready()}>
      <PanelSurface spec={{ id: "agents", render: () => <AgentsPanel /> }} onHost={props.onHost} />
    </Show>
  )
}

type Mounted = Awaited<ReturnType<typeof mount>>

async function mount(
  options: {
    width?: number
    height?: number
    language?: "zh-CN" | "en"
    ambiguousWidth?: 1 | 2
    sessions?: Session[]
    /** The session on screen; the root unless a sub-agent view is wanted. */
    viewing?: string
    seed?: (ctx: AppPanelTestContext) => void
    ticker?: Ticker
    handler?: FetchHandler
  } = {},
) {
  const tmp = await shellState(options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : {})
  const prompt = fakePromptRef()
  const ready = createSignal(false)
  const requested: string[] = []
  let ctx!: AppPanelTestContext
  let host!: PanelHostApi
  const app = await renderAppPanel(
    () => (
      <PromptRefHarness value={prompt.ref} sessionID={ROOT}>
        <DeferredPanel ready={ready[0]} onHost={(value) => (host = value)} />
      </PromptRefHarness>
    ),
    {
      width: options.width ?? 120,
      height: options.height ?? 40,
      state: tmp.path,
      ticker: options.ticker,
      handler: (url, request) => {
        requested.push(`${request?.method ?? "GET"} ${url.pathname}`)
        const custom = options.handler?.(url, request)
        if (custom) return custom
        // A panel that loads a session by mistake shows in the counts below, not as a crash on an unserved path.
        const read = url.pathname.match(/^\/session\/([^/]+)(\/message)?$/)
        if (read) return json(read[2] ? [] : (options.sessions ?? tree()).find((each) => each.id === read[1]))
        return undefined
      },
      setup: (context) => {
        ctx = context
        if (options.language) setLanguage(options.language)
        context.sync.set("session", options.sessions ?? tree())
        context.route.navigate({ type: "session", sessionID: options.viewing ?? ROOT })
        ;(options.seed ?? threeStates)(context)
        ready[1](true)
      },
    },
  )
  const harness = {
    app,
    prompt,
    requested,
    ctx: () => ctx,
    host: () => host,
    /** Requests that are not plain reads, minus nothing: a list that only looks sends none. */
    writes: () => requested.filter((entry) => !entry.startsWith("GET ")),
    /** Reads of a session's messages: the thing a list must not cause. */
    messageReads: () => requested.filter((entry) => /^GET \/session\/[^/]+\/message$/.test(entry)),
    async settle() {
      for (let attempt = 0; attempt < 6; attempt++) {
        await app.renderOnce()
        await Bun.sleep(10)
      }
      await app.renderOnce()
    },
    frame: async () => {
      await app.renderOnce()
      return readFrame(app)
    },
    spans: async () => {
      await app.renderOnce()
      return readSpans(app)
    },
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
  try {
    await waitUntil(harness, (frame) => frame.includes("筛选…") || frame.includes("Filter…"), "the panel")
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

async function waitUntil(
  harness: Pick<Mounted, "frame">,
  ready: (frame: string) => boolean,
  what: string,
  timeout = 5_000,
) {
  const start = Date.now()
  for (;;) {
    const frame = await harness.frame()
    if (ready(frame)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}; last frame:\n${frame}`)
    await Bun.sleep(10)
  }
}

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())
const rowWith = (frame: string, needle: string) => linesOf(frame).find((line) => line.includes(needle))
/** The note line of the panel, where the detail of the selected row is: the line before the hint row. */
const noteLine = (frame: string) => {
  const lines = linesOf(frame)
  return lines[lines.findIndex((line) => line.startsWith("╰")) - 2]
}

/** The color a piece of text is drawn in: the foreground of the first span that holds it. */
function colorOf(frame: Awaited<ReturnType<Mounted["spans"]>>, needle: string) {
  for (const line of frame.lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span.fg
  }
  return undefined
}

const TITLE_REVIEW = "review · 复核最终补丁"
const TITLE_BUILD = "build · 重新生成 SDK"
const TITLE_SCAN = "explore · 扫描破坏性变更"

describe("what the list shows", () => {
  test("lists the direct sub-agents of the root, in the order of its groups, and no others", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      // The one that runs comes first, then the ones that are over, newest start first and a tie by id.
      const positions = [TITLE_SCAN, TITLE_REVIEW, TITLE_BUILD].map((title) => frame.indexOf(title))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((left, right) => left - right))
      // Not the order they were created in.
      expect(childSessions(tree(), ROOT).map((session) => session.id)).toEqual([REVIEW, BUILD, SCAN])
      expect(frame).not.toContain("孙会话不列出")
      expect(frame).not.toContain("别处的子会话")
      expect(frame).toContain("子 agent")
      expect(frame).toContain("/agents")
    } finally {
      await harness.dispose()
    }
  })

  test("draws the three states with their glyph and color, and says them in words", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_SCAN)).toContain("运行中 · 工具 7 · 1m 5s")
      expect(rowWith(frame, TITLE_REVIEW)).toContain("失败 · 工具 3 · 1m 0s")
      expect(rowWith(frame, TITLE_BUILD)).toContain("已完成 · 工具 12 · 14s")

      const spans = await harness.spans()
      expect(colorOf(spans, "●")?.equals(palette().primary)).toBe(true)
      expect(colorOf(spans, "✗")?.equals(palette().error)).toBe(true)
      // A finished one is the success token, which the theme makes grey: not the brand color of a running one.
      expect(colorOf(spans, "✓")?.equals(palette().success)).toBe(true)
      expect(palette().success.equals(palette().primary)).toBe(false)
      // The top bar draws the same glyphs from the same map, so the two cannot drift apart.
      for (const marker of ["running", "failed", "done"] as const) {
        expect(colorOf(spans, SUBAGENT_MARKER_GLYPH[marker])?.equals(palette()[subagentMarkerToken(marker)])).toBe(true)
      }
      // The glyph is the row's own: running, failed and done each draw theirs on their own row.
      expect(rowWith(frame, TITLE_SCAN)).toContain("●")
      expect(rowWith(frame, TITLE_REVIEW)).toContain("✗")
      expect(rowWith(frame, TITLE_BUILD)).toContain("✓")
    } finally {
      await harness.dispose()
    }
  })

  test("says the states in English too", async () => {
    const harness = await mount({ language: "en", ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      expect(frame).toContain("Subagents")
      expect(rowWith(frame, TITLE_SCAN)).toContain("running · tools 7 · 1m 5s")
      expect(rowWith(frame, TITLE_REVIEW)).toContain("failed · tools 3 · 1m 0s")
      expect(rowWith(frame, TITLE_BUILD)).toContain("done · tools 12 · 14s")
      expect(frame).toContain("Ask main agent")
    } finally {
      await harness.dispose()
    }
  })

  test("after a cold start the state and the tool count are dashes and the time is the session's own, never a zero", async () => {
    const harness = await mount({ seed: (ctx) => coldStart(ctx), ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      // No status was ever reported, so the top bar would draw no marker for any of them, and neither does the list:
      // it does not guess that they are done. The time is there, and no count says 0.
      expect(rowWith(frame, TITLE_REVIEW)).toContain("— · 工具 — · 1m 0s")
      expect(rowWith(frame, TITLE_BUILD)).toContain("— · 工具 — · 14s")
      expect(rowWith(frame, TITLE_SCAN)).toContain("— · 工具 — · 8s")
      expect(frame).not.toMatch(/工具 0/)
      expect(frame).not.toMatch(/[●✓✗]/)
      expect(frame).not.toMatch(/运行中|已完成|失败/)
    } finally {
      await harness.dispose()
    }
  })

  test("says the same in English after a cold start", async () => {
    const harness = await mount({ language: "en", seed: (ctx) => coldStart(ctx), ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_BUILD)).toContain("— · tools — · 14s")
      expect(frame).not.toMatch(/[●✓✗]/)
    } finally {
      await harness.dispose()
    }
  })

  test("a failure that is known is drawn even while the status is not", async () => {
    const harness = await mount({
      ticker: fakeTicker(at(95)).ticker,
      seed: (ctx) => {
        coldStart(ctx)
        // An `error` event reached a session whose status the data layer never had.
        ctx.sync.set("summary", REVIEW, { ...createSummary(tree().find((each) => each.id === REVIEW)!), error: "boom" })
      },
    })
    try {
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_REVIEW)).toContain("✗")
      expect(rowWith(frame, TITLE_REVIEW)).toContain("失败 · 工具 — · 1m 0s")
      expect(rowWith(frame, TITLE_BUILD)).not.toMatch(/[●✓✗]/)
    } finally {
      await harness.dispose()
    }
  })

  test("a sub-agent that runs again after a failure is running, not failed", async () => {
    const harness = await mount({
      ticker: fakeTicker(at(95)).ticker,
      seed: (ctx) => {
        coldStart(ctx)
        const review = tree().find((each) => each.id === REVIEW)!
        // The error of the earlier turn is still on the summary, as the data layer keeps it.
        ctx.sync.set("summary", REVIEW, { ...createSummary(review, { type: "busy" }), error: "earlier", toolCalls: 2 })
      },
    })
    try {
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_REVIEW)).toContain("●")
      expect(rowWith(frame, TITLE_REVIEW)).toContain("运行中 · 工具 2 ·")
      expect(frame).not.toContain("✗")
    } finally {
      await harness.dispose()
    }
  })

  test("names a sub-agent by its Task link, then its agent, then its title", async () => {
    const sessions = [
      sessionFixture(ROOT),
      sessionFixture("ses_ag_1", {
        parentID: ROOT,
        title: "only a title (@plan subagent)",
        time: { created: 1, updated: 2 },
      }),
      sessionFixture("ses_ag_2", {
        parentID: ROOT,
        agent: "build",
        title: "ignored",
        time: { created: 2, updated: 3 },
      }),
      sessionFixture("ses_ag_3", { parentID: ROOT, title: "DAG 节点 (DAG node)", time: { created: 3, updated: 4 } }),
    ]
    const harness = await mount({
      sessions,
      seed: (ctx) => {
        coldStart(ctx, sessions)
        ctx.sync.set("taskIndex", "ses_ag_2", link("from the link", "ignored-kind"))
      },
    })
    try {
      const frame = await harness.frame()
      expect(frame).toContain("plan · only a title")
      expect(frame).toContain("build · from the link")
      expect(frame).toContain("agent · DAG 节点 (DAG node)")
    } finally {
      await harness.dispose()
    }
  })

  test("is the same list in a sub-agent view, whichever sub-agent is on screen", async () => {
    const harness = await mount({ viewing: BUILD, ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      for (const title of [TITLE_REVIEW, TITLE_BUILD, TITLE_SCAN]) expect(frame).toContain(title)
    } finally {
      await harness.dispose()
    }
  })

  test("says there are no sub-agents when the root has none", async () => {
    const harness = await mount({ sessions: [sessionFixture(ROOT)], seed: () => {} })
    try {
      expect(await harness.frame()).toContain("当前会话没有子 agent")
    } finally {
      await harness.dispose()
    }
    setLanguage("en")
    const english = await mount({ sessions: [sessionFixture(ROOT)], seed: () => {}, language: "en" })
    try {
      expect(await english.frame()).toContain("This session has no subagents")
    } finally {
      await english.dispose()
    }
  })

  test("shows the delegated prompt of the selected row on the note line: the session's first user message once it is loaded", async () => {
    const harness = await mount({
      ticker: fakeTicker(at(95)).ticker,
      seed: (ctx) => {
        threeStates(ctx)
        ctx.sync.set("message", REVIEW, [
          {
            id: "msg_rev_1",
            sessionID: REVIEW,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "p", modelID: "m" },
          },
        ])
        ctx.sync.set("part", "msg_rev_1", [
          {
            id: "prt_rev_1",
            sessionID: REVIEW,
            messageID: "msg_rev_1",
            type: "text",
            text: "逐个检查补丁里的\n  破坏性变更，\n并列出风险",
          },
        ])
      },
    })
    try {
      // The first row is the one that runs; its session is not loaded, so the Task description stands in.
      expect(noteLine(await harness.frame())).toContain("任务：扫描破坏性变更")
      // The next one is loaded: the prompt is read from its first message.
      harness.app.mockInput.pressArrow("down")
      expect(noteLine(await harness.settle().then(() => harness.frame()))).toContain(
        "任务：逐个检查补丁里的 破坏性变更， 并列出风险",
      )
      // The one after is not loaded again: the Task description stands in, and nothing is requested for it.
      harness.app.mockInput.pressArrow("down")
      const frame = await harness.settle().then(() => harness.frame())
      expect(noteLine(frame)).toContain("任务：重新生成 SDK")
      expect(frame).not.toContain("逐个检查补丁里的")
      expect(harness.messageReads()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe("what the selection moves", () => {
  test("the detail is on the note line, not under the row: no row moves and the panel keeps its height", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const titles = [TITLE_SCAN, TITLE_REVIEW, TITLE_BUILD]
      const layout = (frame: string) => ({
        rows: titles.map((title) => rowIndex(frame, title)),
        height:
          linesOf(frame).findIndex((line) => line.startsWith("╰")) -
          linesOf(frame).findIndex((line) => line.startsWith("╭")),
      })
      const first = await harness.frame()
      const before = layout(first)
      expect(before.rows.every((row) => row >= 0)).toBe(true)
      expect(noteLine(first)).toContain("任务：扫描破坏性变更")
      // The row under the selected one is the next sub-agent's, not a line of detail.
      expect(linesOf(first)[before.rows[0] + 1]).not.toContain("任务：")

      for (const task of ["任务：复核最终补丁", "任务：重新生成 SDK"]) {
        harness.app.mockInput.pressArrow("down")
        const frame = await harness.settle().then(() => harness.frame())
        expect(noteLine(frame)).toContain(task)
        expect(layout(frame)).toEqual(before)
        // Written once: on the note line, nowhere under a row.
        expect(linesOf(frame).filter((line) => line.includes(task))).toHaveLength(1)
      }
    } finally {
      await harness.dispose()
    }
  })
})

describe("what opening it costs", () => {
  test("asks the server for nothing: no session is loaded and no message is read", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      await harness.frame()
      for (let step = 0; step < 3; step++) {
        harness.app.mockInput.pressArrow("down")
        await harness.settle()
      }
      expect(harness.messageReads()).toEqual([])
      expect(harness.requested.filter((entry) => entry.includes("/session/ses_ag_"))).toEqual([])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("listens to the one-second clock only while a sub-agent runs, and its time follows the clock", async () => {
    const clock = fakeTicker(at(95))
    const harness = await mount({ ticker: clock.ticker })
    try {
      expect(clock.listeners()).toBe(1)
      expect(rowWith(await harness.frame(), TITLE_SCAN)).toContain("1m 5s")
      clock.advance(3_000)
      await harness.settle()
      expect(rowWith(await harness.frame(), TITLE_SCAN)).toContain("1m 8s")

      // It finishes: nothing moves any more, so nothing listens.
      const scan = tree().find((session) => session.id === SCAN)!
      harness.ctx().sync.set("summary", SCAN, { ...createSummary(scan, { type: "idle" }), toolCalls: 9 })
      await harness.settle()
      expect(clock.listeners()).toBe(0)
      expect(rowWith(await harness.frame(), TITLE_SCAN)).toContain("已完成 · 工具 9 · 8s")
    } finally {
      await harness.dispose()
    }
    expect(clock.listeners()).toBe(0)
  })

  test("keeps the cursor on its row while a sub-agent's state moves", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      for (let step = 0; step < 2; step++) harness.app.mockInput.pressArrow("down")
      await harness.settle()
      const before = await harness.frame()
      expect(rowWith(before, TITLE_BUILD)).toContain("›")
      expect(noteLine(before)).toContain("任务：重新生成 SDK")

      // A running sub-agent calls another tool; the summary is replaced, as the data layer does it.
      const scan = tree().find((session) => session.id === SCAN)!
      harness.ctx().sync.set("summary", SCAN, { ...createSummary(scan, { type: "busy" }), toolCalls: 8 })
      await harness.settle()
      const after = await harness.frame()
      expect(rowWith(after, TITLE_SCAN)).toContain("工具 8")
      expect(rowWith(after, TITLE_BUILD)).toContain("›")
      expect(rowWith(after, TITLE_REVIEW)).not.toContain("›")
      expect(noteLine(after)).toContain("任务：重新生成 SDK")
    } finally {
      await harness.dispose()
    }
  })
})

describe("what the user can do in it", () => {
  test("enter goes into the selected sub-agent and closes the panel", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressArrow("down")
      await harness.settle()
      harness.app.mockInput.pressEnter()
      await harness.settle()
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: REVIEW })
      expect(harness.host().depth()).toBe(0)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("enter on the first row goes into the sub-agent that runs, not the oldest and not the first id", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressEnter()
      await harness.settle()
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: SCAN })
    } finally {
      await harness.dispose()
    }
  })

  test("ctrl+r asks the main agent: the request lands in the main session's input and nothing is sent", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      for (let step = 0; step < 2; step++) harness.app.mockInput.pressArrow("down")
      await harness.settle()
      harness.app.mockInput.pressKey("r", { ctrl: true })
      await harness.settle()
      expect(harness.prompt.ref.current.input).toBe("请处理子 agent build · 重新生成 SDK：")
      expect(harness.host().depth()).toBe(0)
      expect(harness.writes()).toEqual([])
      // The user stays where they were: the main session already is the root.
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: ROOT })
    } finally {
      await harness.dispose()
    }
  })

  test("ctrl+r from a sub-agent view takes the user to the main session's input", async () => {
    const harness = await mount({ viewing: SCAN, language: "en", ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressKey("r", { ctrl: true })
      await harness.settle()
      expect(harness.prompt.ref.current.input).toBe("Please handle the subagent explore · 扫描破坏性变更:")
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: ROOT })
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("offers no way to stop, cancel or retry a sub-agent", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      expect(frame).toContain("⌃R")
      expect(frame).toContain("请主 agent 处理")
      expect(frame).not.toMatch(/停止|终止|取消|中断|重试|stop|abort|cancel|retry/i)
      // Every key a stop could hang on does nothing to the server.
      for (const key of ["x", "d", "s", "c"]) harness.app.mockInput.pressKey(key, { ctrl: true })
      await harness.settle()
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("the panel and its helpers cannot reach the server", () => {
    // The only writes a user can cause here are the main session's own; the panel never calls the SDK.
    const files = [
      path.join(import.meta.dir, "../../src/panel/agents.tsx"),
      path.join(import.meta.dir, "../../src/session/subagents.ts"),
    ]
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source).not.toMatch(/useSDK|sdk\.client|\.abort\(|session\.prompt|session\.command/)
    }
  })

  test("typing narrows the list by the name shown", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      await harness.app.mockInput.typeText("SDK")
      const frame = await harness.settle().then(() => harness.frame())
      expect(frame).toContain(TITLE_BUILD)
      expect(frame).not.toContain(TITLE_SCAN)
      expect(frame).not.toContain(TITLE_REVIEW)
      // The selection is the first row that is left, and enter goes into that one.
      harness.app.mockInput.pressEnter()
      await harness.settle()
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: BUILD })
    } finally {
      await harness.dispose()
    }
  })

  test("a running sub-agent the filter hides keeps no clock: the subscription follows the rows on screen", async () => {
    const clock = fakeTicker(at(95))
    const harness = await mount({ ticker: clock.ticker })
    try {
      expect(clock.listeners()).toBe(1)
      await harness.app.mockInput.typeText("SDK")
      const filtered = await harness.settle().then(() => harness.frame())
      expect(filtered).not.toContain(TITLE_SCAN)
      expect(clock.listeners()).toBe(0)
      // The row that is left keeps its columns while the hidden one's time would grow.
      const row = rowWith(filtered, TITLE_BUILD)
      clock.advance(60_000)
      await harness.settle()
      expect(rowWith(await harness.frame(), TITLE_BUILD)).toBe(row)

      // The running one is shown again: the clock is listened to again.
      for (let index = 0; index < 3; index++) harness.app.mockInput.pressBackspace()
      const all = await harness.settle().then(() => harness.frame())
      expect(all).toContain(TITLE_SCAN)
      expect(clock.listeners()).toBe(1)
    } finally {
      await harness.dispose()
    }
    expect(clock.listeners()).toBe(0)
  })

  test("says nothing matches when the filter lets no row through, not that there are no sub-agents", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      await harness.app.mockInput.typeText("zzzz")
      const frame = await harness.settle().then(() => harness.frame())
      expect(frame).toContain("没有可选项")
      expect(frame).not.toContain("当前会话没有子 agent")
      expect(frame).not.toContain(TITLE_BUILD)
    } finally {
      await harness.dispose()
    }
  })
})

describe("the selection while the list moves", () => {
  const viewing = (harness: Mounted) => JSON.parse(JSON.stringify(harness.ctx().route.data))

  /** The sub-agent's own state, as the data layer replaces it when an event comes. */
  function setState(harness: Mounted, id: string, status: "busy" | "idle", extra: { toolCalls?: number } = {}) {
    const session = tree().find((each) => each.id === id)!
    harness.ctx().sync.set("summary", id, { ...createSummary(session, { type: status }), ...extra })
  }

  test("another row that changes group moves the ids around; the selection stays on its sub-agent, and enter goes into it", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      // The rows are SCAN (it runs), then REVIEW and BUILD, which are over: the second row is REVIEW.
      harness.app.mockInput.pressArrow("down")
      await waitUntil(harness, (frame) => rowWith(frame, TITLE_REVIEW)?.includes("›") === true, "REVIEW selected")

      // BUILD runs again: it leaves the finished group for the foreground one, so the order of the ids is SCAN, BUILD,
      // REVIEW. By place the selection would be on BUILD now, and a list that starts over would have it on SCAN.
      setState(harness, BUILD, "busy", { toolCalls: 13 })
      const frame = await waitUntil(
        harness,
        (value) => rowIndex(value, TITLE_BUILD) > 0 && rowIndex(value, TITLE_BUILD) < rowIndex(value, TITLE_REVIEW),
        "BUILD above REVIEW",
      )
      expect(rowWith(frame, TITLE_REVIEW)).toContain("›")
      expect(rowWith(frame, TITLE_BUILD)).not.toContain("›")
      expect(rowWith(frame, TITLE_SCAN)).not.toContain("›")

      harness.app.mockInput.pressEnter()
      await waitFor(() => viewing(harness).sessionID === REVIEW)
      expect(viewing(harness)).toEqual({ type: "session", sessionID: REVIEW })
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("the selected row's own change of state takes it to its new group, and the selection goes with it", async () => {
    const harness = await mount({
      sessions: backgroundTree(),
      seed: withBackground(),
      ticker: fakeTicker(at(95)).ticker,
      height: 60,
    })
    try {
      // The first row is the background run that runs, and nothing was moved.
      expect(rowWith(await harness.frame(), TITLE_BG_RUN)).toContain("›")

      const run = backgroundTree().find((session) => session.id === BG_RUN)!
      harness
        .ctx()
        .sync.set("taskIndex", BG_RUN, "result", { ...REPORT, title: "未提交改动", startedAt: at(40), endedAt: at(90) })
      harness.ctx().sync.set("summary", BG_RUN, { ...createSummary(run, { type: "idle" }), toolCalls: 13 })
      harness.ctx().sync.set("lifecycle", `job:${BG_RUN}`, job(BG_RUN, "completed"))
      const frame = await waitUntil(
        harness,
        (value) => rowWith(value, TITLE_BG_RUN)?.includes("已完成 · 工具 13 · 50s") === true,
        "the run that ended",
      )
      // It is in the finished group now, and the pointer is on it there, not on the queued run that is first.
      expect(rowIndex(frame, TITLE_BG_RUN)).toBeGreaterThan(headingRow(frame, "已结束"))
      expect(rowWith(frame, TITLE_BG_RUN)).toContain("›")
      expect(rowWith(frame, TITLE_BG_QUEUE)).not.toContain("›")

      harness.app.mockInput.pressEnter()
      await waitFor(() => viewing(harness).sessionID === BG_RUN)
      expect(viewing(harness)).toEqual({ type: "session", sessionID: BG_RUN })
    } finally {
      await harness.dispose()
    }
  })

  test("a sub-agent that goes away leaves the selection at its place, on the row that took it", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressArrow("down")
      await waitUntil(harness, (frame) => rowWith(frame, TITLE_REVIEW)?.includes("›") === true, "REVIEW selected")

      // REVIEW is deleted: BUILD is the second row now, and it is the selected one, not SCAN.
      harness.ctx().sync.set(
        "session",
        tree().filter((session) => session.id !== REVIEW),
      )
      const frame = await waitUntil(harness, (value) => !value.includes(TITLE_REVIEW), "REVIEW gone")
      expect(rowWith(frame, TITLE_BUILD)).toContain("›")
      expect(rowWith(frame, TITLE_SCAN)).not.toContain("›")

      harness.app.mockInput.pressEnter()
      await waitFor(() => viewing(harness).sessionID === BUILD)
      expect(viewing(harness)).toEqual({ type: "session", sessionID: BUILD })
    } finally {
      await harness.dispose()
    }
  })

  test("typing in the filter starts the selection over at the first row", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressArrow("down")
      await waitUntil(harness, (frame) => rowWith(frame, TITLE_REVIEW)?.includes("›") === true, "REVIEW selected")

      // "r" is in the names of SCAN and REVIEW, not BUILD's: REVIEW stays in the list, but the selection is SCAN's.
      await harness.app.mockInput.typeText("r")
      const frame = await waitUntil(harness, (value) => !value.includes(TITLE_BUILD), "the narrowed list")
      expect(rowWith(frame, TITLE_REVIEW)).toBeDefined()
      expect(rowWith(frame, TITLE_SCAN)).toContain("›")
      expect(rowWith(frame, TITLE_REVIEW)).not.toContain("›")

      harness.app.mockInput.pressEnter()
      await waitFor(() => viewing(harness).sessionID === SCAN)
      expect(viewing(harness)).toEqual({ type: "session", sessionID: SCAN })
    } finally {
      await harness.dispose()
    }
  })
})

describe("how it looks", () => {
  async function look(options: Parameters<typeof mount>[0]) {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker, ...options })
    try {
      return await harness.frame()
    } finally {
      await harness.dispose()
    }
  }

  test("80 by 24, in Chinese", async () => {
    expect(await look({ width: 80, height: 24 })).toMatchSnapshot()
  })

  test("120 by 40, in Chinese", async () => {
    expect(await look({ width: 120, height: 40 })).toMatchSnapshot()
  })

  test("80 by 24, in English", async () => {
    expect(await look({ width: 80, height: 24, language: "en" })).toMatchSnapshot()
  })

  test("120 by 40, in English", async () => {
    expect(await look({ width: 120, height: 40, language: "en" })).toMatchSnapshot()
  })

  // The list has a filter box, so it has no tab keys on the arrows: the pair of row keys is the only pair in the row.
  const HINT_ROWS = {
    "zh-CN": "↑↓ 选择 · ⏎ 确认 · ⌃R 请主 agent 处理 · esc 关闭",
    en: "↑↓ Select · ⏎ Confirm · ⌃R Ask main agent · esc Close",
  } as const

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`the hint row pairs the arrow keys and is whole at 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const lines = linesOf(await look({ width: 80, height: 24, language, ambiguousWidth }))
        const row = lines[lines.findIndex((line) => line.includes("╰")) - 1].slice(1, -1).trim()
        expect(row).toBe(HINT_ROWS[language])
        expect(row).not.toMatch(/left|right|←|→/)
        expect(cellWidth(row, ambiguousWidth)).toBeLessThanOrEqual(80 - 4)
      })
    }
  }

  test("a cold start, 80 by 24", async () => {
    expect(await look({ width: 80, height: 24, seed: (ctx) => coldStart(ctx) })).toMatchSnapshot()
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`nothing is laid out wider than 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const sessions = [
          sessionFixture(ROOT, { title: "发布准备", time: { created: at(0), updated: at(100) } }),
          ...["a", "b", "c", "d"].map((letter, index) =>
            sessionFixture(`ses_ag_long_${letter}`, {
              parentID: ROOT,
              agent: "一个相当长的 agent 名称用来检查窄终端",
              title: `一个相当长的描述${"，用来检查窄终端下的一行不会溢出到边框外面去".repeat(3)} (@x subagent)`,
              time: { created: at(10 + index), updated: at(20 + index) },
            }),
          ),
        ]
        const harness = await mount({
          width: 80,
          height: 24,
          language,
          ambiguousWidth,
          sessions,
          ticker: fakeTicker(at(95)).ticker,
          seed: (ctx) => {
            coldStart(ctx, sessions)
            const [first, second, third] = sessions.slice(1)
            ctx.sync.set("summary", first.id, { ...createSummary(first, { type: "busy" }), toolCalls: 12_345 })
            ctx.sync.set("summary", second.id, {
              ...createSummary(second, { type: "retry", attempt: 3, message: "slow", next: 0 }),
              toolCalls: 4,
            })
            ctx.sync.set("summary", third.id, {
              ...createSummary(third, { type: "idle" }),
              error: "boom",
              toolCalls: 99,
            })
          },
        })
        try {
          const frame = await harness.frame()
          const lines = linesOf(frame).filter((line) => line.startsWith("│") && line.endsWith("│"))
          expect(lines.length).toBeGreaterThan(6)
          for (const line of lines) {
            // Inside the border: the padding and what the panel itself laid out.
            const inner = line.slice(1, -1).trimEnd()
            expect({ line, fits: cellWidth(inner, ambiguousWidth) <= 80 - 3 }).toEqual({ line, fits: true })
          }
          // A long title is cut to one row, not wrapped onto two.
          expect(lines.filter((line) => line.includes("一个相当长的 agent")).length).toBe(4)
          expect(lines.find((line) => line.includes("一个相当长的 agent"))).toContain("…")
        } finally {
          await harness.dispose()
        }
      })
    }
  }
})

describe("in a session with its input", () => {
  /** The session route with its input and bottom zone, the panel pushed the way the app's command handler does. */
  async function mountShell() {
    const shell = await mountSessionShell({ sessionID: ROOT, sessions: tree(), width: 120, height: 40 })
    for (const session of tree()) shell.sync().set("summary", session.id, createSummary(session))
    shell.sync().set("taskIndex", SCAN, link("扫描破坏性变更", "explore"))
    shell.sync().set("taskIndex", BUILD, link("重新生成 SDK", "build"))
    return {
      ...shell,
      async open() {
        shell.bottomZone().host.push({ id: "agents", render: () => <AgentsPanel /> })
        await waitFor(() => shell.bottomZone().host.top()?.id === "agents", 10_000)
        await shell.settle()
      },
    }
  }

  test("opening, moving and closing it registers a few layers and leaves the draft as it was", async () => {
    const shell = await mountShell()
    const counters = createCounters(shell.app.renderer, shell.keymap())
    try {
      await shell.app.mockInput.typeText("keep this")
      await shell.settle()
      expect(shell.promptDraft()).toBe("keep this")

      const start = counters.snapshot()
      await shell.open()
      expect(await shell.frame()).toContain(TITLE_SCAN)
      const opened = counters.delta(start).registerLayer
      expect(opened).toBeLessThanOrEqual(4)

      const mounted = counters.snapshot()
      for (const key of ["down", "down", "up", "down"] as const) {
        shell.app.mockInput.pressArrow(key)
        await shell.settle()
      }
      // Moving the selection, and the sub-agents' state moving, register nothing.
      expect(counters.delta(mounted).registerLayer).toBe(0)

      shell.app.mockInput.pressEscape()
      await waitFor(() => shell.bottomZone().host.depth() === 0, 10_000)
      await shell.settle()
      expect(counters.delta(start).registerLayer).toBeLessThanOrEqual(opened + 2)
      expect(shell.promptDraft()).toBe("keep this")
      expect(shell.writes()).toEqual([])
    } finally {
      counters.dispose()
      await shell.dispose()
    }
  })

  test("asking the main agent appends to the draft that is there and sends nothing", async () => {
    const shell = await mountShell()
    try {
      await shell.app.mockInput.typeText("keep this")
      await shell.settle()
      await shell.open()
      for (let step = 0; step < 2; step++) shell.app.mockInput.pressArrow("down")
      await shell.settle()
      shell.app.mockInput.pressKey("r", { ctrl: true })
      await shell.settle()
      expect(shell.promptDraft()).toBe("keep this\n请处理子 agent build · 重新生成 SDK：")
      expect(shell.bottomZone().host.depth()).toBe(0)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })

  test("opening it from a sub-agent view and asking from there leads to the main session's draft", async () => {
    const shell = await mountSessionShell({ sessionID: BUILD, sessions: tree(), width: 120, height: 40 })
    try {
      for (const session of tree()) shell.sync().set("summary", session.id, createSummary(session))
      shell.bottomZone().host.push({ id: "agents", render: () => <AgentsPanel /> })
      await waitFor(() => shell.bottomZone().host.top()?.id === "agents", 10_000)
      await shell.settle()
      // A sub-agent view has no input: the panel is its bottom zone, and it lists the same sub-agents.
      expect(shell.promptDraft()).toBeUndefined()
      expect(await shell.frame()).toContain(TITLE_SCAN)

      shell.app.mockInput.pressKey("r", { ctrl: true })
      const viewing = () => {
        const data = shell.route().data
        return data.type === "session" ? data.sessionID : undefined
      }
      await waitFor(() => viewing() === ROOT, 10_000)
      // Nothing is known of their state, so the newest is first.
      await waitFor(() => shell.promptDraft() === "请处理子 agent explore · 扫描破坏性变更：", 10_000)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })
})

// ── background runs: groups, columns, counts, detail and what ctrl+r asks (#1058 6) ────────────────────────────

const BG_RUN = "ses_ag_bg_run"
const BG_QUEUE = "ses_ag_bg_queue"
const BG_DONE = "ses_ag_bg_done"
const BG_CUT = "ses_ag_bg_cut"

const TITLE_BG_RUN = "review · 未提交改动"
const TITLE_BG_QUEUE = "explore · 清理过期依赖"
const TITLE_BG_DONE = "explore · 列出过期依赖"
const TITLE_BG_CUT = "general · 生成 nix 哈希"

const bgSession = (id: string, title: string, agent: string, created: number, updated: number) =>
  sessionFixture(id, { parentID: ROOT, title: `${title} (@${agent} subagent)`, agent, time: { created, updated } })

/** The three sub-agents of the other tests and four background runs, one in each state a run can be in. */
function backgroundTree(): Session[] {
  return [
    ...tree(),
    bgSession(BG_RUN, "未提交改动", "review", at(40), at(41)),
    bgSession(BG_QUEUE, "清理过期依赖", "explore", at(60), at(60)),
    bgSession(BG_DONE, "列出过期依赖", "explore", at(5), at(65)),
    bgSession(BG_CUT, "生成 nix 哈希", "general", at(8), at(30)),
  ].toSorted((left, right) => (left.id < right.id ? -1 : 1))
}

function bgLink(
  description: string,
  kind: string,
  startedAt: number,
  extra: Partial<TaskIndexEntry> = {},
): TaskIndexEntry {
  return {
    parentSessionID: ROOT,
    parentMessageID: "msg_root",
    partID: `prt_bg_${description}`,
    kind,
    description,
    background: true,
    startedAt,
    ...extra,
  }
}

const job = (id: string, value: string, reason?: string, since?: number) => ({
  domain: "job" as const,
  id,
  value,
  phase: value === "queued" ? ("pending" as const) : ("running" as const),
  reason,
  at: 1,
  ...(since === undefined ? {} : { since }),
})

const REPORT: BackgroundResult = {
  status: "completed",
  title: "列出过期依赖",
  startedAt: at(5),
  endedAt: at(65),
  messageID: "msg_bg_result",
  partID: "prt_bg_result",
}

/** The text of the message the server adds to the main session when a background run ends. */
const REPORT_TEXT = [
  `<task id="${BG_DONE}" state="completed">`,
  "<summary>Background task completed: 列出过期依赖</summary>",
  "<task_result>",
  "发现 3 个过期依赖。",
  "详见下面的列表。",
  "</task_result>",
  "</task>",
].join("\n")

/**
 * What the data layer holds when four background runs are in the list next to the three foreground ones: one that
 * runs (the user asked for it), one that waits for a slot, one that finished and was reported, one that the process
 * lost. The list is the first two, then SCAN (still running in the foreground), then REVIEW, BUILD, the lost run and
 * the reported one, newest start first.
 */
function withBackground(
  options: {
    reportLoaded?: boolean
    lostError?: string
    /**
     * The jobs as a server that reports the queue (#1407) says them: the run that runs got its slot at the given
     * moment, the other one waits (`queued`), or began too (`began`) without its child having shown anything yet.
     */
    reported?: { runningAt: number; queue: "queued" | { began: number } }
  } = {},
) {
  return (ctx: AppPanelTestContext) => {
    threeStates(ctx)
    const sessions = backgroundTree()
    const byID = (id: string) => sessions.find((session) => session.id === id)!
    const reported = options.reported
    ctx.sync.set("taskIndex", BG_RUN, bgLink("未提交改动", "review", at(40), { initiator: "user", command: "review" }))
    ctx.sync.set("summary", BG_RUN, { ...createSummary(byID(BG_RUN), { type: "busy" }), toolCalls: 12 })
    ctx.sync.set("lifecycle", `job:${BG_RUN}`, job(BG_RUN, "running", undefined, reported?.runningAt))

    ctx.sync.set("taskIndex", BG_QUEUE, bgLink("清理过期依赖", "explore", at(60)))
    ctx.sync.set("summary", BG_QUEUE, createSummary(byID(BG_QUEUE), { type: "idle" }))
    ctx.sync.set(
      "lifecycle",
      `job:${BG_QUEUE}`,
      reported === undefined
        ? job(BG_QUEUE, "running")
        : reported.queue === "queued"
          ? job(BG_QUEUE, "queued", undefined, at(60))
          : job(BG_QUEUE, "running", undefined, reported.queue.began),
    )

    ctx.sync.set("taskIndex", BG_DONE, bgLink("列出过期依赖", "explore", at(5), { result: REPORT }))
    ctx.sync.set("summary", BG_DONE, { ...createSummary(byID(BG_DONE), { type: "idle" }), toolCalls: 8 })
    ctx.sync.set("lifecycle", `job:${BG_DONE}`, job(BG_DONE, "completed"))
    if (options.reportLoaded !== false) {
      ctx.sync.set("part", REPORT.messageID, [
        {
          id: REPORT.partID,
          sessionID: ROOT,
          messageID: REPORT.messageID,
          type: "text",
          synthetic: true,
          text: REPORT_TEXT,
        },
      ])
    }

    ctx.sync.set("taskIndex", BG_CUT, bgLink("生成 nix 哈希", "general", at(8)))
    ctx.sync.set("summary", BG_CUT, {
      ...createSummary(byID(BG_CUT), { type: "idle" }),
      toolCalls: 6,
      error: options.lostError,
    })
    ctx.sync.set("lifecycle", `job:${BG_CUT}`, job(BG_CUT, "error", "process_restart"))
  }
}

/** The row of the frame that is a group heading: its inner text is the heading alone. */
function headingRow(frame: string, heading: string) {
  return linesOf(frame).findIndex((line) => line.startsWith("│") && line.slice(1, -1).trim() === heading)
}

const rowIndex = (frame: string, needle: string) => linesOf(frame).findIndex((line) => line.includes(needle))

describe("background runs in the list", () => {
  const options = (extra: Parameters<typeof mount>[0] = {}): Parameters<typeof mount>[0] => ({
    sessions: backgroundTree(),
    seed: withBackground(),
    ticker: fakeTicker(at(95)).ticker,
    ...extra,
  })

  test("is in three groups: the background runs, the foreground run that still runs, then everything else", async () => {
    const harness = await mount(options())
    try {
      const frame = await harness.frame()
      const order = [
        headingRow(frame, "后台"),
        rowIndex(frame, TITLE_BG_RUN),
        rowIndex(frame, TITLE_BG_QUEUE),
        headingRow(frame, "前台"),
        rowIndex(frame, TITLE_SCAN),
        headingRow(frame, "已结束"),
        // Newest start first: REVIEW and BUILD began together (the id settles it), then the lost run, then the first.
        rowIndex(frame, TITLE_REVIEW),
        rowIndex(frame, TITLE_BUILD),
        rowIndex(frame, TITLE_BG_CUT),
        rowIndex(frame, TITLE_BG_DONE),
      ]
      expect(order.every((position) => position >= 0)).toBe(true)
      expect(order).toEqual([...order].sort((left, right) => left - right))
    } finally {
      await harness.dispose()
    }
  })

  test("a group with nothing in it has no heading", async () => {
    const onlyBackground = await mount(
      options({
        sessions: backgroundTree().filter((session) => [ROOT, BG_RUN, BG_QUEUE].includes(session.id)),
        seed: (ctx) => {
          withBackground()(ctx)
        },
      }),
    )
    try {
      const frame = await onlyBackground.frame()
      expect(headingRow(frame, "后台")).toBeGreaterThan(0)
      expect(headingRow(frame, "前台")).toBe(-1)
      expect(headingRow(frame, "已结束")).toBe(-1)
    } finally {
      await onlyBackground.dispose()
    }

    // The three of the other tests have no background run: no heading for them, and nothing about the background.
    const none = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await none.frame()
      expect(headingRow(frame, "前台")).toBeGreaterThan(0)
      expect(headingRow(frame, "已结束")).toBeGreaterThan(0)
      expect(headingRow(frame, "后台")).toBe(-1)
    } finally {
      await none.dispose()
    }
  })

  test("the first row is selected: the background run that runs, and enter goes into it", async () => {
    const harness = await mount(options())
    try {
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_BG_RUN)).toContain("›")
      expect(rowWith(frame, TITLE_BG_QUEUE)).not.toContain("›")
      harness.app.mockInput.pressEnter()
      await harness.settle()
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: BG_RUN })
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("says who asked for each run, and how it stands, in words and in glyphs", async () => {
    const harness = await mount(options({ height: 60 }))
    try {
      const frame = await harness.frame()
      // The initiators line up in a column as wide as the widest of them.
      expect(rowWith(frame, TITLE_BG_RUN)).toMatch(/● .*你发起 +运行中 · 工具 12 · 55s/)
      expect(rowWith(frame, TITLE_BG_QUEUE)).toMatch(/○ .*主 agent {2}排队中 · 工具 — · —/)
      expect(rowWith(frame, TITLE_SCAN)).toMatch(/● .*主 agent {2}运行中 · 工具 7 · 1m 5s/)
      // A row whose session no Task call started (a failed one with no link) has a dash for its initiator.
      expect(rowWith(frame, TITLE_REVIEW)).toMatch(/✗ .*— +失败 · 工具 3 · 1m 0s/)
      expect(rowWith(frame, TITLE_BG_CUT)).toMatch(/✗ .*主 agent {2}已中断 · 工具 6 · 22s/)
      // The server's own span of a run it reported on: 5s to 65s.
      expect(rowWith(frame, TITLE_BG_DONE)).toMatch(/✓ .*主 agent {2}已完成 · 工具 8 · 1m 0s/)

      const spans = await harness.spans()
      // A run that waits for a slot is the hollow glyph in the queued color, not the brand color of one that runs.
      expect(colorOf(spans, "○")?.equals(palette().statusQueued)).toBe(true)
      expect(palette().statusQueued.equals(palette().primary)).toBe(false)
      expect(colorOf(spans, "●")?.equals(palette().primary)).toBe(true)
      expect(colorOf(spans, "✗")?.equals(palette().error)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  // #1407: the run that began is timed from the moment it got its slot, the one behind it waits, and a run the server
  // says began is running even though its child has shown nothing yet.
  test("shows the queue the server reports: the time of a run that began does not include its wait", async () => {
    const waiting = await mount(
      options({ height: 60, seed: withBackground({ reported: { runningAt: at(70), queue: "queued" } }) }),
    )
    try {
      const frame = await waiting.frame()
      // Started at 40 s, got its slot at 70 s, now 95 s: 25 s, not the 55 s the Task call would say.
      expect(rowWith(frame, TITLE_BG_RUN)).toMatch(/● .*你发起 +运行中 · 工具 12 · 25s/)
      expect(rowWith(frame, TITLE_BG_QUEUE)).toMatch(/○ .*主 agent {2}排队中 · 工具 — · —/)
      expect(rowWith(frame, "子 agent")).toContain("1 个后台运行 · 1 个排队")
    } finally {
      await waiting.dispose()
    }

    const began = await mount(
      options({
        height: 60,
        seed: withBackground({ reported: { runningAt: at(70), queue: { began: at(90) } } }),
      }),
    )
    try {
      const frame = await began.frame()
      // Its child is idle and has called no tool: the inference says queued, the server says it runs, from 90 s.
      expect(rowWith(frame, TITLE_BG_QUEUE)).toMatch(/● .*主 agent {2}运行中 · 工具 — · 5s/)
      expect(rowWith(frame, TITLE_BG_RUN)).toMatch(/运行中 · 工具 12 · 25s/)
      expect(rowWith(frame, "子 agent")).toContain("2 个后台运行")
      expect(rowWith(frame, "子 agent")).not.toContain("排队")
    } finally {
      await began.dispose()
    }
  })

  test("says the same in English", async () => {
    const harness = await mount(options({ height: 60, language: "en" }))
    try {
      const frame = await harness.frame()
      for (const heading of ["Background", "Foreground", "Finished"])
        expect(headingRow(frame, heading)).toBeGreaterThan(0)
      expect(rowWith(frame, TITLE_BG_RUN)).toMatch(/you +running · tools 12 · 55s/)
      expect(rowWith(frame, TITLE_BG_QUEUE)).toMatch(/main agent {2}queued · tools — · —/)
      expect(rowWith(frame, TITLE_BG_CUT)).toMatch(/main agent {2}interrupted · tools 6 · 22s/)
      expect(rowWith(frame, TITLE_BG_DONE)).toMatch(/main agent {2}done · tools 8 · 1m 0s/)
    } finally {
      await harness.dispose()
    }
  })

  test("a run whose status nobody knows yet is in the background group with the look of a cold start", async () => {
    const harness = await mount(
      options({
        sessions: backgroundTree().filter((session) => [ROOT, BG_RUN, BG_QUEUE].includes(session.id)),
        seed: (ctx) => {
          // Links only: no job state and no status was ever reported for either.
          ctx.sync.set("summary", BG_RUN, createSummary(backgroundTree().find((session) => session.id === BG_RUN)!))
          ctx.sync.set("taskIndex", BG_RUN, bgLink("未提交改动", "review", at(40), { initiator: "user" }))
        },
      }),
    )
    try {
      const frame = await harness.frame()
      expect(headingRow(frame, "后台")).toBeGreaterThan(0)
      expect(rowWith(frame, TITLE_BG_RUN)).toMatch(/你发起 {2}— · 工具 — · /)
      expect(rowWith(frame, TITLE_BG_RUN)).not.toMatch(/[●○✓✗]/)
      // The headline counts only what is known to run or to wait.
      expect(rowWith(frame, "子 agent")).toContain("2 个")
      expect(rowWith(frame, "子 agent")).not.toContain("后台运行")
    } finally {
      await harness.dispose()
    }
  })

  test("the heading counts the runs, the background ones that run and the ones that wait", async () => {
    const harness = await mount(options({ height: 60 }))
    try {
      expect(rowWith(await harness.frame(), "子 agent")).toContain("子 agent  7 个 · 1 个后台运行 · 1 个排队")
    } finally {
      await harness.dispose()
    }
    const english = await mount(options({ height: 60, language: "en" }))
    try {
      expect(rowWith(await english.frame(), "Subagents")).toContain("Subagents  7 · 1 background running · 1 queued")
    } finally {
      await english.dispose()
    }
  })

  test("a part that is zero is left out of the heading", async () => {
    const running = await mount(
      options({
        sessions: backgroundTree().filter((session) => [ROOT, BG_RUN, SCAN].includes(session.id)),
        seed: (ctx) => {
          withBackground()(ctx)
        },
      }),
    )
    try {
      const frame = await running.frame()
      expect(rowWith(frame, "子 agent")).toContain("子 agent  2 个 · 1 个后台运行")
      expect(rowWith(frame, "子 agent")).not.toContain("排队")
    } finally {
      await running.dispose()
    }
    const none = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const line = rowWith(await none.frame(), "子 agent")
      expect(line).toContain("子 agent  3 个")
      expect(line).not.toMatch(/后台|排队/)
    } finally {
      await none.dispose()
    }
  })

  test("the heading is cut to what the title row has, never wider", async () => {
    const harness = await mount(options({ width: 36, height: 40 }))
    try {
      const frame = await harness.frame()
      const line = rowWith(frame, "子 agent")!
      expect(line).toContain("子 agent  7 个 · 1 个后台")
      expect(line).toContain("…")
      for (const each of linesOf(frame).filter((row) => row.startsWith("│"))) {
        expect(cellWidth(each)).toBeLessThanOrEqual(36)
      }
    } finally {
      await harness.dispose()
    }
  })

  test("a run that is over shows the first line of its report and that it came back, then what it was asked, on the note line", async () => {
    const harness = await mount(options({ height: 60 }))
    try {
      for (let step = 0; step < 6; step++) harness.app.mockInput.pressArrow("down")
      await harness.settle()
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_BG_DONE)).toContain("›")
      // What came back is short and comes first, so that a long prompt is what the line cuts; one line holds both.
      expect(noteLine(frame)).toContain("结果：发现 3 个过期依赖。 · 结果已回注 · 任务：列出过期依赖")
      // It is written once, on the note line, and not again under the row.
      expect(linesOf(frame).filter((line) => line.includes("结果已回注"))).toHaveLength(1)
      expect(harness.messageReads()).toEqual([])
    } finally {
      await harness.dispose()
    }
    const english = await mount(options({ height: 60, language: "en" }))
    try {
      for (let step = 0; step < 6; step++) english.app.mockInput.pressArrow("down")
      await english.settle()
      expect(noteLine(await english.frame())).toContain(
        "Result: 发现 3 个过期依赖。 · result delivered · Task: 列出过期依赖",
      )
    } finally {
      await english.dispose()
    }
  })

  test("without the main session's messages loaded, only that the report came back: its text is not guessed", async () => {
    const harness = await mount(options({ height: 60, seed: withBackground({ reportLoaded: false }) }))
    try {
      for (let step = 0; step < 6; step++) harness.app.mockInput.pressArrow("down")
      await harness.settle()
      const frame = await harness.frame()
      expect(noteLine(frame)).toContain("结果已回注 · 任务：列出过期依赖")
      expect(frame).not.toContain("结果：")
      expect(harness.messageReads()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("a run that was interrupted and left no report says it did not come back", async () => {
    const harness = await mount(options({ height: 60 }))
    try {
      for (let step = 0; step < 5; step++) harness.app.mockInput.pressArrow("down")
      await harness.settle()
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_BG_CUT)).toContain("›")
      expect(noteLine(frame)).toContain("未回注（已中断）")
    } finally {
      await harness.dispose()
    }
    const english = await mount(options({ height: 60, language: "en" }))
    try {
      for (let step = 0; step < 5; step++) english.app.mockInput.pressArrow("down")
      await english.settle()
      expect(await english.frame()).toContain("not delivered (interrupted)")
    } finally {
      await english.dispose()
    }
  })

  test("a run that goes on, and one that is waited for, show only what they were asked", async () => {
    const harness = await mount(options({ height: 60 }))
    try {
      const frame = await harness.frame()
      expect(rowWith(frame, TITLE_BG_RUN)).toContain("›")
      expect(noteLine(frame)).toContain("任务：未提交改动")
      expect(frame).not.toContain("结果已回注")
      expect(frame).not.toContain("未回注")
    } finally {
      await harness.dispose()
    }
  })

  test("listens to the one-second clock for a run that runs, not for one that waits or is over", async () => {
    const quiet = fakeTicker(at(95))
    const harness = await mount(
      options({
        ticker: quiet.ticker,
        sessions: backgroundTree().filter((session) => [ROOT, BG_QUEUE, BG_DONE, BG_CUT].includes(session.id)),
      }),
    )
    try {
      await harness.frame()
      expect(quiet.listeners()).toBe(0)
    } finally {
      await harness.dispose()
    }

    const busy = fakeTicker(at(95))
    const running = await mount(options({ ticker: busy.ticker }))
    try {
      await running.frame()
      expect(busy.listeners()).toBe(1)
      busy.advance(5_000)
      await running.settle()
      expect(rowWith(await running.frame(), TITLE_BG_RUN)).toContain("1m 0s")
      // The queued run has no time to show, so the clock does not move it.
      expect(rowWith(await running.frame(), TITLE_BG_QUEUE)).toContain("排队中 · 工具 — · —")
    } finally {
      await running.dispose()
    }
  })

  test("a run that ends while the panel is open moves to the finished group, with the new state in words", async () => {
    const harness = await mount(options({ height: 60 }))
    try {
      expect(headingRow(await harness.frame(), "后台")).toBeGreaterThan(0)
      const run = backgroundTree().find((session) => session.id === BG_RUN)!
      harness
        .ctx()
        .sync.set("taskIndex", BG_RUN, "result", { ...REPORT, title: "未提交改动", startedAt: at(40), endedAt: at(90) })
      harness.ctx().sync.set("summary", BG_RUN, { ...createSummary(run, { type: "idle" }), toolCalls: 13 })
      harness.ctx().sync.set("lifecycle", `job:${BG_RUN}`, job(BG_RUN, "completed"))
      const frame = await waitUntil(
        harness,
        (value) => rowWith(value, TITLE_BG_RUN)?.includes("已完成 · 工具 13 · 50s") === true,
        "the run that ended",
      )
      // It is now the first of the group that is over: its start is the newest there.
      expect(rowIndex(frame, TITLE_BG_RUN)).toBeGreaterThan(headingRow(frame, "已结束"))
      expect(rowIndex(frame, TITLE_BG_RUN)).toBeLessThan(rowIndex(frame, TITLE_REVIEW))
      // The queued one is the only one in the background group, so it is the one counted.
      expect(rowWith(frame, "子 agent")).toContain("1 个排队")
      expect(rowWith(frame, "子 agent")).not.toContain("后台运行")
    } finally {
      await harness.dispose()
    }
  })
})

describe("what ctrl+r asks for a background run", () => {
  /** Selects the `index`th row of the list, asks, and returns what landed in the main session's input. */
  async function asked(
    index: number,
    extra: Parameters<typeof mount>[0] = {},
  ): Promise<{ input: string; writes: string[]; route: unknown }> {
    const harness = await mount({
      sessions: backgroundTree(),
      seed: withBackground(),
      ticker: fakeTicker(at(95)).ticker,
      height: 60,
      ...extra,
    })
    try {
      for (let step = 0; step < index; step++) harness.app.mockInput.pressArrow("down")
      await harness.settle()
      harness.app.mockInput.pressKey("r", { ctrl: true })
      await harness.settle()
      return {
        input: harness.prompt.ref.current.input,
        writes: harness.writes(),
        route: JSON.parse(JSON.stringify(harness.ctx().route.data)),
      }
    } finally {
      await harness.dispose()
    }
  }

  // The list is: BG_RUN, BG_QUEUE, SCAN, REVIEW, BUILD, BG_CUT, BG_DONE.
  test("a background run that goes on is asked to be cancelled, by its task id; so is one that waits", async () => {
    for (const [index, session, description] of [
      [0, BG_RUN, "未提交改动"],
      [1, BG_QUEUE, "清理过期依赖"],
    ] as const) {
      const result = await asked(index)
      expect(result.input).toBe(`请取消后台任务「${description}」（task_id=${session}），用 task 工具的 cancel。`)
      // Nothing is sent: the request is a draft the user reads, edits and decides on.
      expect(result.writes).toEqual([])
      expect(result.route).toEqual({ type: "session", sessionID: ROOT })
    }
  })

  test("a background run that finished is asked to be continued from", async () => {
    expect((await asked(6)).input).toBe("请根据后台任务「列出过期依赖」的结果继续：")
  })

  test("a background run that did not finish is asked to be judged: the word for how it ended, or its error's first line", async () => {
    expect((await asked(5)).input).toBe("后台任务「生成 nix 哈希」没有完成（已中断），请判断是否需要重新运行。")
    const withError = await asked(5, { seed: withBackground({ lostError: "provider timed out\nretrying" }) })
    expect(withError.input).toBe("后台任务「生成 nix 哈希」没有完成（provider timed out），请判断是否需要重新运行。")
  })

  test("a foreground run gets the request it always had", async () => {
    expect((await asked(2)).input).toBe("请处理子 agent explore · 扫描破坏性变更：")
    expect((await asked(3)).input).toBe("请处理子 agent review · 复核最终补丁：")
    expect((await asked(4)).input).toBe("请处理子 agent build · 重新生成 SDK：")
  })

  test("says the request in English too", async () => {
    expect((await asked(0, { language: "en" })).input).toBe(
      `Please cancel the background task “未提交改动” (task_id=${BG_RUN}) with the task tool's cancel action.`,
    )
    expect((await asked(6, { language: "en" })).input).toBe(
      "Please continue from the result of the background task “列出过期依赖”: ",
    )
    expect((await asked(5, { language: "en" })).input).toBe(
      "The background task “生成 nix 哈希” did not finish (interrupted); decide whether it needs to run again.",
    )
  })

  test("is the one action there is: no key to stop, retry or cancel a run, and none of the others does anything", async () => {
    const harness = await mount({
      sessions: backgroundTree(),
      seed: withBackground(),
      ticker: fakeTicker(at(95)).ticker,
      height: 60,
    })
    try {
      const frame = await harness.frame()
      const hints = linesOf(frame).find((line) => line.includes("⌃R"))!
      expect(hints.match(/⌃\w/g)).toEqual(["⌃R"])
      expect(hints).toContain("请主 agent 处理")
      for (const key of ["x", "d", "s", "k", "t", "e"]) harness.app.mockInput.pressKey(key, { ctrl: true })
      await harness.settle()
      expect(harness.writes()).toEqual([])
      expect(harness.prompt.ref.current.input).toBe("")
    } finally {
      await harness.dispose()
    }
  })
})

describe("background runs: how the list looks", () => {
  async function look(extra: Parameters<typeof mount>[0]) {
    const harness = await mount({
      sessions: backgroundTree(),
      seed: withBackground(),
      ticker: fakeTicker(at(95)).ticker,
      ...extra,
    })
    try {
      return await harness.frame()
    } finally {
      await harness.dispose()
    }
  }

  test("80 by 24, in Chinese", async () => {
    expect(await look({ width: 80, height: 24 })).toMatchSnapshot()
  })

  test("120 by 40, in Chinese", async () => {
    expect(await look({ width: 120, height: 40 })).toMatchSnapshot()
  })

  test("80 by 24, in English", async () => {
    expect(await look({ width: 80, height: 24, language: "en" })).toMatchSnapshot()
  })

  test("120 by 40, in English", async () => {
    expect(await look({ width: 120, height: 40, language: "en" })).toMatchSnapshot()
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`nothing is laid out wider than 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        const harness = await mount({
          width: 80,
          height: 24,
          language,
          ambiguousWidth,
          sessions: backgroundTree(),
          seed: withBackground(),
          ticker: fakeTicker(at(95)).ticker,
        })
        try {
          const frame = await harness.frame()
          const lines = linesOf(frame).filter((line) => line.startsWith("│") && line.endsWith("│"))
          expect(lines.length).toBeGreaterThan(5)
          for (const line of lines) {
            const inner = line.slice(1, -1).trimEnd()
            expect({ line, fits: cellWidth(inner, ambiguousWidth) <= 80 - 3 }).toEqual({ line, fits: true })
          }
          // The heading and the first row are whole: nothing the columns added pushed them out.
          expect(frame).toContain(language === "en" ? "1 background running" : "1 个后台运行")
          expect(frame).toContain(language === "en" ? "you" : "你发起")
        } finally {
          await harness.dispose()
        }
      })
    }
  }
})
