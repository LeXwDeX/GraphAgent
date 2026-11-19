// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { resolveProfile } from "@graphagent/core/model-profile"
import { ProviderV2 } from "@graphagent/core/provider"
import type { Provider } from "@/provider/provider"
import { MessageID } from "../../src/session/schema"
import { SwitchProjection } from "../../src/session/switch-projection"
import * as Log from "../../src/util/log"

const REPLAYS = ["none", "field", "signed", "encrypted"] as const
const CARRIERS = ["plain", "mirror", "opaque", "unknown"] as const
const source = { id: MessageID.make("msg_old"), providerID: ProviderV2.ID.make("p"), modelID: ModelV2.ID.make("old") }
const target = (replay: SwitchProjection.Target["replay"], providerID = "p"): SwitchProjection.Target => ({
  providerID,
  replay,
})

const fixture = (profile?: Provider.Model["profile"]): Provider.Model => ({
  id: ModelV2.ID.make("new"),
  providerID: ProviderV2.ID.make("p"),
  api: { id: "new", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  name: "New",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  ...(profile ? { profile } : {}),
})

describe("SwitchProjection.targetOf", () => {
  test("takes the provider of the model and the replay of its profile", () => {
    for (const replay of REPLAYS) {
      const model = fixture(
        resolveProfile({ providerID: "p", apiID: "new", config: { profile: { reasoning_mode: { replay } } } }),
      )
      expect(SwitchProjection.targetOf(model)).toEqual({ providerID: "p", replay })
    }
  })

  test("a model without a profile does not replay: none is the default", () => {
    expect(SwitchProjection.targetOf(fixture())).toEqual({ providerID: "p", replay: "none" })
  })
})

describe("SwitchProjection.reasoningPart", () => {
  const project = (input: {
    replay: SwitchProjection.Target["replay"]
    carrierKind: (typeof CARRIERS)[number]
    sameProvider?: boolean
    differentModel?: boolean
    text?: string
  }) =>
    SwitchProjection.reasoningPart({
      target: target(input.replay, input.sameProvider === false ? "q" : "p"),
      source,
      differentModel: input.differentModel ?? true,
      carrierKind: input.carrierKind,
      text: input.text ?? "old thinking",
    })

  test("a model switch replays plain and mirror reasoning of the same provider as reasoning when replay is field", () => {
    for (const carrierKind of ["plain", "mirror"] as const) {
      expect(project({ replay: "field", carrierKind })).toEqual({ type: "reasoning", text: "old thinking" })
    }
  })

  test("a model switch drops everything else, cell by cell", () => {
    for (const replay of REPLAYS) {
      for (const carrierKind of CARRIERS) {
        for (const sameProvider of [true, false]) {
          for (const text of ["old thinking", "  \n\t", ""]) {
            const replayed =
              replay === "field" &&
              (carrierKind === "plain" || carrierKind === "mirror") &&
              sameProvider &&
              text.trim().length > 0
            const cell = { replay, carrierKind, sameProvider, text }
            expect({ ...cell, part: project(cell) }).toEqual({
              ...cell,
              part: replayed ? { type: "reasoning", text } : undefined,
            })
          }
        }
      }
    }
  })

  test("nothing becomes assistant text on a model switch", () => {
    for (const replay of REPLAYS) {
      for (const carrierKind of CARRIERS) {
        expect(project({ replay, carrierKind })?.type).not.toBe("text")
      }
    }
  })

  test("the same model keeps the one rewrite: reasoning of an invalidated carrier becomes text, whatever replay is", () => {
    for (const replay of REPLAYS) {
      for (const carrierKind of CARRIERS) {
        for (const sameProvider of [true, false]) {
          expect(project({ replay, carrierKind, sameProvider, differentModel: false })).toEqual({
            type: "text",
            text: "old thinking",
          })
          expect(project({ replay, carrierKind, sameProvider, differentModel: false, text: " \n" })).toBeUndefined()
          expect(project({ replay, carrierKind, sameProvider, differentModel: false, text: "" })).toBeUndefined()
        }
      }
    }
  })

  test("the text is passed on as it is, not trimmed", () => {
    expect(project({ replay: "field", carrierKind: "plain", text: "  padded\n" })).toEqual({
      type: "reasoning",
      text: "  padded\n",
    })
    expect(project({ replay: "none", carrierKind: "plain", differentModel: false, text: "  padded\n" })).toEqual({
      type: "text",
      text: "  padded\n",
    })
  })
})

describe("SwitchProjection.reasoningPart logging", () => {
  let restore: (() => void) | undefined
  const originalLevel = process.env.GRAPHAGENT_LOG_LEVEL

  afterEach(async () => {
    await Log.flush()
    restore?.()
    restore = undefined
    if (originalLevel === undefined) delete process.env.GRAPHAGENT_LOG_LEVEL
    else process.env.GRAPHAGENT_LOG_LEVEL = originalLevel
  })

  const capture = () => {
    process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
    const entries: Log.Entry[] = []
    restore = Log.setSink((entry) => entries.push(entry))
    return entries
  }
  const part = (
    replay: SwitchProjection.Target["replay"],
    carrierKind: (typeof CARRIERS)[number],
    differentModel = true,
  ) =>
    SwitchProjection.reasoningPart({
      target: target(replay),
      source,
      differentModel,
      carrierKind,
      text: "old thinking",
    })

  test("a dropped part leaves one debug entry that names the message, the models, replay and the carrier", async () => {
    const entries = capture()
    expect(part("none", "opaque")).toBeUndefined()
    await Log.flush()

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: "debug", service: "session.switch-projection" })
    expect(entries[0]?.message).toBe("reasoning dropped for model switch")
    expect(entries[0]?.meta).toContain("messageID=msg_old")
    expect(entries[0]?.meta).toContain("from=p/old")
    expect(entries[0]?.meta).toContain("replay=none")
    expect(entries[0]?.meta).toContain("carrier=opaque")
    // the text of the reasoning is not logged
    expect(entries[0]?.meta).not.toContain("old thinking")
  })

  test("every dropped part is logged, and none of the others", async () => {
    const entries = capture()
    for (const replay of REPLAYS) for (const carrierKind of CARRIERS) part(replay, carrierKind)
    await Log.flush()
    // 16 cells, two of them replayed (field with plain and with mirror)
    expect(entries).toHaveLength(14)
    expect(entries.every((entry) => entry.message === "reasoning dropped for model switch")).toBe(true)
  })

  test("a replayed part and the same model leave no entry", async () => {
    const entries = capture()
    expect(part("field", "plain")).toEqual({ type: "reasoning", text: "old thinking" })
    expect(part("field", "mirror")).toEqual({ type: "reasoning", text: "old thinking" })
    for (const replay of REPLAYS) {
      for (const carrierKind of CARRIERS) {
        part(replay, carrierKind, false)
      }
    }
    await Log.flush()
    expect(entries).toEqual([])
  })

  test("the entry is not written at the default level", async () => {
    const entries = capture()
    delete process.env.GRAPHAGENT_LOG_LEVEL
    expect(part("none", "opaque")).toBeUndefined()
    await Log.flush()
    expect(entries).toEqual([])
  })
})
