// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { setLanguage, t } from "../src/i18n"
import { dagIndicatorReserve } from "../src/shell/dag-indicator"
import { LEFT_RESERVE } from "../src/shell/footer-status"
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
  "zh-CN": "子 agent 会话只读：请回主会话让主 agent 调整",
  en: "Sub-agent is read-only; ask the main agent",
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

// The footer holds back `LEFT_RESERVE` columns and the DAG indicator's for the agent cluster; the toast gets the rest:
// at 80 columns 46 cells with the mode on or off (45 at ambiguous_width 2, where the indicator's marker is two cells
// wide), 44 (43) while the indicator reads `◆ DAG !`. The hint is written to fit the first, so the footer does not cut
// it at its edge and lose the half that says what to do.
for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`${language}: at 80 columns the whole hint fits the footer, at ambiguous_width ${ambiguousWidth}`, async () => {
      const share = 80 - LEFT_RESERVE - dagIndicatorReserve("on", 80, ambiguousWidth)
      expect(cellWidth(HINT[language], ambiguousWidth)).toBeLessThanOrEqual(share)

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
        const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes(HINT[language]), "the hint")
        const footer = footerRow(frame)
        expect(cellWidth(footer, ambiguousWidth)).toBeLessThanOrEqual(80)
        expect(footer).not.toContain("…")
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
    expect(frame).not.toContain("Sub-agent")
  } finally {
    await app.stop()
  }
})
