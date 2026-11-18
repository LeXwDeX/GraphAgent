// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { setLanguage } from "../src/i18n"
import { runApp, waitForFrame } from "./fixture/run-app"
import { assistantMessage, userMessage } from "./fixture/session-records"
import { json } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The top bar's context share in the real app against a fake server: a model that declares no window is measured
// against the default one, and the share says so with a `~` (the window is assumed, so the figure is an estimate).

const ID = "ses_context_window"

afterEach(() => {
  setLanguage("zh-CN")
})

/** The provider of the latest answer, its `test-model` made of `model`: what the server reports of the window. */
const providersWith = (model: Record<string, unknown>) => ({
  providers: [
    {
      id: "test",
      name: "Test",
      source: "config",
      env: [],
      options: {},
      models: { "test-model": { id: "test-model", name: "Test model", capabilities: { reasoning: false }, ...model } },
    },
  ],
  default: {},
})

/** The latest answer: 1,200 tokens in all, 1,000 in and 200 out. */
const answer = {
  ...assistantMessage("msg_context_assistant", ID, "msg_context_user", 2),
  tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
}

async function mount(language: "zh-CN" | "en", model: Record<string, unknown>) {
  setLanguage(language)
  return runApp({
    sessions: [sessionFixture(ID, { title: "context window" })],
    args: { continue: true },
    handler: (url) => {
      if (url.pathname === "/config") return json({ language })
      if (url.pathname === "/config/providers") return json(providersWith(model))
      if (url.pathname === `/session/${ID}/message`) {
        return json([
          { info: userMessage("msg_context_user", ID, 1), parts: [] },
          { info: answer, parts: [] },
        ])
      }
      return undefined
    },
  })
}

for (const [language, label] of [
  ["zh-CN", "上下文"],
  ["en", "context"],
] as const) {
  test(`the top bar marks a share measured against the default window with a ~, ${language}`, async () => {
    const app = await mount(language, { limit: { context: 0, output: 100 }, profile: { sources: {} } })
    try {
      // 1,200 of the default 128,000 tokens is 0.94%, shown as 1%.
      const frame = await waitForFrame(app.setup, (value) => value.includes(`${label} ~1%`), "the top bar")
      expect(frame).not.toContain(`${label} 1%`)
    } finally {
      await app.stop()
    }
  })
}

test("the top bar shows the share of a declared window as before, without a ~", async () => {
  const app = await mount("zh-CN", {
    limit: { context: 2_400, output: 100 },
    profile: { context: 2_400, sources: { context: "catalog" } },
  })
  try {
    const frame = await waitForFrame(app.setup, (value) => value.includes("上下文 50%"), "the top bar")
    expect(frame).not.toContain("上下文 ~")
  } finally {
    await app.stop()
  }
})

test("the top bar measures against the effective window the user set, without a ~", async () => {
  const app = await mount("zh-CN", {
    limit: { context: 4_800, output: 100 },
    profile: { context: 4_800, effectiveContext: 2_400, sources: { context: "catalog" } },
  })
  try {
    const frame = await waitForFrame(app.setup, (value) => value.includes("上下文 50%"), "the top bar")
    expect(frame).not.toContain("上下文 ~")
  } finally {
    await app.stop()
  }
})
