// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** The `glob` scenarios: a plain call, and asking again for the paths the default limit left out. */

import { ranTool, replyHas } from "../judge"
import type { Scenario } from "../types"
import { call, once, pad, say } from "./kit"

const STUB = "export {}\n"

/**
 * `data/item-001.json` to `data/item-150.json`: more than the 100 paths a glob shows by default. The scripted
 * model's 100000-token window gives a result 20000 bytes, so all 150 absolute paths fit while the workspace path
 * stays under about 130 characters; a longer temporary directory would cut the list by bytes, and the `contract`
 * of `glob.continue` would then fail for that reason.
 */
const ITEMS = Object.fromEntries(
  Array.from({ length: 150 }, (_, index) => [`data/item-${pad(index + 1, 3)}.json`, "{}\n"]),
)

export const GLOB_SCENARIOS: readonly Scenario[] = [
  {
    id: "glob.call",
    files: {
      "src/index.ts": STUB,
      "src/util.test.ts": STUB,
      "test/a.test.ts": STUB,
      "test/b.test.ts": STUB,
      "test/c.test.ts": STUB,
      "test/helper.ts": STUB,
    },
    prompt: "Use the glob tool to count the files whose names end in .test.ts. Reply with the number only.",
    scripts: { default: once("glob", { pattern: "**/*.test.ts" }, "4") },
    judge: (run) => [...ranTool(run, "glob"), ...replyHas(run, /\b4\b/)],
  },
  {
    id: "glob.continue",
    files: ITEMS,
    prompt: "Use the glob tool to count the .json files under data/. Reply with the number only.",
    scripts: {
      default: {
        replies: [
          call("glob", { pattern: "data/*.json" }),
          call("glob", { pattern: "data/*.json", limit: 150 }),
          say("150"),
        ],
        contract: [{ tool: "glob", includes: ["item-001.json", "item-150.json"] }],
      },
    },
    judge: (run) => [...ranTool(run, "glob"), ...replyHas(run, /\b150\b/)],
  },
]
