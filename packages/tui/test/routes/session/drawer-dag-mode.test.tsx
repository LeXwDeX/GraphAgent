// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { GlobalEvent, Goal, Session } from "@graphagent/sdk"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { useTuiConfig } from "../../../src/config"
import { setLanguage } from "../../../src/i18n"
import { useBindings } from "../../../src/keymap"
import { SessionDrawer } from "../../../src/routes/session/drawer"
import { Drawer, DRAWER_WIDTH } from "../../../src/shell/drawer"
import { cellWidth } from "../../../src/ui/width"
import { directory } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, type MountOptions } from "../dag-mode-harness"

// The drawer's line about the DAG mode: where it sits, what it says, that it is the root session's alone and that it
// is only to be read (#1032 5.1, 7.1).

const ROOT = "ses_drawer_root"
const CHILD = "ses_drawer_child"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

let sequence = 0
function event(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, payload: { id: `evt_drawer_${++sequence}`, type, properties } } as GlobalEvent
}

/** What the session route registers for the mode switch, so the drawer has a key to show. */
function ModeSwitchBinding() {
  const config = useTuiConfig()
  useBindings(() => ({
    commands: [{ name: "session.dagmode.toggle", title: "Toggle DAG mode", category: "Session", run: () => {} }],
    bindings: config.keybinds.gather("session_dagmode_toggle", ["session.dagmode.toggle"]),
  }))
  return null
}

async function mountDrawer(options: { root?: Partial<Session>; sessionID?: string } & Partial<MountOptions> = {}) {
  const { root, sessionID, ...rest } = options
  return mountRoute({
    route: { type: "session", sessionID: sessionID ?? ROOT },
    sessions: [
      sessionFixture(ROOT, { time: { created: 1, updated: 9 }, ...root }),
      sessionFixture(CHILD, { parentID: ROOT, dagMode: "on" }),
    ],
    view: () => (
      <>
        <ModeSwitchBinding />
        <Drawer>
          <SessionDrawer sessionID={sessionID ?? ROOT} />
        </Drawer>
      </>
    ),
    width: 100,
    height: 30,
    ...rest,
  })
}

type Mount = Awaited<ReturnType<typeof mountDrawer>>

const rowsOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

/** The drawer's column of a frame, line by line. */
const columnOf = (frame: string) => rowsOf(frame).map((line) => line.slice(100 - DRAWER_WIDTH).trim())

/** Waits for a frame whose drawer column satisfies `ready`, and hands back that column. */
async function column(harness: Mount, ready: (lines: string[]) => boolean, what: string) {
  return columnOf(await harness.waitForFrame((value) => ready(columnOf(value)), what))
}

const hasLine = (lines: string[], needle: string) => lines.some((line) => line.includes(needle))

describe("the DAG mode line of the drawer", () => {
  test("says the mode is on, with the key that switches it", async () => {
    const harness = await mountDrawer({ root: { dagMode: "on" } })
    try {
      const lines = await column(harness, (all) => all.some((line) => line.includes("DAG 模式")), "the line")
      expect(lines.find((line) => line.includes("DAG 模式"))).toBe("DAG 模式 开 ⌃X D")
    } finally {
      await harness.dispose()
    }
  })

  test("says the mode is off, with nothing to press", async () => {
    const harness = await mountDrawer()
    try {
      const lines = await column(harness, (all) => all.some((line) => line.includes("DAG 模式")), "the line")
      expect(lines.find((line) => line.includes("DAG 模式"))).toBe("DAG 模式 关")
    } finally {
      await harness.dispose()
    }
  })

  test("uses the key the user bound, and leaves the key out when there is none", async () => {
    const rebound = await mountDrawer({
      root: { dagMode: "on" },
      keybinds: { keybinds: { session_dagmode_toggle: "f9" } },
    })
    try {
      const lines = await column(rebound, (all) => all.some((line) => line.includes("DAG 模式")), "the line")
      expect(lines.find((line) => line.includes("DAG 模式"))).toBe("DAG 模式 开 F9")
    } finally {
      await rebound.dispose()
    }

    const unbound = await mountDrawer({
      root: { dagMode: "on" },
      keybinds: { keybinds: { session_dagmode_toggle: "none" } },
    })
    try {
      const lines = await column(unbound, (all) => all.some((line) => line.includes("DAG 模式")), "the line")
      expect(lines.find((line) => line.includes("DAG 模式"))).toBe("DAG 模式 开")
    } finally {
      await unbound.dispose()
    }
  })

  test("sits between the cost and the goal", async () => {
    const harness = await mountDrawer({ root: { dagMode: "on" } })
    try {
      const goal: Goal = { goal: "全部依赖升到最新", status: "active", turnsUsed: 1, maxTurns: 10 }
      harness.events.emit(event("goal.updated", { sessionID: ROOT, goal }))
      const lines = await column(
        harness,
        (all) =>
          all.some((line) => line.includes("DAG 模式")) &&
          all.some((line) => line.startsWith("目标")) &&
          all.some((line) => line.includes("缓存 读")),
        "the line, the goal and the cost",
      )
      const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
      expect(at("费用")).toBeGreaterThan(-1)
      // Under the whole cost section: the heading and the lines of the usage that is read once the drawer is open.
      expect(at("DAG 模式")).toBeGreaterThan(at("缓存 读"))
      expect(at("DAG 模式")).toBeLessThan(at("目标"))
    } finally {
      await harness.dispose()
    }
  })

  test("follows the session's own switch", async () => {
    const harness = await mountDrawer()
    try {
      await column(harness, (all) => hasLine(all, "DAG 模式 关"), "off")
      harness.events.emit(
        event("session.updated", { info: sessionFixture(ROOT, { time: { created: 1, updated: 10 }, dagMode: "on" }) }),
      )
      await column(harness, (all) => hasLine(all, "DAG 模式 开"), "on")
      harness.events.emit(
        event("session.updated", { info: sessionFixture(ROOT, { time: { created: 1, updated: 11 }, dagMode: "off" }) }),
      )
      await column(harness, (all) => hasLine(all, "DAG 模式 关"), "off again")
    } finally {
      await harness.dispose()
    }
  })

  test("is not in the drawer of a sub-agent session, whatever mode it records", async () => {
    const harness = await mountDrawer({ sessionID: CHILD })
    try {
      // The rest of the drawer is there: the line is what is missing.
      const lines = await column(harness, (all) => hasLine(all, "费用"), "the drawer of the sub-agent session")
      expect(hasLine(lines, "DAG 模式")).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("is read only: a click on it changes nothing and sends nothing", async () => {
    const harness = await mountDrawer({ root: { dagMode: "on" } })
    try {
      const lines = await column(harness, (all) => hasLine(all, "DAG 模式"), "the line")
      const row = lines.findIndex((line) => line.includes("DAG 模式"))
      await harness.app.mockMouse.click(100 - DRAWER_WIDTH + 4, row)
      await harness.settle()
      expect(hasLine(await column(harness, (all) => hasLine(all, "DAG 模式 开"), "still on"), "DAG 模式 开")).toBe(true)
      expect(harness.writes()).toEqual([])
      expect(harness.commands()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const on = await mountDrawer({ root: { dagMode: "on" }, language: "en" })
    try {
      const lines = await column(on, (all) => hasLine(all, "DAG mode"), "the line")
      expect(lines.find((line) => line.includes("DAG mode"))).toBe("DAG mode on ⌃X D")
    } finally {
      await on.dispose()
    }
    const off = await mountDrawer({ language: "en" })
    try {
      const lines = await column(off, (all) => hasLine(all, "DAG mode"), "the line")
      expect(lines.find((line) => line.includes("DAG mode"))).toBe("DAG mode off")
    } finally {
      await off.dispose()
    }
  })

  for (const aw of [1, 2] as const) {
    for (const language of ["zh-CN", "en"] as const) {
      test(`stays inside the drawer's 40 columns, ${language}, ambiguous_width ${aw}`, async () => {
        setLanguage(language)
        const harness = await mountDrawer({ root: { dagMode: "on" }, language, kv: { ambiguous_width: aw } })
        try {
          const lines = await column(
            harness,
            (all) => hasLine(all, language === "en" ? "DAG mode" : "DAG 模式"),
            "the line",
          )
          const line = lines.find((value) => value.includes(language === "en" ? "DAG mode" : "DAG 模式")) ?? ""
          // The drawer pads two columns on each side and keeps one for its scrollbar.
          expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_WIDTH - 5)
        } finally {
          await harness.dispose()
        }
      })
    }
  }
})
