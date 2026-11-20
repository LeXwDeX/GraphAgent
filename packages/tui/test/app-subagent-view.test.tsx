// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { DEFAULT_THEME } from "../src/context/theme"
import { setLanguage } from "../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../src/theme"
import { cellWidth } from "../src/ui/width"
import { captureFrame, footerRow, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { directory, json } from "./fixture/tui-sdk"
import { readSpans, sessionFixture } from "./routes/dag-mode-harness"

/**
 * A sub-agent session in the real app (#1033 2, 3.3): the top bar shows the path from the root session down to it, the
 * footer says it is read-only, there is no prompt, and no request is written whatever the user does.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const rootID = "ses_sub_root"
const childID = "ses_sub_child"
const siblingID = "ses_sub_sibling"

const rootTitle = "升级工具链与全部依赖"
const root = sessionFixture(rootID, { title: rootTitle })
const child = sessionFixture(childID, {
  parentID: rootID,
  title: "扫描破坏性变更 (@explore subagent)",
  agent: "explore",
})
const sessions = [root, child]

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

let sequence = 0
function event(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, payload: { id: `evt_app_subagent_${++sequence}`, type, properties } } as GlobalEvent
}

function status(sessionID: string, type: "busy" | "idle") {
  return event("session.status", { sessionID, status: { type } })
}

/**
 * The Task part of the parent that started `childSessionID`: the summary layer links the two through it. A background
 * run says so in the metadata of its part, and one that was moved there while it ran says that too.
 */
function taskPart(
  childSessionID: string,
  kind: string,
  description: string,
  mode: { background?: boolean; promoted?: boolean } = {},
) {
  return event("message.part.updated", {
    sessionID: rootID,
    time: 12,
    part: {
      id: `prt_task_${childSessionID}`,
      sessionID: rootID,
      messageID: "msg_sub_parent",
      type: "tool",
      tool: "task",
      callID: `call_${childSessionID}`,
      state: {
        status: "running",
        title: description,
        input: { description, subagent_type: kind },
        time: { start: 12 },
        metadata: {
          sessionID: childSessionID,
          ...(mode.background ? { background: true } : {}),
          ...(mode.promoted ? { promoted: true } : {}),
        },
      },
    },
  })
}

const rowOf = (frame: string, index: number) => (frame.split("\n")[index] ?? "").trimEnd()
const topRow = (frame: string) => rowOf(frame, 0)

async function settled(setup: Setup) {
  for (let pass = 0; pass < 3; pass++) await setup.renderOnce()
  return captureFrame(setup)
}

function collect(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap((item) => collect(item))]
}

const prompts = (setup: Setup) =>
  collect(setup.renderer.root).filter((item) => item instanceof TextareaRenderable && !item.isDestroyed).length

/** The color of the first span on the top row that holds `needle`. */
async function topColor(setup: Setup, needle: string) {
  const frame = await readSpans(setup)
  return frame.lines[0]?.spans.find((span) => span.text.includes(needle))?.fg
}

for (const size of [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const) {
  test(`draws the path and the read-only footer at ${size.width}x${size.height}, in both languages`, async () => {
    // The row has 76 cells between the gutters at 80 columns: the path and the position leave the description two short.
    const description = size.width === 80 ? "扫描破坏性…" : "扫描破坏性变更"
    const zh = await runApp({ sessions, args: { sessionID: childID }, ...size })
    try {
      const frame = await waitForFrame(zh.setup, (value) => value.includes("只读"), "the sub-agent footer")
      // No task entry is known: the description is the title without its tail, the kind the session's own agent.
      expect(topRow(frame)).toStartWith(`  ◇─◆ GraphAgent › ${rootTitle} › explore · ${description}`)
      expect(footerRow(frame)).toStartWith("  explore · 只读 · 子 agent 只接受主 agent 的通信")
      expect(footerRow(frame)).toContain("esc 返回")
      expect(frame).toMatchSnapshot()
    } finally {
      await zh.stop()
    }

    const en = await runApp({
      sessions,
      args: { sessionID: childID },
      handler: (url) => (url.pathname === "/config" ? json({ language: "en" }) : undefined),
      ...size,
    })
    try {
      const frame = await waitForFrame(en.setup, (value) => value.includes("read-only"), "the English footer")
      expect(topRow(frame)).toStartWith(`  ◇─◆ GraphAgent › ${rootTitle} › explore · ${description}`)
      expect(footerRow(frame)).toStartWith("  explore · read-only · only the main agent can message it")
      expect(footerRow(frame)).toContain("esc back")
      expect(frame).toMatchSnapshot()
    } finally {
      await en.stop()
    }
  })
}

test("the kind comes from the parent's Task entry when the session carries no agent", async () => {
  const bare = sessionFixture(siblingID, { parentID: rootID, title: "另一件事 (@general subagent)" })
  const app = await runApp({ sessions: [root, bare], args: { sessionID: siblingID } })
  try {
    // The title is all there is at first: its tail names the agent.
    const first = await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    expect(topRow(first)).toContain("› general · 另一件事")

    // The Task part arrives: its input is the better source of both the kind and the description.
    app.events.emit(taskPart(siblingID, "plan", "来自任务的描述"))
    const frame = await waitForFrame(app.setup, (value) => topRow(value).includes("plan"), "the Task entry")
    expect(topRow(frame)).toContain("› plan · 来自任务的描述")
    expect(footerRow(frame)).toStartWith("  plan · 只读")
  } finally {
    await app.stop()
  }
})

test("the marker follows the sub-agent: running in the brand color, done in gray, failed in the error color", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    // Nothing is known about the session yet: no marker.
    expect(topRow(await settled(app.setup))).toContain("› explore ·")

    app.events.emit(status(childID, "busy"))
    await waitForFrame(app.setup, (frame) => topRow(frame).includes("● explore"), "the running marker")
    expect((await topColor(app.setup, "●"))?.equals(palette().primary)).toBe(true)

    app.events.emit(status(childID, "idle"))
    await waitForFrame(app.setup, (frame) => topRow(frame).includes("✓ explore"), "the done marker")
    expect((await topColor(app.setup, "✓"))?.equals(palette().success)).toBe(true)

    app.events.emit(
      event("session.error", { sessionID: childID, error: { name: "UnknownError", data: { message: "x" } } }),
    )
    await waitForFrame(app.setup, (frame) => topRow(frame).includes("✗ explore"), "the failed marker")
    expect((await topColor(app.setup, "✗"))?.equals(palette().error)).toBe(true)

    // Running again starts a new run, and its success is not marked with the earlier failure.
    app.events.emit(status(childID, "busy"))
    await waitForFrame(app.setup, (frame) => topRow(frame).includes("● explore"), "the running marker again")
    app.events.emit(status(childID, "idle"))
    await waitForFrame(app.setup, (frame) => topRow(frame).includes("✓ explore"), "done after the rerun")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("clicking the root segment goes back to the root session, whose chrome is the one of a main session", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    const before = await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    const row = topRow(before)
    // Everything left of the first wide character is one cell per character, so a string index is a column.
    const column = cellWidth(row.slice(0, row.indexOf("升级")))
    await app.setup.mockMouse.click(column + 2, 0)

    const after = await waitForFrame(app.setup, (frame) => !frame.includes("只读"), "the root session")
    expect(topRow(after)).toContain(`› ${rootTitle}`)
    expect(topRow(after)).not.toContain("explore")
    expect(footerRow(after)).toContain("build")
    expect(footerRow(after)).toContain("⇥ 切换 agent")
    // A sub-agent view has no prompt; the root session has.
    expect(prompts(app.setup)).toBe(1)
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("a click on the current segment stays where it is", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    const before = await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    const row = topRow(before)
    await app.setup.mockMouse.click(cellWidth(row.slice(0, row.indexOf("explore"))) + 2, 0)
    await app.setup.mockMouse.click(cellWidth(row.slice(0, row.indexOf("GraphAgent"))) + 2, 0)
    const after = await settled(app.setup)
    expect(topRow(after)).toContain("› explore · 扫描破坏性变更")
    expect(after).toContain("只读")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("a sub-agent view has no prompt, and nothing the user does in it writes a request", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    expect(prompts(app.setup)).toBe(0)

    // Typing finds no input to go to.
    await app.setup.mockInput.typeText("hello")
    expect(await settled(app.setup)).not.toContain("hello")
    expect(prompts(app.setup)).toBe(0)

    // The command palette opens and closes; the drawer opens and closes.
    app.setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame(app.setup, (frame) => frame.includes("筛选"), "the command palette")
    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, (frame) => !frame.includes("筛选"), "the command palette closed")
    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => frame.includes("上下文"), "the drawer")
    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, (frame) => !frame.includes("上下文"), "the drawer closed")

    // Clicks on the transcript, the scroll wheel and the footer.
    await app.setup.mockMouse.click(30, 8)
    await app.setup.mockMouse.scroll(30, 8, "down")
    await app.setup.mockMouse.click(30, 29)
    const frame = await settled(app.setup)
    expect(frame).toContain("只读")
    expect(prompts(app.setup)).toBe(0)
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("a main session keeps its top bar and its footer", async () => {
  const app = await runApp({ sessions, args: { sessionID: rootID }, width: 120, height: 30 })
  try {
    const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes("⇥ 切换 agent"), "the footer")
    expect(topRow(frame)).toStartWith(`  ◇─◆ GraphAgent › ${rootTitle}`)
    expect(topRow(frame)).not.toContain("explore")
    expect(topRow(frame)).not.toContain("子 agent")
    expect(footerRow(frame)).toStartWith("  build ")
    expect(footerRow(frame)).toContain("⇥ 切换 agent")
    expect(footerRow(frame)).toContain("⌃P 命令")
    expect(frame).not.toContain("只读")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

const longRoot = sessionFixture(rootID, {
  title: "升级工具链与整个单体仓库的全部依赖并验证每一个构建结果是否保持一致",
})
const longChild = sessionFixture(childID, {
  parentID: rootID,
  title: "扫描全部变更日志中的破坏性变更并汇总每一项发现 (@general-purpose subagent)",
})
const longRootEn = sessionFixture(rootID, { title: "Upgrade the toolchain and every dependency of the whole monorepo" })
const longChildEn = sessionFixture(childID, {
  parentID: rootID,
  title: "Scan every changelog for breaking changes and summarize each finding (@general-purpose subagent)",
})

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`the top bar and the footer of a sub-agent fit 80 columns in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      const app = await runApp({
        sessions: language === "en" ? [longRootEn, longChildEn] : [longRoot, longChild],
        args: { sessionID: childID },
        width: 80,
        height: 24,
        ambiguousWidth,
        handler: (url) => (url.pathname === "/config" ? json({ language }) : undefined),
      })
      try {
        const frame = await waitForFrame(
          app.setup,
          (value) => footerRow(value).includes(language === "en" ? "read-only" : "只读"),
          "the sub-agent footer",
        )
        for (const line of frame.split("\n")) expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        // The path keeps its root and its current segment; the kind comes from the title's tail, hyphen and all.
        expect(topRow(frame)).toContain("◇─◆ GraphAgent › ")
        expect(topRow(frame)).toContain("general-purpose")
        expect(footerRow(frame)).toStartWith("  general-purpose · ")
      } finally {
        await app.stop()
      }
    })
  }
}

const sibling = (id: string, created: number, agent: string) =>
  sessionFixture(id, {
    parentID: rootID,
    title: `${agent} 任务 (@${agent} subagent)`,
    agent,
    time: { created, updated: created + 1 },
  })

test("the top bar counts the sub-agent among its siblings in the order of the list that ←→ walks, and the footer offers the switch", async () => {
  const siblings = [
    root,
    sibling("ses_sub_c", 30, "review"),
    sibling("ses_sub_a", 10, "explore"),
    sibling("ses_sub_b", 20, "general"),
  ]
  const app = await runApp({ sessions: siblings, args: { sessionID: "ses_sub_a" }, width: 120, height: 30 })
  try {
    // Nothing is known of any state: newest start first, so explore (created first) is the last of three.
    const first = await waitForFrame(app.setup, (frame) => topRow(frame).includes("子 agent 3/3"), "the position")
    expect(topRow(first)).toContain("←→")
    expect(footerRow(first)).toContain("←→ 切换")

    // The list is review, general, explore. Right walks it and wraps; left goes back.
    const seen: string[] = []
    let previous = topRow(first)
    for (const key of ["right", "right", "right", "left"] as const) {
      app.setup.mockInput.pressArrow(key)
      const frame = await waitForFrame(app.setup, (next) => topRow(next) !== previous, `the sub-agent after ${key}`)
      previous = topRow(frame)
      seen.push(frame)
    }
    expect(seen.map((frame) => /子 agent (\d)\/3/.exec(topRow(frame))?.[1])).toEqual(["1", "2", "3", "2"])
    expect(topRow(seen[0] ?? "")).toContain("review")
    expect(topRow(seen[1] ?? "")).toContain("general")
    expect(topRow(seen[2] ?? "")).toContain("explore")
    expect(topRow(seen[3] ?? "")).toContain("general")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("a background run that runs is the first of the list: the position and the walk follow its state as it moves", async () => {
  const siblings = [
    root,
    sibling("ses_sub_c", 30, "review"),
    sibling("ses_sub_a", 10, "explore"),
    sibling("ses_sub_b", 20, "general"),
  ]
  const app = await runApp({ sessions: siblings, args: { sessionID: "ses_sub_b" }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => topRow(frame).includes("子 agent 2/3"), "the position by creation")

    // It is a background run that runs: it moves to the front of the list, and the position says so.
    app.events.emit(taskPart("ses_sub_b", "general", "general 任务", { background: true }))
    app.events.emit(status("ses_sub_b", "busy"))
    const front = await waitForFrame(app.setup, (frame) => topRow(frame).includes("子 agent 1/3"), "the new position")
    expect(topRow(front)).toContain("general")

    // Right goes to the next of the list (review, then explore), and wraps back to the run.
    const order: string[] = []
    for (let step = 0; step < 3; step++) {
      const before = topRow(await settled(app.setup))
      app.setup.mockInput.pressArrow("right")
      const frame = await waitForFrame(app.setup, (next) => topRow(next) !== before, "the next sub-agent")
      order.push(/子 agent (\d)\/3/.exec(topRow(frame))?.[1] ?? "")
    }
    expect(order).toEqual(["2", "3", "1"])
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("an only sub-agent shows 1/1 without the switch keys, in the top bar and in the footer", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    const frame = await waitForFrame(app.setup, (next) => topRow(next).includes("子 agent 1/1"), "the position")
    expect(topRow(frame)).not.toContain("←→")
    expect(footerRow(frame)).not.toContain("切换")
    expect(footerRow(frame)).toContain("esc 返回")
  } finally {
    await app.stop()
  }
})

test("clicking a middle segment opens that sub-agent", async () => {
  const middle = sessionFixture("ses_sub_mid", {
    parentID: rootID,
    title: "规划迁移 (@general subagent)",
    agent: "general",
  })
  const leaf = sessionFixture("ses_sub_leaf", {
    parentID: "ses_sub_mid",
    title: "扫描破坏性变更 (@explore subagent)",
    agent: "explore",
  })
  const app = await runApp({
    sessions: [root, middle, leaf],
    args: { sessionID: "ses_sub_leaf" },
    width: 160,
    height: 30,
  })
  try {
    const before = await waitForFrame(app.setup, (frame) => topRow(frame).includes("规划迁移"), "the middle segment")
    const row = topRow(before)
    await app.setup.mockMouse.click(cellWidth(row.slice(0, row.indexOf("规划迁移"))) + 1, 0)
    const after = await waitForFrame(app.setup, (frame) => !topRow(frame).includes("explore"), "the middle sub-agent")
    expect(topRow(after)).toContain("general · 规划迁移")
    expect(after).toContain("只读")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

// ── the tag of a background run in the top bar (#1058 8) ───────────────────────────────────────────────────────

test("a background run's view has the tag after its description; a foreground run's has none", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    const first = await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    // A sub-agent whose Task call is not known, or one the main agent waits for, is not tagged.
    expect(topRow(first)).toContain("› explore · 扫描破坏性变更")
    expect(topRow(first)).not.toContain("后台")
    app.events.emit(taskPart(childID, "explore", "扫描破坏性变更"))
    expect(topRow(await settled(app.setup))).not.toContain("后台")

    app.events.emit(taskPart(childID, "explore", "扫描破坏性变更", { background: true }))
    const tagged = await waitForFrame(app.setup, (frame) => topRow(frame).includes("· 后台"), "the tag")
    expect(topRow(tagged)).toContain("› explore · 扫描破坏性变更 · 后台")
    // The tag is the muted text of the description's own color, and the footer says nothing of it.
    expect(footerRow(tagged)).not.toContain("后台")

    // A run that was moved there while it ran says that.
    app.events.emit(taskPart(childID, "explore", "扫描破坏性变更", { background: true, promoted: true }))
    const moved = await waitForFrame(app.setup, (frame) => topRow(frame).includes("后台（已转）"), "the moved tag")
    expect(topRow(moved)).toContain("› explore · 扫描破坏性变更 · 后台（已转）")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("says the tag in English too", async () => {
  const app = await runApp({
    sessions,
    args: { sessionID: childID },
    width: 120,
    height: 30,
    handler: (url) => (url.pathname === "/config" ? json({ language: "en" }) : undefined),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("read-only"), "the English footer")
    app.events.emit(taskPart(childID, "explore", "scan", { background: true }))
    const tagged = await waitForFrame(app.setup, (frame) => topRow(frame).includes("· background"), "the tag")
    expect(topRow(tagged)).toContain("› explore · scan · background")
    app.events.emit(taskPart(childID, "explore", "scan", { background: true, promoted: true }))
    const moved = await waitForFrame(
      app.setup,
      (frame) => topRow(frame).includes("background (moved)"),
      "the moved tag",
    )
    expect(topRow(moved)).toContain("› explore · scan · background (moved)")
  } finally {
    await app.stop()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`the tag fits 80 columns in ${language} at ambiguous_width ${ambiguousWidth}, and the top bar never overflows`, async () => {
      const app = await runApp({
        sessions: language === "en" ? [longRootEn, longChildEn] : [longRoot, longChild],
        args: { sessionID: childID },
        width: 80,
        height: 24,
        ambiguousWidth,
        handler: (url) => (url.pathname === "/config" ? json({ language }) : undefined),
      })
      try {
        await waitForFrame(
          app.setup,
          (value) => footerRow(value).includes(language === "en" ? "read-only" : "只读"),
          "the sub-agent footer",
        )
        const description =
          language === "en"
            ? "Scan every changelog for breaking changes and summarize each finding"
            : "扫描全部变更日志中的破坏性变更并汇总每一项发现"
        app.events.emit(taskPart(childID, "general-purpose", description, { background: true, promoted: true }))
        // Whatever room the tag has, it is drawn whole or not at all: the row never exceeds the screen, and the
        // current segment and the position at the right edge are there.
        for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()
        const frame = await captureFrame(app.setup)
        for (const line of frame.split("\n")) expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        const row = topRow(frame)
        expect(row).toContain("general-purpose")
        expect(row).toContain(language === "en" ? "subagent 1/1" : "子 agent 1/1")
        if (row.includes(language === "en" ? "background" : "后台")) {
          expect(row).toContain(language === "en" ? "background (moved)" : "后台（已转）")
        }
      } finally {
        await app.stop()
      }
    })
  }
}
