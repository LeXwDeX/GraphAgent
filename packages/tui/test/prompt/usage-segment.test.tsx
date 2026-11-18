// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Message, Session } from "@graphagent/sdk"
import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../src/i18n"
import { Main } from "../../src/routes/session"
import { cellWidth } from "../../src/ui/width"
import { directory, json } from "../fixture/tui-sdk"
import { mountRoute, sessionFixture } from "../routes/dag-mode-harness"

// The prompt's usage segment (the line under the input: the context and the cost of the session on screen). A session
// that recorded tokens at no cost has no price, which is not the same as costing nothing: it reads as unknown (#1475).

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const ID = "ses_usage_segment"

type Tokens = Required<Session>["tokens"]

const used: Tokens = { input: 1000, output: 200, reasoning: 30, cache: { read: 400, write: 50 } }
const none: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** The latest answer of the session: the segment shows only once there is one with output. */
function assistant(): Message {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the fields the segment reads.
  return {
    id: "msg_usage_segment",
    sessionID: ID,
    role: "assistant",
    parentID: "msg_usage_segment_user",
    agent: "build",
    mode: "build",
    modelID: "unpriced",
    providerID: "test",
    path: { cwd: directory, root: directory },
    time: { created: 1, completed: 2 },
    cost: 0,
    tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } as Message
}

/** The provider of the latest answer with its `unpriced` model made of `model`: what the server reports of its window. */
const providersWith = (model: Record<string, unknown>) => ({
  providers: [
    {
      id: "test",
      name: "Test",
      source: "custom",
      env: [],
      options: {},
      models: { unpriced: { id: "unpriced", name: "Unpriced", ...model } },
    },
  ],
  default: {},
})

async function mountSegment(
  session: Partial<Session>,
  options: { language?: "zh-CN" | "en"; width?: number; model?: Record<string, unknown> } = {},
) {
  const language = options.language ?? "zh-CN"
  setLanguage(language)
  const harness = await mountRoute({
    route: { type: "session", sessionID: ID },
    view: () => <Main />,
    frame: true,
    language,
    width: options.width,
    sessions: [sessionFixture(ID, session)],
    handler: (url) => {
      if (url.pathname === `/session/${ID}/message`) return json([{ info: assistant(), parts: [] }])
      if (options.model && url.pathname === "/config/providers") return json(providersWith(options.model))
      return undefined
    },
  })
  try {
    // The context figure is the segment's first part: its tokens total 1.2K (1000 in, 200 out).
    await harness.waitForFrame((frame) => frame.includes("1.2K"), "the usage segment")
    return harness
  } catch (error) {
    await harness.dispose()
    throw error
  }
}

/** The line of the frame the segment is on. */
function segmentOf(frame: string) {
  return (
    frame
      .split("\n")
      .find((line) => line.includes("1.2K"))
      ?.trim() ?? ""
  )
}

describe("the prompt's usage segment", () => {
  test("says unknown, not nothing, for a session that used tokens at no cost", async () => {
    const harness = await mountSegment({ cost: 0, tokens: used })
    try {
      const segment = segmentOf(await harness.frame())
      expect(segment).toContain("1.2K · 未知")
      expect(segment).not.toContain("$")
      // The segment is the session's own: it reads what the session row holds and asks for nothing. A watch would have
      // asked as the prompt mounted, and the segment is on screen.
      expect(harness.usageReads.asked()).toEqual([])
      await harness.usageReads.answered()
      expect(harness.requested.filter((request) => request.endsWith("/usage"))).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English too", async () => {
    const harness = await mountSegment({ cost: 0, tokens: used }, { language: "en" })
    try {
      expect(segmentOf(await harness.frame())).toContain("1.2K · unknown")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps the fraction of a cent a low-priced model costs", async () => {
    const harness = await mountSegment({ cost: 0.0027, tokens: used })
    try {
      const segment = segmentOf(await harness.frame())
      expect(segment).toContain("1.2K · $0.0027")
      expect(segment).not.toContain("未知")
    } finally {
      await harness.dispose()
    }
  })

  test("shows a priced cost as before, with cents", async () => {
    const harness = await mountSegment({ cost: 1.5, tokens: used })
    try {
      const segment = segmentOf(await harness.frame())
      expect(segment).toContain("1.2K · $1.50")
      expect(segment).not.toContain("未知")
    } finally {
      await harness.dispose()
    }
  })

  test("shows no cost for a session with neither a cost nor tokens recorded", async () => {
    const harness = await mountSegment({ cost: 0, tokens: none })
    try {
      const segment = segmentOf(await harness.frame())
      expect(segment).not.toContain("未知")
      expect(segment).not.toContain("$")
      // Without the figures on the row at all the same holds.
      expect(segment).toBe("1.2K")
    } finally {
      await harness.dispose()
    }
  })

  test("shows no cost for a row that carries neither field", async () => {
    const harness = await mountSegment({})
    try {
      expect(segmentOf(await harness.frame())).toBe("1.2K")
    } finally {
      await harness.dispose()
    }
  })

  // The figures are 1,200 tokens (1,000 in, 200 out) of the model's window.
  for (const language of ["zh-CN", "en"] as const) {
    test(`marks the share with a ~ when the model declares no window and the default one is used, ${language}`, async () => {
      const harness = await mountSegment(
        { cost: 1.5, tokens: used },
        { language, model: { limit: { context: 0, output: 100 }, profile: { sources: {} } } },
      )
      try {
        expect(segmentOf(await harness.frame())).toContain("1.2K (~1%) · $1.50")
      } finally {
        await harness.dispose()
      }
    })
  }

  test("shows the share of a declared window as before, without a ~", async () => {
    const harness = await mountSegment(
      { cost: 1.5, tokens: used },
      {
        model: {
          limit: { context: 2_400, output: 100 },
          profile: { context: 2_400, sources: { context: "catalog" } },
        },
      },
    )
    try {
      const segment = segmentOf(await harness.frame())
      expect(segment).toContain("1.2K (50%) · $1.50")
      expect(segment).not.toContain("~")
    } finally {
      await harness.dispose()
    }
  })

  test("measures against the effective window the user set, without a ~", async () => {
    const harness = await mountSegment(
      { cost: 1.5, tokens: used },
      {
        model: {
          limit: { context: 4_800, output: 100 },
          profile: { context: 4_800, effectiveContext: 2_400, sources: { context: "catalog" } },
        },
      },
    )
    try {
      const segment = segmentOf(await harness.frame())
      expect(segment).toContain("1.2K (50%) · $1.50")
      expect(segment).not.toContain("~")
    } finally {
      await harness.dispose()
    }
  })

  for (const [language, word] of [
    ["zh-CN", "未知"],
    ["en", "unknown"],
  ] as const) {
    test(`fits the 80 columns with the word for a price nobody has, ${language}`, async () => {
      const harness = await mountSegment({ cost: 0, tokens: used }, { language, width: 80 })
      try {
        const frame = await harness.frame()
        expect(segmentOf(frame)).toContain(word)
        for (const row of frame.split("\n")) expect(cellWidth(row, 1)).toBeLessThanOrEqual(80)
      } finally {
        await harness.dispose()
      }
    })
  }
})
