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
import { createSummary, type TaskIndexEntry } from "../../src/context/session-summary"
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
  test("lists the direct sub-agents of the root, in the order the sibling keys walk, and no others", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      const frame = await harness.frame()
      const positions = [TITLE_REVIEW, TITLE_BUILD, TITLE_SCAN].map((title) => frame.indexOf(title))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((left, right) => left - right))
      // The same sequence the walk uses: oldest first, ties by id.
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

  test("shows the delegated prompt of the selected row: the session's first user message once it is loaded", async () => {
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
      // The first row is selected: its session is loaded, so the prompt is read from its first message.
      expect(await harness.frame()).toContain("任务：逐个检查补丁里的 破坏性变更， 并列出风险")
      // The next one is not loaded: the Task description stands in, and nothing is requested for it.
      harness.app.mockInput.pressArrow("down")
      const frame = await harness.settle().then(() => harness.frame())
      expect(frame).toContain("任务：重新生成 SDK")
      expect(frame).not.toContain("逐个检查补丁里的")
      expect(harness.messageReads()).toEqual([])
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
      harness.app.mockInput.pressArrow("down")
      await harness.settle()
      const before = await harness.frame()
      expect(rowWith(before, TITLE_BUILD)).toContain("›")
      expect(before).toContain("任务：重新生成 SDK")

      // A running sub-agent calls another tool; the summary is replaced, as the data layer does it.
      const scan = tree().find((session) => session.id === SCAN)!
      harness.ctx().sync.set("summary", SCAN, { ...createSummary(scan, { type: "busy" }), toolCalls: 8 })
      await harness.settle()
      const after = await harness.frame()
      expect(rowWith(after, TITLE_SCAN)).toContain("工具 8")
      expect(rowWith(after, TITLE_BUILD)).toContain("›")
      expect(rowWith(after, TITLE_REVIEW)).not.toContain("›")
      expect(after).toContain("任务：重新生成 SDK")
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
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: BUILD })
      expect(harness.host().depth()).toBe(0)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("enter on the first row goes into the oldest sub-agent, not the first id", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressEnter()
      await harness.settle()
      expect(JSON.parse(JSON.stringify(harness.ctx().route.data))).toEqual({ type: "session", sessionID: REVIEW })
    } finally {
      await harness.dispose()
    }
  })

  test("ctrl+r asks the main agent: the request lands in the main session's input and nothing is sent", async () => {
    const harness = await mount({ ticker: fakeTicker(at(95)).ticker })
    try {
      harness.app.mockInput.pressArrow("down")
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
      expect(harness.prompt.ref.current.input).toBe("Please handle the subagent review · 复核最终补丁:")
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
      expect(frame).toContain("ctrl+r")
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
      shell.app.mockInput.pressArrow("down")
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
      expect(await shell.frame()).toContain(TITLE_REVIEW)

      shell.app.mockInput.pressKey("r", { ctrl: true })
      const viewing = () => {
        const data = shell.route().data
        return data.type === "session" ? data.sessionID : undefined
      }
      await waitFor(() => viewing() === ROOT, 10_000)
      await waitFor(() => shell.promptDraft() === "请处理子 agent review · 复核最终补丁：", 10_000)
      expect(shell.writes()).toEqual([])
    } finally {
      await shell.dispose()
    }
  })
})
