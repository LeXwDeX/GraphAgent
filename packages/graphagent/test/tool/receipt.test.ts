// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { Receipt } from "@/tool/receipt"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("Receipt notes", () => {
  test("excessKeyNote words the ignored keys", () => {
    expect(Receipt.excessKeyNote("bash", ["cwd", "env"])).toBe(
      "Note: bash does not take these arguments, so they were ignored: cwd, env. Send only the documented parameters.",
    )
  })

  test("repairedNote lists what the repair set and the keys it did not use, and leaves out an empty part", () => {
    const tail = "Send the documented parameters."
    const head = "Note: your arguments did not match the schema and were repaired before the call ran"
    expect(Receipt.repairedNote(["background", "limit"], ["cwd"])).toBe(
      `${head} (set: background, limit; not used as sent: cwd). ${tail}`,
    )
    expect(Receipt.repairedNote(["background"], [])).toBe(`${head} (set: background). ${tail}`)
    expect(Receipt.repairedNote([], ["action", "workflow_id"])).toBe(
      `${head} (not used as sent: action, workflow_id). ${tail}`,
    )
    expect(Receipt.repairedNote([], [])).toBe(`${head}. ${tail}`)
  })

  test("clampNote says what was asked for and what was used", () => {
    expect(Receipt.clampNote("limit", 5000, 1000)).toBe("Note: limit 5000 is above the maximum 1000; 1000 was used.")
  })

  test("nameCaseNote says which name was corrected to which", () => {
    expect(Receipt.nameCaseNote("Lookup", "lookup")).toBe(
      'Note: the tool name "Lookup" was corrected to "lookup". Use the exact tool name.',
    )
  })
})

describe("Receipt name lists", () => {
  const names = (count: number) => Array.from({ length: count }, (_, index) => `key${index}`)
  const listed = (note: string) =>
    note.slice(note.indexOf("ignored: ") + "ignored: ".length, note.lastIndexOf(". Send"))

  test("a list of five names is complete", () => {
    expect(listed(Receipt.excessKeyNote("t", names(5)))).toBe("key0, key1, key2, key3, key4")
  })

  test("a longer list shows five names and how many there are in total", () => {
    expect(listed(Receipt.excessKeyNote("t", names(7)))).toBe("key0, key1, key2, key3, key4, ... (7 in total)")
  })

  test("a name is cut to 40 code points, not 40 UTF-16 units", () => {
    const emoji = "\u{1F600}"
    expect(listed(Receipt.excessKeyNote("t", [emoji.repeat(50)]))).toBe(emoji.repeat(40))
    expect(listed(Receipt.excessKeyNote("t", ["a".repeat(41)]))).toBe("a".repeat(40))
    expect(listed(Receipt.excessKeyNote("t", ["a".repeat(40)]))).toBe("a".repeat(40))
  })

  test("control characters are shown as spaces so a name cannot start a line of its own", () => {
    const note = Receipt.excessKeyNote("t", ["a\nb\u0007c", "x\u2028y"])
    expect(listed(note)).toBe("a b c, x y")
    expect(note).not.toContain("\n")
  })
})

describe("Receipt.nameCase", () => {
  test("a name that is the same comes back as it was", () => {
    const metadata = { truncated: false }
    const result = Receipt.nameCase("ok", metadata, "lookup", "lookup")
    expect(result).toEqual({ text: "ok", metadata: { truncated: false }, corrected: false })
    expect(result.metadata).toBe(metadata)
  })

  test("a call that was not opened under a name is not a correction", () => {
    expect(Receipt.nameCase("ok", {}, undefined, "lookup")).toEqual({ text: "ok", metadata: {}, corrected: false })
  })

  test("a name that differs by more than case is not a correction", () => {
    expect(Receipt.nameCase("ok", {}, "Search", "lookup")).toEqual({ text: "ok", metadata: {}, corrected: false })
    // The registered name must be the lower-case form of what the model sent, not the other way round.
    expect(Receipt.nameCase("ok", {}, "lookup", "Lookup")).toEqual({ text: "ok", metadata: {}, corrected: false })
  })

  test("a name corrected in case ends the text with the sentence and records name_case", () => {
    const result = Receipt.nameCase("ok", { corrections: ["args_repaired"], truncated: false }, "Lookup", "lookup")
    expect(result.corrected).toBe(true)
    expect(result.text).toBe('ok\n\nNote: the tool name "Lookup" was corrected to "lookup". Use the exact tool name.')
    expect(result.metadata).toEqual({ corrections: ["args_repaired", "name_case"], truncated: false })
  })

  test("a result that is JSON stays text and only the metadata records the correction", () => {
    for (const text of ['{"valid":true}', '  \n{"valid":true}', "[1,2]"]) {
      const result = Receipt.nameCase(text, {}, "Workflow", "workflow")
      expect(result).toEqual({ text, metadata: { corrections: ["name_case"] }, corrected: true })
    }
  })
})

describe("Receipt.logCorrection", () => {
  it.effect("logs the tool and the kind and whatever detail it is given", () =>
    Effect.gen(function* () {
      yield* Receipt.logCorrection("read", "clamped")
      yield* Receipt.logCorrection("grep", "formatted", { "format.changed": true })
      const logged = JSON.stringify(yield* logLines)
      expect(logged).toContain("tool call corrected")
      expect(logged).toContain('"tool.name":"read"')
      expect(logged).toContain('"correction.kind":"clamped"')
      expect(logged).toContain('"correction.kind":"formatted"')
      expect(logged).toContain('"format.changed":true')
    }),
  )
})
