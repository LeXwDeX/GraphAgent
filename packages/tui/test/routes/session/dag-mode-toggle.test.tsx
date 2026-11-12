// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import { Main } from "../../../src/routes/session"
import { json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type Sent } from "../dag-mode-harness"

const mainID = "ses_dagmode_main"
const childID = "ses_dagmode_child"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

/** The `arguments` field of a recorded `/command` request body. */
function argumentsOf(item: Sent) {
  const body = item.body
  return typeof body === "object" && body !== null && "arguments" in body ? body.arguments : undefined
}

function mountMain(
  sessions: Parameters<typeof mountRoute>[0]["sessions"],
  initial: string,
  extra: Partial<Parameters<typeof mountRoute>[0]> = {},
) {
  return mountRoute({ route: { type: "session", sessionID: initial }, view: () => <Main />, sessions, ...extra })
}

test("<leader>d on a session with the mode off sends one /dag-mode on command and nothing else", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "off" })], mainID)
  try {
    await harness.leaderD()
    await waitFor(() => harness.commands().length > 0)
    expect(harness.writes()).toEqual([
      {
        method: "POST",
        path: `/session/${mainID}/command`,
        body: { hookMode: "interactive", command: "dag-mode", arguments: "on" },
      },
    ])
    // The leader sequence is consumed by the keymap: nothing is typed into the prompt.
    expect(harness.promptDraft()).toBe("")
  } finally {
    await harness.dispose()
  }
})

test("<leader>d on a session with the mode on sends /dag-mode off", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "on" })], mainID)
  try {
    await harness.leaderD()
    await waitFor(() => harness.commands().length > 0)
    expect(harness.commands()).toHaveLength(1)
    expect(harness.commands()[0].body).toMatchObject({ command: "dag-mode", arguments: "off" })
    expect(harness.writes()).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})

test("a session without a recorded mode counts as off", async () => {
  const harness = await mountMain([sessionFixture(mainID)], mainID)
  try {
    await harness.leaderD()
    await waitFor(() => harness.commands().length > 0)
    expect(harness.commands()[0].body).toMatchObject({ command: "dag-mode", arguments: "on" })
  } finally {
    await harness.dispose()
  }
})

test("the command carries the selected agent and model", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "off" })], mainID, { withAgentAndModel: true })
  try {
    await harness.leaderD()
    await waitFor(() => harness.commands().length > 0)
    expect(harness.commands()[0].body).toEqual({
      hookMode: "interactive",
      command: "dag-mode",
      arguments: "on",
      agent: "build",
      model: "test/test-model",
    })
  } finally {
    await harness.dispose()
  }
})

test("the mode comes from the server: a press does not flip it locally", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "off" })], mainID)
  try {
    await harness.leaderD()
    await harness.leaderD()
    await waitFor(() => harness.commands().length > 1)
    // Without a session.updated event in between, both presses ask for "on".
    expect(harness.commands().map(argumentsOf)).toEqual(["on", "on"])

    const updated = (dagMode: "on" | "off") =>
      harness.events.emit({
        directory: "/tmp/opencode/packages/tui",
        payload: {
          id: `evt_dagmode_${dagMode}`,
          type: "session.updated",
          properties: { sessionID: mainID, info: sessionFixture(mainID, { dagMode }) },
        },
      })
    updated("on")
    await harness.settle()
    await harness.leaderD()
    updated("off")
    await harness.settle()
    await harness.leaderD()
    await waitFor(() => harness.commands().length > 3)
    expect(harness.commands().map(argumentsOf)).toEqual(["on", "on", "off", "on"])
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent view ignores <leader>d", async () => {
  const harness = await mountMain(
    [sessionFixture(mainID, { dagMode: "off" }), sessionFixture(childID, { parentID: mainID, dagMode: "off" })],
    childID,
  )
  try {
    await harness.leaderD()
    await harness.leaderD()
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent view does not list the shortcut while the main view does", async () => {
  const listed = async (initial: string) => {
    const harness = await mountMain(
      [sessionFixture(mainID, { dagMode: "off" }), sessionFixture(childID, { parentID: mainID, dagMode: "off" })],
      initial,
    )
    try {
      const entry = harness
        .keymap()
        .getCommandEntries({ visibility: "registered" })
        .find((item) => item.command.name === "session.dagmode.toggle")
      return entry ? { title: entry.command.title, hidden: entry.command.hidden === true } : undefined
    } finally {
      await harness.dispose()
    }
  }
  expect(await listed(mainID)).toEqual({ title: "切换本会话的 DAG 模式", hidden: false })
  expect(await listed(childID)).toEqual({ title: "切换本会话的 DAG 模式", hidden: true })
})

test("the shortcut description follows the interface language", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "off" })], mainID, { language: "en" })
  try {
    const entry = harness
      .keymap()
      .getCommandEntries({ visibility: "registered" })
      .find((item) => item.command.name === "session.dagmode.toggle")
    expect(entry?.command.title).toBe("Toggle DAG mode for this session")
  } finally {
    await harness.dispose()
  }
})

test("a rebound key replaces <leader>d", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "off" })], mainID, {
    keybinds: { keybinds: { session_dagmode_toggle: "f9" } },
  })
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
    await waitFor(() => harness.commands().length > 0)
    expect(harness.commands()).toHaveLength(1)
    expect(harness.commands()[0].body).toMatchObject({ command: "dag-mode", arguments: "on" })
  } finally {
    await harness.dispose()
  }
})

test("a rejected command shows an error toast and no second request", async () => {
  const harness = await mountMain([sessionFixture(mainID, { dagMode: "off" })], mainID, {
    command: () => json({ name: "NotFoundError", data: { message: "Command not found: dag-mode" } }, { status: 404 }),
  })
  try {
    await harness.leaderD()
    await waitFor(() => harness.toast().currentToast !== null)
    expect(harness.toast().currentToast).toMatchObject({ text: "Command not found: dag-mode", level: "error" })
    expect(harness.commands()).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})
