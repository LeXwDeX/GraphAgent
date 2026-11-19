// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** The `grep` scenarios: a plain call, recovery from a pattern that is not a regex, and asking for more matches. */

import { ranTool, replyHas, replyPathsAre } from "../judge"
import type { Scenario } from "../types"
import { call, lines, once, pad, say } from "./kit"

/** `parseConfig` is defined in `src/config.ts` and called once in each of `src/app.ts` and `src/cli.ts`. */
const PARSE_FILES = {
  "src/config.ts": `export function parseConfig(text: string): Record<string, unknown> {
  return JSON.parse(text)
}
`,
  "src/app.ts": `import { parseConfig } from "./config"

export const app = parseConfig("{}")
`,
  "src/cli.ts": `import { parseConfig } from "./config"

export const cli = parseConfig("{}")
`,
  "src/notes.ts": `// Release notes live in the wiki.
export const notes = ["build", "ship"]
`,
}

/**
 * 400 `FIXME` lines over 12 files: 33 in each of the first eight, 34 in each of the rest. Shown whole they take
 * about 14 KB, inside the 20000 bytes a result gets in the replay tier (the scripted model has a 100000-token window).
 */
const FIXMES = (() => {
  const files: Record<string, string> = {}
  let next = 1
  for (let file = 1; file <= 12; file++) {
    const count = file <= 8 ? 33 : 34
    const first = next
    files[`src/m${pad(file, 2)}.ts`] = lines(count, (n) => `// FIXME(${first + n - 1}): later`)
    next += count
  }
  return files
})()

export const GREP_SCENARIOS: readonly Scenario[] = [
  {
    id: "grep.call",
    files: PARSE_FILES,
    prompt:
      "Use the grep tool to find which files call parseConfig, not the file that defines it. Reply with one path per line and nothing else.",
    scripts: { default: once("grep", { pattern: "parseConfig\\(", path: "src" }, "src/app.ts\nsrc/cli.ts") },
    judge: (run) => [...ranTool(run, "grep"), ...replyPathsAre(run, ["src/app.ts", "src/cli.ts"])],
  },
  {
    id: "grep.recover",
    files: PARSE_FILES,
    prompt:
      "Use the grep tool to search for the text parseConfig( and list the files that contain it. Reply with one path per line and nothing else.",
    scripts: {
      default: {
        replies: [
          call("grep", { pattern: "parseConfig(", path: "src" }),
          call("grep", { pattern: "parseConfig\\(", path: "src" }),
          say("src/config.ts\nsrc/app.ts\nsrc/cli.ts"),
        ],
        // `parseConfig(` is not a valid regular expression: the failure is all this trap asks for.
        trap: { call: 0, includes: [] },
      },
    },
    judge: (run) => [...ranTool(run, "grep"), ...replyPathsAre(run, ["src/config.ts", "src/app.ts", "src/cli.ts"])],
  },
  {
    id: "grep.continue",
    files: FIXMES,
    prompt: "Use the grep tool to count how many files under src/ contain the text FIXME. Reply with the number only.",
    scripts: {
      default: {
        replies: [
          call("grep", { pattern: "FIXME", path: "src" }),
          call("grep", { pattern: "FIXME", path: "src", limit: 400 }),
          say("12"),
        ],
        contract: [{ tool: "grep", includes: ["m01.ts", "m12.ts"] }],
      },
    },
    judge: (run) => [...ranTool(run, "grep"), ...replyHas(run, /\b12\b/)],
  },
]
