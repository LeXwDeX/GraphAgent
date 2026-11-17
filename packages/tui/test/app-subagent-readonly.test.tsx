// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { BUILTIN_COMMANDS, type BuiltinCommandDefinition } from "../src/commands/catalog"
import { setLanguage, t } from "../src/i18n"
import { captureFrame, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import {
  assistantMessage,
  readPart,
  taskCall,
  textPart,
  userMessage,
  type MessageEntry,
} from "./fixture/session-records"
import { json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

/**
 * A sub-agent view is read-only (#1033 3.3): whatever a user can reach in it, no request that changes or asks the
 * sub-agent goes out. The real app runs against a fake server that records every write, and one pass touches
 * everything the view offers: its messages, every command of its palette, its keys, ← and →, the wheel, escape.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const rootID = "ses_ro_root"
const firstID = "ses_ro_first"
const secondID = "ses_ro_second"

const root = sessionFixture(rootID, { title: "升级工具链与全部依赖" })
const first = sessionFixture(firstID, {
  parentID: rootID,
  title: "扫描破坏性变更 (@explore subagent)",
  agent: "explore",
  time: { created: 10, updated: 11 },
})
const second = sessionFixture(secondID, {
  parentID: rootID,
  title: "核对依赖版本 (@explore subagent)",
  agent: "explore",
  time: { created: 20, updated: 21 },
})

const PROMPT = "请扫描 CHANGELOG 中的全部破坏性变更。"
const FOLLOW_UP = "再查一遍依赖的版本。"

const entries: Record<string, MessageEntry[]> = {
  [rootID]: [
    {
      info: userMessage("msg_ro_root_user", rootID, 1),
      parts: [textPart("msg_ro_root_user", rootID, "prt_ro_root_prompt", "升级所有依赖")],
    },
    {
      info: assistantMessage("msg_ro_root_assistant", rootID, "msg_ro_root_user", 2),
      parts: [
        taskCall({
          parentID: rootID,
          messageID: "msg_ro_root_assistant",
          id: "prt_ro_task_first",
          childID: firstID,
          status: "running",
        }),
        taskCall({
          parentID: rootID,
          messageID: "msg_ro_root_assistant",
          id: "prt_ro_task_second",
          childID: secondID,
          status: "running",
        }),
      ],
    },
  ],
  [firstID]: [
    {
      info: userMessage("msg_ro_first_user", firstID, 10),
      parts: [textPart("msg_ro_first_user", firstID, "prt_ro_first_prompt", PROMPT)],
    },
    {
      info: assistantMessage("msg_ro_first_assistant", firstID, "msg_ro_first_user", 11),
      parts: [
        readPart("msg_ro_first_assistant", firstID, "prt_ro_first_read"),
        textPart("msg_ro_first_assistant", firstID, "prt_ro_first_answer", "找到 2 处破坏性变更。"),
      ],
    },
    {
      info: userMessage("msg_ro_first_user_2", firstID, 12),
      parts: [textPart("msg_ro_first_user_2", firstID, "prt_ro_first_prompt_2", FOLLOW_UP)],
    },
    {
      info: assistantMessage("msg_ro_first_assistant_2", firstID, "msg_ro_first_user_2", 13),
      parts: [textPart("msg_ro_first_assistant_2", firstID, "prt_ro_first_answer_2", "版本都没有变。")],
    },
  ],
}

const transcripts: FetchHandler = (url) => {
  const id = /^\/session\/([^/]+)\/message$/.exec(url.pathname)?.[1]
  return id && entries[id] ? json(entries[id]) : undefined
}

/** What a panel's hint line ends with; a panel is open exactly while the frame has it. */
const PANEL_HINT = "escape 关闭"
/** A heading only the drawer draws. */
const DRAWER_MARK = "上下文"

async function settled(setup: Setup) {
  for (let pass = 0; pass < 4; pass++) await setup.renderOnce()
  return captureFrame(setup)
}

/** Closes what a command or a key opened: a panel with ctrl+c, the drawer with escape. Escape alone would leave the view. */
async function closeOverlay(setup: Setup) {
  const frame = await settled(setup)
  if (frame.includes(PANEL_HINT)) setup.mockInput.pressKey("c", { ctrl: true })
  else if (frame.includes(DRAWER_MARK)) setup.mockInput.pressEscape()
  return waitForFrame(setup, (value) => !value.includes(PANEL_HINT) && !value.includes(DRAWER_MARK), "no overlay")
}

async function openPalette(setup: Setup, filter: string) {
  setup.mockInput.pressKey("p", { ctrl: true })
  await waitForFrame(setup, (value) => value.includes("筛选"), "the palette")
  await setup.mockInput.typeText(filter)
  return settled(setup)
}

/** What a command shows when it runs, for the ones that show something in this app. */
const SHOWS: Record<string, string> = {
  "session.list": "搜索会话",
  "session.export": "导出选项",
  "config.open": "界面",
  "theme.switch": "graphagent",
  "session.drawer.toggle": DRAWER_MARK,
  "dag.open": "没有工作流",
  "graphagent.status": "版本",
}

/**
 * What #1033 3.3 allows in a sub-agent view, by the name the user types. It is written out here and not read from the
 * catalog, so a command that slips into the scope shows up as a difference and not as one more thing to run.
 */
const ALLOWED = [
  "new",
  "sessions",
  "copy",
  "export",
  "agents",
  "config",
  "theme",
  "status",
  "help",
  "sidebar",
  "dag",
  "exit",
]

/** The allowed commands that do not leave the view: `/new` goes home and `/exit` quits. */
const STAYING = BUILTIN_COMMANDS.filter(
  (command) => command.slash && ALLOWED.includes(command.slash.name) && !["new", "exit"].includes(command.slash.name),
)

/** Every other command a user can type by name in a main session. */
const OUTSIDE = BUILTIN_COMMANDS.filter(
  (command): command is BuiltinCommandDefinition & Required<Pick<BuiltinCommandDefinition, "slash">> =>
    Boolean(command.slash) && !ALLOWED.includes(command.slash?.name ?? "") && !command.enabled,
)

async function leader(setup: Setup, key: string) {
  setup.mockInput.pressKey("x", { ctrl: true })
  await setup.renderOnce()
  setup.mockInput.pressKey(key)
}

test("everything a sub-agent view offers is touched and no request is written", async () => {
  const app = await runApp({
    sessions: [root, first, second],
    args: { sessionID: firstID },
    width: 120,
    height: 40,
    handler: transcripts,
  })
  try {
    const view = await waitForFrame(app.setup, (value) => value.includes("版本都没有变"), "the sub-agent view")
    expect(view).toContain("只读")
    expect(app.writes()).toEqual([])

    // The messages: the task block and a prompt of the parent that came later. Neither opens an action list.
    for (const needle of [PROMPT, FOLLOW_UP]) {
      const rows = (await settled(app.setup)).split("\n")
      const row = rows.findIndex((line) => line.includes(needle))
      expect(row).toBeGreaterThan(-1)
      await app.setup.mockMouse.click(rows[row].indexOf(needle) + 2, row)
      expect(await settled(app.setup)).not.toContain(PANEL_HINT)
    }
    expect(app.writes()).toEqual([])

    // Every command of the palette that does not leave the view, as a click on its row would run it.
    for (const command of STAYING) {
      await openPalette(app.setup, t(command.titleKey))
      app.setup.mockInput.pressEnter()
      const shown = SHOWS[command.id]
      if (shown) await waitForFrame(app.setup, (value) => value.includes(shown), `${command.id} to show ${shown}`)
      await closeOverlay(app.setup)
      expect(app.writes()).toEqual([])
    }

    // The keys of a main session that change it or ask it: here they do nothing at all.
    for (const key of ["u", "c", "r", "w", "d"]) {
      await leader(app.setup, key)
      const frame = await settled(app.setup)
      expect(frame).not.toContain(PANEL_HINT)
      expect(frame).toContain("只读")
    }
    app.setup.mockInput.pressKey("r", { ctrl: true })
    expect(await settled(app.setup)).not.toContain(PANEL_HINT)
    // The timeline and the export are read-only panels.
    for (const key of ["g", "x"]) {
      await leader(app.setup, key)
      await waitForFrame(app.setup, (value) => value.includes(PANEL_HINT), `the panel of leader ${key}`)
      await closeOverlay(app.setup)
    }
    expect(app.writes()).toEqual([])

    // The wheel, and ← → between the two sub-agents.
    await app.setup.mockMouse.scroll(30, 10, "up")
    await app.setup.mockMouse.scroll(30, 10, "down")
    app.setup.mockInput.pressArrow("right")
    await waitForFrame(app.setup, (value) => value.includes("子 agent 2/2"), "the second sub-agent")
    app.setup.mockInput.pressArrow("left")
    await waitForFrame(app.setup, (value) => value.includes("子 agent 1/2"), "the first sub-agent")
    expect(app.writes()).toEqual([])

    // Escape goes back to the parent session: it is no interrupt of the sub-agent.
    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, (value) => !value.includes("只读"), "the parent session")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("the command that starts a new session leaves the view and writes nothing", async () => {
  const app = await runApp({
    sessions: [root, first, second],
    args: { sessionID: firstID },
    width: 120,
    height: 40,
    handler: transcripts,
  })
  try {
    await waitForFrame(app.setup, (value) => value.includes("只读"), "the sub-agent view")
    await openPalette(app.setup, t("command.session.new.title"))
    app.setup.mockInput.pressEnter()
    await waitForFrame(app.setup, (value) => !value.includes("只读"), "home")
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("the palette of a sub-agent view finds none of the commands that change or ask the sub-agent", async () => {
  const app = await runApp({
    sessions: [root, first, second],
    args: { sessionID: firstID },
    width: 120,
    height: 40,
    handler: transcripts,
  })
  try {
    await waitForFrame(app.setup, (value) => value.includes("只读"), "the sub-agent view")
    expect(STAYING).toHaveLength(ALLOWED.length - 2)
    expect(OUTSIDE.map((command) => command.slash.name)).toEqual(
      expect.arrayContaining(["rename", "fork", "undo", "redo", "compact", "move", "btw", "model", "agent", "mcp"]),
    )
    for (const command of OUTSIDE) {
      const frame = await openPalette(app.setup, t(command.titleKey))
      expect(frame).toContain(t("panel.list.empty"))
      app.setup.mockInput.pressKey("c", { ctrl: true })
      await waitForFrame(app.setup, (value) => !value.includes(PANEL_HINT), "the palette closed")
    }
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})
