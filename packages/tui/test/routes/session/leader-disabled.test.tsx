// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Main } from "../../../src/routes/session"
import { mountRoute, sessionFixture, waitFor } from "../dag-mode-harness"

/**
 * A leader chord whose command is disabled does nothing and is not typed into the prompt. The redo chord is the
 * reported case: with no reverted message `session.redo` is disabled, and `<leader>r` used to put an "r" in the
 * prompt. The background chord is a second command that the route switches off (no foreground task is running).
 */

const mainID = "ses_leader_main"

function mountMain(session = sessionFixture(mainID)) {
  return mountRoute({
    route: { type: "session", sessionID: mainID },
    view: () => <Main />,
    frame: true,
    sessions: [session],
  })
}

type Harness = Awaited<ReturnType<typeof mountMain>>

/** Presses the default leader key and then `key`, and lets the route settle. */
async function chord(harness: Harness, key: string) {
  harness.app.mockInput.pressKey("x", { ctrl: true })
  await harness.app.renderOnce()
  harness.app.mockInput.pressKey(key)
  await harness.settle()
}

test("<leader>r on a session that is not reverted does nothing and types nothing", async () => {
  const harness = await mountMain()
  try {
    await chord(harness, "r")
    expect(harness.promptDraft()).toBe("")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("<leader>w with no foreground task running does nothing and types nothing", async () => {
  const harness = await mountMain()
  try {
    await chord(harness, "w")
    expect(harness.promptDraft()).toBe("")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("an available chord still runs after a disabled one was consumed", async () => {
  const harness = await mountMain(sessionFixture(mainID, { dagMode: "off" }))
  try {
    await chord(harness, "r")
    await chord(harness, "d")
    await waitFor(() => harness.commands().length > 0)
    expect(harness.commands()).toHaveLength(1)
    expect(harness.commands()[0].body).toMatchObject({ command: "dag-mode", arguments: "on" })
    expect(harness.writes()).toHaveLength(1)
    expect(harness.promptDraft()).toBe("")
  } finally {
    await harness.dispose()
  }
})

test("typing outside a leader chord reaches the prompt", async () => {
  const harness = await mountMain()
  try {
    harness.app.mockInput.pressKey("r")
    harness.app.mockInput.pressKey("w")
    await harness.settle()
    expect(harness.promptDraft()).toBe("rw")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("the key after a consumed chord types as usual", async () => {
  const harness = await mountMain()
  try {
    await chord(harness, "r")
    harness.app.mockInput.pressKey("r")
    await harness.settle()
    expect(harness.promptDraft()).toBe("r")
  } finally {
    await harness.dispose()
  }
})
