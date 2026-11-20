// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { setLanguage } from "../src/i18n"
import { footerRow, promptShown, runApp, waitForFrame } from "./fixture/run-app"
import { json } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

afterEach(() => setLanguage("zh-CN"))

const sessionID = "ses_trust_shape"

// #1659: a trust reply without an `entries` array (here a bare array, whose `entries` is a method) must leave the
// trust list empty rather than store whatever `entries` happens to be.
for (const [label, reply] of [
  ["a bare array", []],
  ["entries that is not an array", { entries: { state: "pending" } }],
  ["no body", null],
] as const) {
  test(`a trust reply with ${label} mounts the app with no pending commands`, async () => {
    const app = await runApp({
      sessions: [sessionFixture(sessionID)],
      args: { continue: true },
      width: 120,
      height: 30,
      handler: (url) => (url.pathname === "/project/trust" ? json(reply) : undefined),
    })
    try {
      const frame = await waitForFrame(app.setup, promptShown, "the prompt")
      expect(footerRow(frame)).not.toContain("未信任")
      expect(app.writes()).toEqual([])
    } finally {
      await app.stop()
    }
  })
}
