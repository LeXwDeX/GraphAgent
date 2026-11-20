// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { renderUntilFrame } from "./fixture/frames"
import { footerRow, runApp } from "./fixture/run-app"
import { directory } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

/**
 * The top bar of the real app says where the user is (#1674): the directory of the session on screen and its branch,
 * then the session title; on home the directory a new session starts in and its branch. A sub-agent view keeps the path
 * of its sessions and names no directory. The footer of home no longer carries the directory.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const mainID = "ses_bar_main"
const rootID = "ses_bar_root"
const childID = "ses_bar_child"

const firstRow = (frame: string) => (frame.split("\n")[0] ?? "").trimEnd()

function branchEvent(branch: string): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    payload: { id: `evt_bar_${branch}`, type: "vcs.branch.updated", properties: { branch } },
  } as GlobalEvent
}

test("a session's top bar names its directory and branch before its title, and the model after it", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID, { title: "Layout guard" })], args: { continue: true } })
  try {
    const frame = await renderUntilFrame(
      app.setup,
      (value) => firstRow(value).includes("(main)") && firstRow(value).includes("Layout guard"),
      "the directory, the branch and the title",
    )
    expect(firstRow(frame)).toStartWith(`  ◇─◆ GraphAgent  ${directory} (main) › Layout guard`)
    expect(firstRow(frame)).toEndWith("Test model")
  } finally {
    await app.stop()
  }
})

test("the branch is the one of the directory this process runs in: a session of another directory has none", async () => {
  const app = await runApp({
    sessions: [sessionFixture(mainID, { title: "Elsewhere", directory: "/srv/other/project" })],
    args: { continue: true },
  })
  try {
    const frame = await renderUntilFrame(
      app.setup,
      (value) => firstRow(value).includes("Elsewhere"),
      "the directory and the title",
    )
    expect(firstRow(frame)).toStartWith("  ◇─◆ GraphAgent  /srv/other/project › Elsewhere")
    expect(firstRow(frame)).not.toContain("(main)")
  } finally {
    await app.stop()
  }
})

test("the bar follows the branch when it changes", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID, { title: "Layout guard" })], args: { continue: true } })
  try {
    await renderUntilFrame(app.setup, (value) => firstRow(value).includes("(main)"), "the first branch")
    app.events.emit(branchEvent("feat/topbar"))
    const frame = await renderUntilFrame(
      app.setup,
      (value) => firstRow(value).includes("(feat/topbar)"),
      "the new branch",
    )
    expect(firstRow(frame)).toStartWith(`  ◇─◆ GraphAgent  ${directory} (feat/topbar) › Layout guard`)
  } finally {
    await app.stop()
  }
})

test("home names the directory a new session starts in, with no title, and its footer no longer does", async () => {
  const app = await runApp({ sessions: [], args: {} })
  try {
    const frame = await renderUntilFrame(
      app.setup,
      (value) => firstRow(value).includes("(main)") && footerRow(value).includes("build"),
      "the directory on home",
    )
    expect(firstRow(frame)).toStartWith(`  ◇─◆ GraphAgent  ${directory} (main)`)
    expect(firstRow(frame)).not.toContain("›")
    expect(footerRow(frame)).not.toContain(directory)
    expect(footerRow(frame)).not.toContain(":main")
  } finally {
    await app.stop()
  }
})

test("a sub-agent view keeps the path of its sessions and names no directory", async () => {
  const root = sessionFixture(rootID, { title: "升级工具链与全部依赖" })
  const child = sessionFixture(childID, {
    parentID: rootID,
    title: "扫描破坏性变更 (@explore subagent)",
    agent: "explore",
  })
  const app = await runApp({ sessions: [root, child], args: { sessionID: childID } })
  try {
    const frame = await renderUntilFrame(app.setup, (value) => value.includes("只读"), "the sub-agent view")
    expect(firstRow(frame)).toStartWith("  ◇─◆ GraphAgent › 升级工具链与全部依赖 › ")
    expect(firstRow(frame)).not.toContain(directory)
    expect(firstRow(frame)).not.toContain("(main)")
  } finally {
    await app.stop()
  }
})

test("the terminal title stays the session title alone", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID, { title: "Layout guard" })], args: { continue: true } })
  const titles: string[] = []
  // `runApp` silences the native title control; record what the app asks for instead.
  app.setup.renderer.setTerminalTitle = (title: string) => {
    titles.push(title)
  }
  try {
    await renderUntilFrame(app.setup, (value) => firstRow(value).includes("(main)"), "the directory")
    expect(titles.at(-1)).toBe("GA | Layout guard")
    expect(titles.filter((title) => title.includes(directory))).toEqual([])
  } finally {
    await app.stop()
  }
})
