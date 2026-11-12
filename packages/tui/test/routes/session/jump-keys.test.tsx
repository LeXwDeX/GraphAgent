// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { Main } from "../../../src/routes/session"
import { mountRoute, sessionFixture, type MountOptions } from "../dag-mode-harness"

const sessionID = "ses_jump_keys"

type Harness = Awaited<ReturnType<typeof mountJump>>

async function mountJump(extra: Partial<MountOptions> = {}) {
  const harness = await mountRoute({
    route: { type: "session", sessionID },
    view: () => <Main />,
    sessions: [sessionFixture(sessionID)],
    ...extra,
  })
  // Record the commands the keymap actually runs; a key that is not consumed by
  // a binding never shows up here.
  const ran: string[] = []
  harness.keymap().on("dispatch", (event) => {
    if (event.phase === "binding-execute" && typeof event.command === "string") ran.push(event.command)
  })
  await harness.app.mockInput.typeText("hello world")
  await harness.settle()
  // The session prompt is the only text area in this view.
  const editor = () => {
    const focused = harness.app.renderer.currentFocusedEditor
    if (!(focused instanceof TextareaRenderable)) throw new Error("the prompt text area has no focus")
    return focused
  }
  return {
    ...harness,
    ran,
    editor,
    cursor: () => editor().cursorOffset,
    async press(key: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) {
      harness.app.mockInput.pressKey(key, modifiers)
      await harness.settle()
    },
    /** Drops focus from the prompt so only the unfocused layer applies. */
    async blur() {
      editor().blur()
      await harness.settle()
    },
  }
}

/** Commands recorded since `from`. */
function since(harness: Harness, from: number) {
  return harness.ran.slice(from)
}

test("Home and End move the prompt cursor while it has focus", async () => {
  const harness = await mountJump()
  try {
    expect(harness.cursor()).toBe("hello world".length)

    const start = harness.ran.length
    await harness.press("HOME")
    expect(harness.cursor()).toBe(0)
    await harness.press("END")
    expect(harness.cursor()).toBe("hello world".length)

    expect(since(harness, start)).toEqual(["input.buffer.home", "input.buffer.end"])
    expect(harness.ran).not.toContain("session.first")
    expect(harness.ran).not.toContain("session.last")
  } finally {
    await harness.dispose()
  }
})

test("Home and End jump to the first and last message once the prompt lost focus", async () => {
  const harness = await mountJump()
  try {
    await harness.blur()
    expect(harness.app.renderer.currentFocusedEditor).toBeNull()

    const start = harness.ran.length
    await harness.press("HOME")
    await harness.press("END")
    expect(since(harness, start)).toEqual(["session.first", "session.last"])
  } finally {
    await harness.dispose()
  }
})

test("ctrl+g and ctrl+alt+g jump while the prompt has focus and leave the draft alone", async () => {
  const harness = await mountJump()
  try {
    const start = harness.ran.length
    await harness.press("g", { ctrl: true })
    await harness.press("g", { ctrl: true, meta: true })
    expect(since(harness, start)).toEqual(["session.first", "session.last"])
    expect(harness.promptDraft()).toBe("hello world")
    expect(harness.cursor()).toBe("hello world".length)
  } finally {
    await harness.dispose()
  }
})

test("ctrl+g and ctrl+alt+g run their command once when the prompt has no focus", async () => {
  const harness = await mountJump()
  try {
    await harness.blur()
    const start = harness.ran.length
    await harness.press("g", { ctrl: true })
    await harness.press("g", { ctrl: true, meta: true })
    expect(since(harness, start)).toEqual(["session.first", "session.last"])
  } finally {
    await harness.dispose()
  }
})

test("a rebound plain jump key follows the same rule while a modified one always jumps", async () => {
  const harness = await mountJump({
    keybinds: { keybinds: { messages_first: "f6,ctrl+f6", messages_last: "ctrl+alt+g,end" } },
  })
  try {
    const start = harness.ran.length
    await harness.press("F6")
    expect(since(harness, start)).toEqual([])
    await harness.press("F6", { ctrl: true })
    expect(since(harness, start)).toEqual(["session.first"])

    await harness.blur()
    await harness.press("F6")
    expect(since(harness, start)).toEqual(["session.first", "session.first"])
  } finally {
    await harness.dispose()
  }
})
