// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../src/i18n"
import { Home } from "../../src/routes/home"
import { mountRoute, sessionFixture, waitFor } from "./dag-mode-harness"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

function mountHome(extra: Partial<Parameters<typeof mountRoute>[0]> = {}) {
  return mountRoute({
    route: { type: "home" },
    view: () => <Home />,
    sessions: [sessionFixture("ses_other")],
    ...extra,
  })
}

test("<leader>d on home sends no request and explains where to set the mode", async () => {
  const harness = await mountHome()
  try {
    await harness.leaderD()
    await waitFor(() => harness.toast().currentToast !== null)
    expect(harness.toast().currentToast).toMatchObject({
      text: "先开始会话，或在 /config 设置新会话默认值",
      level: "info",
    })
    expect(harness.writes()).toEqual([])
    expect(harness.commands()).toEqual([])
    // The leader sequence is consumed by the keymap: nothing is typed into the prompt.
    expect(harness.promptDraft()).toBe("")
  } finally {
    await harness.dispose()
  }
})

test("the home hint follows the interface language", async () => {
  const harness = await mountHome({ language: "en" })
  try {
    await harness.leaderD()
    await waitFor(() => harness.toast().currentToast !== null)
    expect(harness.toast().currentToast?.text).toBe("Start a session first, or set the new-session default in /config")
  } finally {
    await harness.dispose()
  }
})

test("repeating <leader>d on home merges into one toast", async () => {
  const harness = await mountHome()
  try {
    await harness.leaderD()
    await harness.leaderD()
    await harness.leaderD()
    await waitFor(() => harness.toast().currentToast !== null)
    expect(harness.toast().queued).toHaveLength(0)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("home does not list the shortcut in the help panel", async () => {
  const harness = await mountHome()
  try {
    const entry = harness
      .keymap()
      .getCommandEntries({ visibility: "registered" })
      .find((item) => item.command.name === "session.dagmode.toggle")
    expect(entry?.command.hidden).toBe(true)
    expect(entry?.bindings.length).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

test("a rebound key replaces <leader>d on home", async () => {
  const harness = await mountHome({ keybinds: { keybinds: { session_dagmode_toggle: "f9" } } })
  try {
    const bindings = harness.keymap().getCommandBindings({
      visibility: "registered",
      commands: ["session.dagmode.toggle"],
    })
    expect(
      bindings.get("session.dagmode.toggle")?.map((binding) => binding.sequence.map((part) => part.stroke.name)),
    ).toEqual([["f9"]])

    harness.app.mockInput.pressKey("F9")
    await harness.settle()
    await waitFor(() => harness.toast().currentToast !== null)
    expect(harness.toast().currentToast?.level).toBe("info")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
