// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** The `read` scenarios: a plain call, recovery from a wrong path, and continuing a line the tool cut. */

import { ranTool, replyHas } from "../judge"
import type { Scenario } from "../types"
import { call, filler, lines, once, pad, say } from "./kit"

/** 120 lines; line 47 is the constant the scenario asks for. */
const CONFIG = (() => {
  const text = lines(120, (n) => `export const SETTING_${pad(n, 3)} = "value-${n}"`).split("\n")
  text[46] = "export const TIMEOUT_MS = 4200"
  return text.join("\n")
})()

const FORMAT = `export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2)
}
`

/** One line of 30000 characters; ` SECRET_CODE=amber-7731 ` starts at character 25001, far past the default cap. */
const BLOB = (() => {
  const secret = " SECRET_CODE=amber-7731 "
  return filler(25_000) + secret + filler(30_000 - 25_000 - secret.length)
})()

export const READ_SCENARIOS: readonly Scenario[] = [
  {
    id: "read.call",
    files: { "src/config.ts": CONFIG },
    prompt: "Use the read tool to read src/config.ts and tell me the value of TIMEOUT_MS. Reply with the number only.",
    scripts: { default: once("read", { filePath: "src/config.ts" }, "4200") },
    judge: (run) => [...ranTool(run, "read"), ...replyHas(run, /\b4200\b/)],
  },
  {
    id: "read.recover",
    files: { "src/helpers/format.ts": FORMAT },
    prompt: "Use the read tool on src/helper/format.ts and tell me what formatPrice(250) returns.",
    scripts: {
      default: {
        replies: [
          call("read", { filePath: "src/helper/format.ts" }),
          call("glob", { pattern: "**/format.ts" }),
          call("read", { filePath: "src/helpers/format.ts" }),
          say("$2.50"),
        ],
        trap: { call: 0, includes: ["Check the path with glob."] },
      },
    },
    judge: (run) => [...ranTool(run, "read"), ...replyHas(run, "$2.50")],
  },
  {
    id: "read.continue",
    files: { "data/blob.txt": BLOB },
    prompt:
      "Use the read tool on data/blob.txt. It is one very long line that contains SECRET_CODE=<value>. What is the value?",
    scripts: {
      default: {
        replies: [
          call("read", { filePath: "data/blob.txt" }),
          call("read", { filePath: "data/blob.txt", offset: 1, limit: 1, charOffset: 25_001, maxLineLength: 2000 }),
          say("amber-7731"),
        ],
        contract: [{ tool: "read", includes: ["amber-7731"] }],
      },
    },
    judge: (run) => [...ranTool(run, "read"), ...replyHas(run, "amber-7731")],
  },
]
