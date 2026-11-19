// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** The `bash` scenarios: a plain call, recovery from a failing script, and searching an output the tool saved. */

import { describeNeedle, ranTool, replyHas } from "../judge"
import type { Scenario } from "../types"
import { call, once, say } from "./kit"

const BUILD = `if [ ! -f config.toml ]; then
  echo "config.toml not found" >&2
  exit 1
fi
echo "build ok"
`

/** 6000 rows; the 3000th carries the needle. */
const GEN = `seq 1 6000 | awk '{ if ($1 == 3000) print "row " $1 " NEEDLE-4417"; else print "row " $1 }'\n`

export const BASH_SCENARIOS: readonly Scenario[] = [
  {
    id: "bash.call",
    files: { "scripts/hello.sh": `echo "build ok: 42 files"\n` },
    prompt: "Use the bash tool to run sh scripts/hello.sh and tell me its output.",
    scripts: { default: once("bash", { command: "sh scripts/hello.sh" }, "build ok: 42 files") },
    judge: (run) => [...ranTool(run, "bash"), ...replyHas(run, "build ok: 42 files")],
  },
  {
    id: "bash.recover",
    files: { "scripts/build.sh": BUILD },
    prompt:
      "Use the bash tool to run sh scripts/build.sh. If it fails, fix the cause and run it again until it succeeds. Tell me the final output.",
    scripts: {
      default: {
        replies: [
          call("bash", { command: "sh scripts/build.sh" }),
          call("bash", { command: "touch config.toml" }),
          call("bash", { command: "sh scripts/build.sh" }),
          say("build ok"),
        ],
      },
    },
    judge: (run) => {
      // The last completed run of the build script, so a later check such as `git status` does not count.
      const last = run.calls.findLast(
        (item) =>
          item.tool === "bash" &&
          item.status === "completed" &&
          typeof item.input.command === "string" &&
          item.input.command.includes("build.sh"),
      )
      return [
        ...ranTool(run, "bash"),
        ...("config.toml" in run.files ? [] : ["files: config.toml missing"]),
        ...(last?.text.includes("build ok")
          ? []
          : [`calls: last completed build.sh run lacks ${describeNeedle("build ok")}`]),
        ...replyHas(run, "build ok"),
      ]
    },
  },
  {
    id: "bash.continue",
    files: { "scripts/gen.sh": GEN },
    prompt:
      "Use the bash tool to run sh scripts/gen.sh. Exactly one line of its output contains NEEDLE. Tell me the full text of that line.",
    scripts: {
      default: {
        replies: [
          call("bash", { command: "sh scripts/gen.sh" }),
          call("grep", { pattern: "NEEDLE", path: "<saved>" }),
          say("row 3000 NEEDLE-4417"),
        ],
        contract: [{ tool: "grep", includes: ["NEEDLE-4417"] }],
      },
    },
    judge: (run) => [...ranTool(run, "bash"), ...replyHas(run, "row 3000 NEEDLE-4417")],
  },
]
