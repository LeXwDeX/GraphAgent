// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { Home } from "../../src/routes/home"
import { Main } from "../../src/routes/session"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "../routes/dag-mode-harness"

/**
 * #886 1.4: the prompt's cursor does not blink. opentui's textarea defaults to a blinking
 * block, so the prompt passes `cursorStyle` explicitly; `source-guards.test.ts` only proves the
 * BLINK/fade code is gone. These tests read what the renderer draws for the focused prompt.
 */

async function expectSteadyCursor(options: MountOptions) {
  const harness = await mountRoute(options)
  try {
    await waitFor(() => harness.app.renderer.getCursorState().visible)
    expect(harness.app.renderer.getCursorState()).toMatchObject({ visible: true, style: "block", blinking: false })

    const editor = harness.app.renderer.currentFocusedEditor
    expect(editor).toBeInstanceOf(TextareaRenderable)
    expect(editor?.cursorStyle).toEqual({ style: "block", blinking: false })
  } finally {
    await harness.dispose()
  }
}

test("the home prompt draws a steady block cursor", async () => {
  await expectSteadyCursor({ route: { type: "home" }, view: () => <Home /> })
})

test("the session prompt draws a steady block cursor", async () => {
  await expectSteadyCursor({
    route: { type: "session", sessionID: "ses_cursor" },
    view: () => <Main />,
    sessions: [sessionFixture("ses_cursor")],
  })
})
