// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, mock, test } from "bun:test"
import * as real from "diff"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
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

  // The permission request needs one run and the report of the lines the language server may speak of one more
  // (`afterEdit`). Everything the receipt says comes from the run of the request.
  describe("the write tools", () => {
    it.instance("write: one for the request, one for the language server, none for the receipt", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)
        yield* markRead(target)

        const { result, runs } = yield* diffRuns(write(target, newText))

        expect(result.output).toContain("Lines 11-11 changed. Additions: 1. Deletions: 1.")
        expect(runs).toBeLessThanOrEqual(2)
      }),
    )

    it.instance("edit: one for the request, one for the counts of the result, one for the language server", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "existing.txt")
        yield* put(target, oldText)

        const { result, runs } = yield* diffRuns(edit(target, "line 11", "changed"))

        expect(result.output).toContain("Lines 11-11 changed. Replacements: 1. Additions: 1. Deletions: 1.")
        expect(runs).toBeLessThanOrEqual(3)
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
          expect(runs).toBeLessThanOrEqual(4)
        }),
      { config: expand },
    )

    it.instance("edit: a new file costs one for the request and one for the counts of the result", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "fresh.txt")

        const { runs } = yield* diffRuns(edit(target, "", newText))

        expect(runs).toBeLessThanOrEqual(3)
      }),
    )

    it.instance("apply_patch: one for the request, one for the counts of the file, one for the language server", () =>
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
        expect(runs).toBeLessThanOrEqual(3)
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
          expect(runs).toBeLessThanOrEqual(3)
        }),
      { config: expand },
    )
  })
})
