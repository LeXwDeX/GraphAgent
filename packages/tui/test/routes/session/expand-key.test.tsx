// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { Show } from "solid-js"
import { setLanguage } from "../../../src/i18n"
import { Main } from "../../../src/routes/session"
import { AppFrame } from "../../../src/shell/app-frame"
import { BottomZone, BottomZoneProvider, createBottomZoneState } from "../../../src/shell/bottom-zone"
import { useFooterKeyHints } from "../../../src/shell/footer"
import { mountRoute, sessionFixture, type MountOptions } from "../dag-mode-harness"

/**
 * `view.expand.toggle` (ctrl+o, #886 4.4) as the keymap and the footer see it. What the key does to the blocks of
 * a transcript is in `expand-toggle.test.tsx` and `expand.test.ts`.
 */

const mainID = "ses_expand_main"
const childID = "ses_expand_child"
const sessions = [sessionFixture(mainID), sessionFixture(childID, { parentID: mainID })]

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

/** The session screen with the footer hints the app builds from the keymap; `session` off is a route without one. */
function Screen(props: { session: boolean }) {
  const keys = useFooterKeyHints()
  const bottomZone = createBottomZoneState()
  return (
    <BottomZoneProvider state={bottomZone}>
      <AppFrame
        footer={{ agent: "build", agentAction: keys().agent, hints: keys().hints }}
        bottomZone={<BottomZone state={bottomZone} composer={<></>} />}
      >
        <Show when={props.session}>
          <Main />
        </Show>
      </AppFrame>
    </BottomZoneProvider>
  )
}

function mount(initial: string, options: Partial<MountOptions> & { session?: boolean } = {}) {
  const { session = true, ...rest } = options
  return mountRoute({
    route: { type: "session", sessionID: initial },
    view: () => <Screen session={session} />,
    sessions,
    ...rest,
  })
}

function expandEntry(harness: Awaited<ReturnType<typeof mount>>) {
  return harness
    .keymap()
    .getCommandEntries({ visibility: "registered" })
    .find((entry) => entry.command.name === "view.expand.toggle")
}

test("the footer lists the expand shortcut while a session is open", async () => {
  const harness = await mount(mainID)
  try {
    const frame = await harness.waitForFrame((text) => text.includes("展开输出"), "the expand hint")
    const footer = frame.trimEnd().split("\n").at(-1)!
    expect(footer).toContain("ctrl+o 展开输出")
  } finally {
    await harness.dispose()
  }
})

test("the footer hint follows the interface language", async () => {
  const harness = await mount(mainID, { language: "en" })
  try {
    const frame = await harness.waitForFrame((text) => text.includes("expand output"), "the English hint")
    expect(frame.trimEnd().split("\n").at(-1)).toContain("ctrl+o expand output")
    expect(frame).not.toContain("展开输出")
  } finally {
    await harness.dispose()
  }
})

test("a rebound key replaces ctrl+o in the footer and in the keymap", async () => {
  const harness = await mount(mainID, { keybinds: { keybinds: { view_expand_toggle: "f7" } } })
  try {
    const frame = await harness.waitForFrame((text) => text.includes("展开输出"), "the expand hint")
    const footer = frame.trimEnd().split("\n").at(-1)!
    expect(footer).toContain("f7 展开输出")
    expect(footer).not.toContain("ctrl+o")

    const bindings = harness.keymap().getCommandBindings({ visibility: "registered", commands: ["view.expand.toggle"] })
    expect(
      bindings.get("view.expand.toggle")?.map((binding) => binding.sequence.map((part) => part.stroke.name)),
    ).toEqual([["f7"]])
  } finally {
    await harness.dispose()
  }
})

test("a route without a session lists no expand hint: there is nothing to open", async () => {
  const harness = await mount(mainID, { session: false })
  try {
    await harness.settle()
    expect(await harness.frame()).not.toContain("展开输出")
    expect(expandEntry(harness)).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})

test("the shortcut panel lists the command with a title and a note in both languages", async () => {
  const listed = async (language: "zh-CN" | "en") => {
    const harness = await mount(mainID, { language })
    try {
      const entry = expandEntry(harness)
      return entry
        ? { title: entry.command.title, note: entry.command.desc, hidden: entry.command.hidden === true }
        : undefined
    } finally {
      await harness.dispose()
    }
  }
  expect(await listed("zh-CN")).toEqual({
    title: "展开或折叠最近的输出",
    note: "作用于最近一个可折叠的推理、工具输出或工具错误",
    hidden: false,
  })
  expect(await listed("en")).toEqual({
    title: "Expand or collapse the latest output",
    note: "Acts on the latest foldable reasoning, tool output or tool error",
    hidden: false,
  })
})

test("a sub-agent view keeps the key and the key sends nothing", async () => {
  const harness = await mount(childID)
  try {
    // Sub-agent views are read only (#886 section 9), and opening a block is not a request.
    expect(expandEntry(harness)?.command.hidden).not.toBe(true)
    harness.app.mockInput.pressKey("o", { ctrl: true })
    await harness.settle()
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
