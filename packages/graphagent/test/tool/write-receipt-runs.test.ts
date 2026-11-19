// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, mock, test } from "bun:test"
import * as real from "diff"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import type { Diagnostic } from "@/lsp/client"
import { LSP } from "@/lsp/lsp"
import { FileState } from "@/session/file-state"
import { Truncate } from "@/tool/truncate"
import { WriteReceipt } from "@/tool/write-receipt"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { SessionID, MessageID } from "../../src/session/schema"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// #1451: a rewrite in which every line changes costs seconds to diff, so the receipt of a write must not run the diff
// again. Every diff the `diff` package runs goes through `diffLines` (`structuredPatch` and `createTwoFilesPatch`
// call it), so the runs are the calls of that one function. The real function is taken before the module is
// replaced: the replacement rewrites the exports of the package in place.
const original = { diffLines: real.diffLines }
const counted = { runs: 0 }
void mock.module("diff", () => ({
  ...real,
  diffLines: (...args: Parameters<typeof original.diffLines>) => {
    counted.runs += 1
    return original.diffLines(...args)
  },
}))

/** The diff runs of `work`. */
const diffRuns = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = counted.runs
    const result = yield* work
    return { result, runs: counted.runs - before }
  })

const ctx = {
  sessionID: SessionID.make("ses_test-receipt-runs"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  reported = {}
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    EventV2Bridge.defaultLayer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
  ),
)

// A language server that has checked every file and reports `reported`.
let reported: Record<string, Diagnostic[]> = {}
const itChecked = testEffect(
  Layer.mergeAll(
    Layer.mock(LSP.Service, {
      touchFile: () => Effect.succeed<LSP.Diagnostic.CheckStatus>("checked"),
      diagnostics: () => Effect.succeed(reported),
    }),
    FSUtil.defaultLayer,
    EventV2Bridge.defaultLayer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
  ),
)
/** An error on the 1-based `line`. */
const errorAt = (line: number): Diagnostic => ({
  severity: 1,
  message: "boom",
  range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
})

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)
const text = (items: string[]) => items.join("\n") + "\n"

// A formatter that runs and adds a line to what was written.
const expand = {
  formatter: {
    expand: {
      extensions: [".ts"],
      command: [
        "node",
        "-e",
        "const fs = require('fs'); const file = process.argv[1]; const text = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, text + '// formatted line\\n', 'utf8')",
        "$FILE",
      ],
    },
  },
}

// The same formatter for the `.txt` file of a patch.
const expandTxt = { formatter: { expand: { ...expand.formatter.expand, extensions: [".txt"] } } }

const markRead = Effect.fn("ReceiptRunsTest.markRead")(function* (filepath: string) {
  yield* (yield* FileState.Service).record(ctx.sessionID, filepath, "read")
})
const put = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))

const write = Effect.fn("ReceiptRunsTest.write")(function* (filePath: string, content: string) {
  const tool = yield* (yield* WriteTool).init()
  return yield* tool.execute({ filePath, content }, ctx)
})
const edit = Effect.fn("ReceiptRunsTest.edit")(function* (filePath: string, oldString: string, newString: string) {
  const tool = yield* (yield* EditTool).init()
  return yield* tool.execute({ filePath, oldString, newString }, ctx)
})
const patch = Effect.fn("ReceiptRunsTest.patch")(function* (patchText: string) {
  const tool = yield* (yield* ApplyPatchTool).init()
  return yield* tool.execute({ patchText }, ctx)
})
const replaceLine11 = [
  "*** Begin Patch",
  "*** Update File: existing.txt",
  "@@",
  "-line 11",
  "+changed",
  "*** End Patch",
].join("\n")

describe("the diff runs of a receipt (#1451)", () => {
  const oldText = text(lines(30))
  const newText = text(lines(30).map((item, i) => (i === 10 ? "changed" : item)))

  test("the counting sees the diff of the receipt module", () => {
    const before = counted.runs

    WriteReceipt.unifiedDiff("/project/a.ts", oldText, newText)

    expect(counted.runs - before).toBe(1)
  })

  test("a receipt made from the diff of the tool runs none", () => {
    const { changes } = WriteReceipt.unifiedDiff("/project/a.ts", oldText, newText)
    const before = counted.runs

    const receipt = WriteReceipt.writeReceipt({
      file: "/project/a.ts",
      oldText,
      newText,
      reformatted: false,
      replacements: 1,
      changes,
    })

    expect(receipt.text).toContain("Lines 11-11 changed.")
    expect(counted.runs - before).toBe(0)
  })

  test("a receipt without it runs one, for the counts, the landing lines and the diff together", () => {
    const before = counted.runs

    const receipt = WriteReceipt.writeReceipt({ file: "/project/a.ts", oldText, newText, reformatted: true })

    expect(receipt.text).toContain("Lines 11-11 changed.")
    expect(counted.runs - before).toBe(1)
  })

  test("a new file is counted without running one", () => {
    const before = counted.runs

    WriteReceipt.writeReceipt({ file: "/project/a.ts", oldText: "", newText, reformatted: false })

    expect(counted.runs - before).toBe(0)
  })

  // #1572: the lines the language-server check places its errors by.
  test("the lines of the check read from the diff of the tool run none, however often they are asked for", () => {
    const { changes } = WriteReceipt.unifiedDiff("/project/a.ts", oldText, newText)
    const before = counted.runs

    const ranges = WriteReceipt.lazyRanges("/project/a.ts", oldText, newText, changes)

    expect(ranges()).toEqual([{ start: 11, end: 11 }])
    expect(ranges()).toEqual([{ start: 11, end: 11 }])
    expect(counted.runs - before).toBe(0)
  })

  test("the lines of the check run one diff when the tool has none, once however often they are asked for", () => {
    const ranges = WriteReceipt.lazyRanges("/project/a.ts", oldText, newText)
    const before = counted.runs

    // Nothing runs until the lines are asked for.
    expect(counted.runs - before).toBe(0)
    expect(ranges()).toEqual([{ start: 11, end: 11 }])
    expect(ranges()).toEqual([{ start: 11, end: 11 }])
    expect(counted.runs - before).toBe(1)
  })

  test("the lines of a CRLF text run one diff of their own, since the diff of the tool does not compare the same lines", () => {
    const crlf = (value: string) => value.replaceAll("\n", "\r\n")
    const { changes } = WriteReceipt.unifiedDiff("/project/a.ts", crlf(oldText), crlf(newText))
    const before = counted.runs

    const ranges = WriteReceipt.lazyRanges("/project/a.ts", crlf(oldText), crlf(newText), changes)

    expect(ranges()).toEqual([{ start: 11, end: 11 }])
    expect(ranges()).toEqual([{ start: 11, end: 11 }])
    expect(counted.runs - before).toBe(1)
  })

  // The permission request needs one run. Everything the receipt says comes from it, and so do the lines the language
  // server may speak of (#1572), which are looked for only in a file that has an error.
  describe("the write tools", () => {
    it.instance("write: one for the request, none for the receipt or the language server", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)
        yield* markRead(target)

        const { result, runs } = yield* diffRuns(write(target, newText))

        expect(result.output).toContain("Lines 11-11 changed. Additions: 1. Deletions: 1.")
        expect(runs).toBeLessThanOrEqual(1)
      }),
    )

    it.instance("edit: one for the request, one for the counts of the result, none for the language server", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)

        const { result, runs } = yield* diffRuns(edit(target, "line 11", "changed"))

        expect(result.output).toContain("Lines 11-11 changed. Replacements: 1. Additions: 1. Deletions: 1.")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    it.instance(
      "edit: a formatter that rewrote the file costs one more, the diff of the file as it is now, which the receipt uses",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const target = path.join(test.directory, "existing.ts")
          yield* put(target, oldText)

          const { result, runs } = yield* diffRuns(edit(target, "line 11", "changed"))

          expect(result.output).toContain("File was reformatted by the formatter after this write.")
          expect(result.output).toContain("+// formatted line")
          expect(runs).toBeLessThanOrEqual(3)
        }),
      { config: expand },
    )

    it.instance("edit: a new file costs one for the request and one for the counts of the result", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "fresh.txt")

        const { runs } = yield* diffRuns(edit(target, "", newText))

        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    it.instance("apply_patch: one for the request, one for the counts of the file, none for the language server", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)

        const { result, runs } = yield* diffRuns(
          patch(
            ["*** Begin Patch", "*** Update File: existing.txt", "@@", "-line 11", "+changed", "*** End Patch"].join(
              "\n",
            ),
          ),
        )

        expect(result.output).toContain("Lines 11-11 changed. Additions: 1. Deletions: 1.")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    it.instance(
      "write: a formatter that rewrote the file costs one more, run once for the counts, the lines and the diff",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const target = path.join(test.directory, "existing.ts")
          yield* put(target, oldText)
          yield* markRead(target)

          const { result, runs } = yield* diffRuns(write(target, newText))

          expect(result.output).toContain("File was reformatted by the formatter after this write.")
          expect(result.output).toContain("+// formatted line")
          expect(runs).toBeLessThanOrEqual(2)
        }),
      { config: expand },
    )

    it.instance(
      "apply_patch: a formatter that rewrote the file costs one more, run once for the counts, the lines and the diff",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const target = path.join(test.directory, "existing.txt")
          yield* put(target, oldText)

          const { result, runs } = yield* diffRuns(patch(replaceLine11))

          expect(result.output).toContain("File was reformatted by the formatter after this write.")
          expect(result.output).toContain("+// formatted line")
          expect(runs).toBeLessThanOrEqual(3)
        }),
      { config: expandTxt },
    )
  })

  // #1572: a file the language server has checked and found an error in needs the lines of the write to place it. They
  // come from the diff of the request, for the status line and the report together, so the runs are the ones above.
  describe("the write tools, with an error in the file the language server checked", () => {
    const place = (target: string, ...line: number[]) => {
      reported = { [FSUtil.normalizePath(target)]: line.map(errorAt) }
    }

    itChecked.instance("write: costs no more, and places the error", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)
        yield* markRead(target)
        place(target, 11, 25)

        const { result, runs } = yield* diffRuns(write(target, newText))

        // The error on line 11 is the write's; the one on line 25 is not.
        expect(result.output).toContain("\n\nchecked: 1 error\n\nLSP errors detected in this file, please fix:\n")
        expect(result.output).toContain("ERROR [11:1] boom")
        expect(result.output).not.toContain("ERROR [25:1]")
        expect(runs).toBeLessThanOrEqual(1)
      }),
    )

    itChecked.instance("write: a new file costs no more either", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "fresh.txt")
        place(target, 3)

        const { result, runs } = yield* diffRuns(write(target, newText))

        expect(result.output).toContain("\n\nchecked: 1 error\n\n")
        expect(runs).toBeLessThanOrEqual(1)
      }),
    )

    itChecked.instance("edit: costs no more, and places the error", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)
        place(target, 11, 25)

        const { result, runs } = yield* diffRuns(edit(target, "line 11", "changed"))

        expect(result.output).toContain("\n\nchecked: 1 error\n\nLSP errors detected in this file, please fix:\n")
        expect(result.output).not.toContain("ERROR [25:1]")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    itChecked.instance("edit: a new file costs no more", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "fresh.txt")
        place(target, 3)

        const { result, runs } = yield* diffRuns(edit(target, "", newText))

        expect(result.output).toContain("\n\nchecked: 1 error\n\n")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    itChecked.instance(
      "edit: a formatter that rewrote the file costs no more than it does without an error",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const target = path.join(test.directory, "existing.ts")
          yield* put(target, oldText)
          place(target, 11)

          const { result, runs } = yield* diffRuns(edit(target, "line 11", "changed"))

          expect(result.output).toContain("\n\nchecked: 1 error\n\n")
          expect(runs).toBeLessThanOrEqual(3)
        }),
      { config: expand },
    )

    itChecked.instance("apply_patch: costs no more, and places the error", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)
        place(target, 11, 25)

        const { result, runs } = yield* diffRuns(patch(replaceLine11))

        expect(result.output).toContain("existing.txt: checked: 1 error")
        expect(result.output).toMatch(/LSP errors detected in .*existing\.txt, please fix:/)
        expect(result.output).not.toContain("ERROR [25:1]")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    itChecked.instance("apply_patch: an Add File over a file costs no more, and places the error", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)
        yield* markRead(target)
        place(target, 11, 25)

        const { result, runs } = yield* diffRuns(
          patch(
            [
              "*** Begin Patch",
              "*** Add File: existing.txt",
              ...newText
                .trimEnd()
                .split("\n")
                .map((line) => `+${line}`),
              "*** End Patch",
            ].join("\n"),
          ),
        )

        expect(result.output).toContain("Lines 11-11 changed. Additions: 1. Deletions: 1.")
        expect(result.output).toContain("existing.txt: checked: 1 error")
        expect(result.output).not.toContain("ERROR [25:1]")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    itChecked.instance("apply_patch: a Move onto a file costs the diff of what it replaces, and no more", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "from.txt")
        const target = path.join(test.directory, "to.txt")
        yield* put(source, oldText)
        yield* put(target, text(lines(30, "other")))
        yield* markRead(target)
        place(target, 11, 25)

        const { result, runs } = yield* diffRuns(
          patch(
            [
              "*** Begin Patch",
              "*** Update File: from.txt",
              "*** Move to: to.txt",
              "@@",
              "-line 11",
              "+changed",
              "*** End Patch",
            ].join("\n"),
          ),
        )

        // The receipt compares with the file that was replaced; the lines of the language server are the move's, from
        // the source, so only the error on line 11 is the write's.
        expect(result.output).toContain("Deletions: 30.")
        expect(result.output).toContain("to.txt: checked: 1 error")
        expect(result.output).not.toContain("ERROR [25:1]")
        expect(runs).toBeLessThanOrEqual(3)
      }),
    )
  })
})
