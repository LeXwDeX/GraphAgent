// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { setLanguage, t } from "../src/i18n"
import { cellWidth } from "../src/ui/width"
import { captureFrame, footerRow, runApp, waitFor, waitForFrame, type Setup } from "./fixture/run-app"
import { json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a server that refuses a write the way it refuses one aimed at a sub-agent's session: 409
// `ChildSessionReadOnlyError` (#1618). No write entry of the TUI sends such a request today (a sub-agent view has no
// input and its commands are off), so the refusal is simulated on a write of the main session; what is under test is
// that the app, whatever sends the request, says why in the footer, once, and carries on.

afterEach(() => {
  setLanguage("zh-CN")
})

const mainID = "ses_refused_main"

const HINT = {
  "zh-CN": "这是子 agent 的会话，只读：要调整它，请回主会话告诉主 agent",
  en: "This is a sub-agent session and is read-only: go back to the main session and tell the main agent",
} as const

type Language = keyof typeof HINT

const SERVER_MESSAGE = "This is a child session and is read-only. Send input to its parent agent instead."

/** The server refuses the writes of the main session that end in one of `endings`, with the error it gives `error`. */
function refusing(language: Language, endings: string[], error: { name: string; message: string }): FetchHandler {
  return (url, request) => {
    if (url.pathname === "/config") return json({ language })
    if (request?.method !== "POST") return undefined
    if (!endings.some((ending) => url.pathname === `/session/${mainID}/${ending}`)) return undefined
    return json({ name: error.name, data: { sessionID: mainID, message: error.message } }, { status: 409 })
  }
}

const refusal = { name: "ChildSessionReadOnlyError", message: SERVER_MESSAGE }

async function leader(setup: Setup, key: string) {
  setup.mockInput.pressKey("x", { ctrl: true })
  await setup.renderOnce()
  setup.mockInput.pressKey(key)
}

/** The prompt shows the model once it is loaded, which a write that names the model needs. */
const MODEL_MARK = "Test model"

for (const language of ["zh-CN", "en"] as const) {
  test(`${language}: <leader>d sends one command, the footer says why it was refused and the app keeps taking keys`, async () => {
    const app = await runApp({
      sessions: [sessionFixture(mainID, { dagMode: "on" })],
      args: { continue: true },
      width: 140,
      height: 30,
      handler: refusing(language, ["command"], refusal),
    })
    try {
      await waitForFrame(app.setup, (frame) => frame.includes(MODEL_MARK), "the prompt")
      await leader(app.setup, "d")
      await waitFor(() => app.commands().length > 0)

      const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes(HINT[language]), "the hint")
      expect(footerRow(frame)).toContain(t("error.child_session_read_only"))
      // One key, one request, and nothing else written.
      expect(app.writes()).toEqual([
        {
          method: "POST",
          path: `/session/${mainID}/command`,
          body: {
            hookMode: "interactive",
            command: "dag-mode",
            arguments: "off",
            agent: "build",
            model: "test/test-model",
          },
        },
      ])

      // The keys still work: the drawer opens and closes, and the leader key still reaches its command.
      const drawerLine = t("dagmode.drawer.on", { key: "" }).trim()
      expect(frame).not.toContain(drawerLine)
      app.setup.mockInput.pressKey("b", { ctrl: true })
      await waitForFrame(app.setup, (value) => value.includes(drawerLine), "the open drawer")
      app.setup.mockInput.pressKey("b", { ctrl: true })
      await waitForFrame(app.setup, (value) => !value.includes(drawerLine), "the closed drawer")
      await leader(app.setup, "d")
      await waitFor(() => app.commands().length > 1)
      expect(app.commands()).toHaveLength(2)
      expect(app.setup.renderer.isDestroyed).toBe(false)
    } finally {
      await app.stop()
    }
  })
}

// The hint is longer than the footer's share of an 80-column terminal, so the footer cuts it (and keeps the whole text
// in the log). It stays one line: the cut-off tail is nowhere else on the screen.
const LEAD = { "zh-CN": "这是子 agent 的会话，只读", en: "This is a sub-agent session" } as const
const TAIL = { "zh-CN": "告诉主 agent", en: "tell the main agent" } as const

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`${language}: at 80 columns the hint is cut to the footer and does not wrap, at ambiguous_width ${ambiguousWidth}`, async () => {
      const app = await runApp({
        sessions: [sessionFixture(mainID, { dagMode: "on" })],
        args: { continue: true },
        width: 80,
        height: 24,
        ambiguousWidth,
        handler: refusing(language, ["command"], refusal),
      })
      try {
        await waitForFrame(app.setup, (frame) => frame.includes(MODEL_MARK), "the prompt")
        await leader(app.setup, "d")
        const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes(LEAD[language]), "the hint")
        const footer = footerRow(frame)
        expect(cellWidth(footer, ambiguousWidth)).toBeLessThanOrEqual(80)
        expect(footer.endsWith("…")).toBe(true)
        expect(frame).not.toContain(TAIL[language])
      } finally {
        await app.stop()
      }
    })
  }
}

// `<leader>d` has a failure toast of its own, so three of them leave two toasts and the footer shows them one after
// the other. A write nobody reports on shows the hint alone: `<leader>c` (compact) sends its request and drops the
// result. The footer holds one toast at a time and queues the rest, so a repeat that was not merged would be on screen
// the moment the first one has run its course (4 seconds).
test("three refused writes in a row are one toast: when it has run its course, the footer does not show it again", async () => {
  const app = await runApp({
    sessions: [sessionFixture(mainID)],
    args: { continue: true },
    width: 140,
    height: 30,
    handler: refusing("zh-CN", ["summarize"], refusal),
  })
  const summarize = () => app.writes().filter((write) => write.path === `/session/${mainID}/summarize`)
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(MODEL_MARK), "the prompt")
    for (const sent of [1, 2, 3]) {
      await leader(app.setup, "c")
      await waitFor(() => summarize().length === sent)
    }
    await waitForFrame(app.setup, (frame) => footerRow(frame).includes(HINT["zh-CN"]), "the hint")
    expect(app.writes()).toHaveLength(3)

    await waitForFrame(
      app.setup,
      (frame) => !footerRow(frame).includes(HINT["zh-CN"]),
      "the hint to run its course",
      9000,
    )
    for (let round = 0; round < 6; round++) {
      await Bun.sleep(50)
      await app.setup.renderOnce()
      expect(footerRow(await captureFrame(app.setup))).not.toContain(HINT["zh-CN"])
    }
  } finally {
    await app.stop()
  }
})

test("another 409 is not the hint: the footer says what the caller says and nothing of the sub-agent", async () => {
  const busy = { name: "SessionBusyError", message: "Session is busy" }
  const app = await runApp({
    sessions: [sessionFixture(mainID, { dagMode: "on" })],
    args: { continue: true },
    width: 140,
    height: 30,
    handler: refusing("en", ["command"], busy),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(MODEL_MARK), "the prompt")
    await leader(app.setup, "d")
    await waitFor(() => app.commands().length > 0)
    // The toasts come in the order they are raised, so a hint raised by this refusal would be the first on the footer.
    const frame = await waitForFrame(
      app.setup,
      (value) => footerRow(value).includes("Session is busy"),
      "the caller's toast",
    )
    expect(frame).not.toContain(HINT.en)
    expect(frame).not.toContain("sub-agent session")
  } finally {
    await app.stop()
  }
})
