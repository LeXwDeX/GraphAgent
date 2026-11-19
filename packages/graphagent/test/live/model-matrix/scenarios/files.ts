// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The file-change scenarios: creating a file, editing one, an edit whose text is not unique, replacing a file that
 * was not read, one change that spans two files, and an instruction that names a function the file does not have.
 *
 * The edit tools depend on the model: a model of the default family has `edit` and `write`, one of the apply_patch
 * family has `apply_patch` alone (`usesApplyPatch`). So each scenario has a script for each family, and the judge
 * reads the files that are left, which are the same whichever tool wrote them.
 */

import { isDeepStrictEqual } from "node:util"
import { fileIs, fileLinesAre } from "../judge"
import type { RunView, Scenario } from "../types"
import { addFile, call, patch, receiptContract, say, updateFile } from "./kit"

const GREETING = 'export const greeting = "hello"'

const LIMITS_BEFORE = "export const MAX_RETRIES = 3"
const LIMITS_AFTER = "export const MAX_RETRIES = 5"
const LIMITS_REST = "export const TIMEOUT = 1000"

const UPLOAD = "export function upload() {"
const NET = `export function connect() {
  const retries = 3
  return retries
}

${UPLOAD}
  const retries = 3
  return retries
}
`

const CONFIG_BEFORE = '{"mode":"dev","retries":1}'
const CONFIG_AFTER = '{"mode":"prod","retries":3}'

const PRICE = `export function totalPrice(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0)
}
`

/** The tools that put text into a file. */
const WRITERS: readonly string[] = ["write", "edit", "apply_patch"]
/** The tools a model may look at a file with before it changes it. */
const LOOKERS: readonly string[] = ["read", "grep", "bash"]

/** `src/net.ts` after the change: `upload` has 5 retries, `connect` keeps 3, no other line moved. */
function netFailures(run: RunView): string[] {
  if (!Object.hasOwn(run.files, "src/net.ts")) return ["files: src/net.ts missing"]
  const text = run.files["src/net.ts"] ?? ""
  const at = text.indexOf(UPLOAD)
  if (at < 0) return [`files: src/net.ts lost ${JSON.stringify(UPLOAD)}`]
  // Only the number after `retries =` may differ from the fixture.
  const shape = (value: string) => value.replace(/const retries = \d+/g, "const retries = N").trimEnd()
  return [
    ...(text.slice(0, at).includes("const retries = 3") ? [] : ['files: connect no longer has "const retries = 3"']),
    ...(text.slice(at).includes("const retries = 5") ? [] : ['files: upload lacks "const retries = 5"']),
    ...(shape(text) === shape(NET) ? [] : ["files: src/net.ts changed outside its retries lines"]),
  ]
}

function configFailures(run: RunView): string[] {
  if (!Object.hasOwn(run.files, "config.json")) return ["files: config.json missing"]
  try {
    const value: unknown = JSON.parse(run.files["config.json"] ?? "")
    const expected = { mode: "prod", retries: 3 }
    return isDeepStrictEqual(value, expected)
      ? []
      : [`files: config.json holds ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`]
  } catch {
    return ["files: config.json is not valid JSON"]
  }
}

/**
 * `totalPrice` keeps its name and gains the clamp, and the file was looked at before the first write that
 * completed. A run with no such write (the shell changed the file) has nothing to be ahead of: any look counts.
 */
function priceFailures(run: RunView): string[] {
  const text = run.files["src/price.ts"] ?? ""
  const firstWrite = run.calls.findIndex((item) => item.status === "completed" && WRITERS.includes(item.tool))
  const before = firstWrite < 0 ? run.calls : run.calls.slice(0, firstWrite)
  const looked = before.some(
    (item) =>
      item.status === "completed" && LOOKERS.includes(item.tool) && JSON.stringify(item.input).includes("price.ts"),
  )
  return [
    ...(text.includes("Math.max(") ? [] : ['files: src/price.ts lacks "Math.max("']),
    ...(text.includes("totalPrice") ? [] : ['files: src/price.ts lost "totalPrice"']),
    ...(looked ? [] : ["calls: no read, grep or bash of price.ts before the first write"]),
  ]
}

export const FILE_SCENARIOS: readonly Scenario[] = [
  {
    id: "file.create",
    files: { "src/index.ts": "export {}\n" },
    prompt: `Create src/greet.ts containing exactly this one line: ${GREETING}`,
    scripts: {
      default: {
        replies: [call("write", { filePath: "src/greet.ts", content: `${GREETING}\n` }), say("Created src/greet.ts.")],
        contract: receiptContract("write"),
      },
      apply_patch: {
        replies: [
          call("apply_patch", { patchText: patch(addFile("src/greet.ts", GREETING)) }),
          say("Created src/greet.ts."),
        ],
        contract: receiptContract("apply_patch"),
      },
    },
    judge: (run) => fileIs(run, "src/greet.ts", GREETING),
  },
  {
    id: "file.edit",
    files: { "src/limits.ts": `${LIMITS_BEFORE}\n${LIMITS_REST}\n` },
    prompt: "In src/limits.ts change MAX_RETRIES from 3 to 5. Change nothing else.",
    scripts: {
      default: {
        replies: [
          call("edit", { filePath: "src/limits.ts", oldString: "MAX_RETRIES = 3", newString: "MAX_RETRIES = 5" }),
          say("MAX_RETRIES is now 5."),
        ],
        contract: receiptContract("edit"),
      },
      apply_patch: {
        replies: [
          call("apply_patch", {
            patchText: patch(updateFile("src/limits.ts", { drop: [LIMITS_BEFORE], add: [LIMITS_AFTER] })),
          }),
          say("MAX_RETRIES is now 5."),
        ],
        contract: receiptContract("apply_patch"),
      },
    },
    judge: (run) => fileLinesAre(run, "src/limits.ts", [LIMITS_AFTER, LIMITS_REST]),
  },
  {
    id: "file.edit.ambiguous",
    files: { "src/net.ts": NET },
    prompt: "In src/net.ts change retries from 3 to 5 inside upload only. Leave connect unchanged.",
    scripts: {
      default: {
        replies: [
          // Two functions have this line, so the edit cannot say which one is meant.
          call("edit", { filePath: "src/net.ts", oldString: "const retries = 3", newString: "const retries = 5" }),
          call("edit", {
            filePath: "src/net.ts",
            oldString: `${UPLOAD}\n  const retries = 3`,
            newString: `${UPLOAD}\n  const retries = 5`,
          }),
          say("Changed retries to 5 in upload."),
        ],
        trap: { call: 0, includes: [] },
        contract: receiptContract("edit"),
      },
      // A patch finds its place by the line after `@@`, so there is nothing to trap.
      apply_patch: {
        replies: [
          call("apply_patch", {
            patchText: patch(
              updateFile("src/net.ts", { at: UPLOAD, drop: ["  const retries = 3"], add: ["  const retries = 5"] }),
            ),
          }),
          say("Changed retries to 5 in upload."),
        ],
        contract: receiptContract("apply_patch"),
      },
    },
    judge: netFailures,
  },
  {
    id: "file.overwrite",
    files: { "config.json": `${CONFIG_BEFORE}\n` },
    prompt: `Replace the whole content of config.json with this single line: ${CONFIG_AFTER}`,
    scripts: {
      default: {
        replies: [
          // The file exists and this session has not read it.
          call("write", { filePath: "config.json", content: `${CONFIG_AFTER}\n` }),
          call("read", { filePath: "config.json" }),
          call("write", { filePath: "config.json", content: `${CONFIG_AFTER}\n` }),
          say("Replaced config.json."),
        ],
        trap: { call: 0, includes: ["was not read in this session"] },
        contract: receiptContract("write"),
      },
      apply_patch: {
        replies: [
          call("apply_patch", { patchText: patch(addFile("config.json", CONFIG_AFTER)) }),
          call("apply_patch", {
            patchText: patch(updateFile("config.json", { drop: [CONFIG_BEFORE], add: [CONFIG_AFTER] })),
          }),
          say("Replaced config.json."),
        ],
        trap: { call: 0, includes: ["was not read in this session"] },
        contract: receiptContract("apply_patch"),
      },
    },
    judge: configFailures,
  },
  {
    id: "file.patch.multi",
    files: { "src/a.ts": "export const A = 1\n" },
    prompt:
      "Make two changes: create src/b.ts with the single line export const B = 2, and change A in src/a.ts to 10.",
    scripts: {
      default: {
        replies: [
          call("write", { filePath: "src/b.ts", content: "export const B = 2\n" }),
          call("edit", { filePath: "src/a.ts", oldString: "export const A = 1", newString: "export const A = 10" }),
          say("Created src/b.ts and changed A to 10."),
        ],
        contract: receiptContract("write", "edit"),
      },
      apply_patch: {
        replies: [
          call("apply_patch", {
            patchText: patch(
              addFile("src/b.ts", "export const B = 2"),
              updateFile("src/a.ts", { drop: ["export const A = 1"], add: ["export const A = 10"] }),
            ),
          }),
          say("Created src/b.ts and changed A to 10."),
        ],
        contract: receiptContract("apply_patch"),
      },
    },
    judge: (run) => [
      ...fileIs(run, "src/b.ts", "export const B = 2"),
      ...fileIs(run, "src/a.ts", "export const A = 10"),
    ],
  },
  {
    id: "file.patch.stale",
    files: { "src/price.ts": PRICE },
    prompt:
      "In src/price.ts, make the function sumPrices ignore negative numbers by adding Math.max(n, 0) for each item.",
    scripts: {
      // The function is called `totalPrice`: only the file says so.
      default: {
        replies: [
          call("read", { filePath: "src/price.ts" }),
          call("edit", { filePath: "src/price.ts", oldString: "sum + n", newString: "sum + Math.max(n, 0)" }),
          say("totalPrice now ignores negative numbers."),
        ],
        contract: receiptContract("edit"),
      },
      apply_patch: {
        replies: [
          call("read", { filePath: "src/price.ts" }),
          call("apply_patch", {
            patchText: patch(
              updateFile("src/price.ts", {
                drop: ["  return items.reduce((sum, n) => sum + n, 0)"],
                add: ["  return items.reduce((sum, n) => sum + Math.max(n, 0), 0)"],
              }),
            ),
          }),
          say("totalPrice now ignores negative numbers."),
        ],
        contract: receiptContract("apply_patch"),
      },
    },
    judge: priceFailures,
  },
]
