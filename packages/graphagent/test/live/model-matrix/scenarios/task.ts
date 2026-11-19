// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The `task` scenarios: starting a subagent and using what it found, and reading the facts block (#1453) the tool
 * puts ahead of the subagent's own words.
 *
 * In the replay tier the subagent is scripted too. Its session starts from the `prompt` of the task call, so that
 * prompt ends with the case marker `[case <id>.child]` and the scenario's `child` script answers under that key.
 */

import { ranTool, replyHas } from "../judge"
import type { Reply, RunView, Scenario } from "../types"
import { call, say } from "./kit"

const NOTE = { "notes/secret.txt": "The launch code is ORCHID-5521.\n" }

/** The subagent reads the note and answers in the three sections an `explore` agent owes its caller. */
const CHILD: readonly Reply[] = [
  call("read", { filePath: "notes/secret.txt" }),
  say("Conclusion: The launch code is ORCHID-5521.\nEvidence: notes/secret.txt:1\nUnresolved: none"),
]

const taskCall = (id: string, prompt: string): Reply =>
  call("task", {
    description: "Read the secret note",
    subagent_type: "explore",
    prompt: `${prompt}\n[case ${id}.child]`,
  })

const exploreRan = (run: RunView): string[] =>
  run.calls.some(
    (entry) => entry.tool === "task" && entry.status === "completed" && entry.input.subagent_type === "explore",
  )
    ? []
    : ['calls: no completed task call with subagent_type "explore"']

/** The `tool_errors` the facts block of the task result states, which the reply must repeat. */
function factsFailures(run: RunView): string[] {
  const result = run.calls.findLast((entry) => entry.tool === "task" && entry.status === "completed")
  const errors = result?.text.match(/^tool_errors: (\d+)$/m)?.[1]
  return errors === undefined ? ["facts: no tool_errors line"] : replyHas(run, `tool_errors=${errors}`)
}

export const TASK_SCENARIOS: readonly Scenario[] = [
  {
    id: "task.call",
    files: NOTE,
    prompt:
      "Use the task tool to start an explore subagent that reads notes/secret.txt, then tell me the launch code it found.",
    child: CHILD,
    scripts: {
      default: {
        replies: [
          taskCall("task.call", "Read notes/secret.txt and report the launch code it contains."),
          say("The launch code is ORCHID-5521."),
        ],
      },
    },
    judge: (run) => [
      ...ranTool(run, "task"),
      ...exploreRan(run),
      ...(run.children >= 1 ? [] : [`children: ${run.children}, expected at least 1`]),
      ...replyHas(run, "ORCHID-5521"),
    ],
  },
  {
    id: "task.result",
    files: NOTE,
    prompt:
      "Use the task tool to start an explore subagent that reads notes/secret.txt. Then reply tool_errors=<n>, where n is the tool_errors value in the facts block the tool returned.",
    child: CHILD,
    scripts: {
      default: {
        replies: [taskCall("task.result", "Read notes/secret.txt and report what it says."), say("tool_errors=0")],
        contract: [{ tool: "task", includes: ["<task_facts>", "tool_errors: 0"] }],
      },
    },
    judge: (run) => [...ranTool(run, "task"), ...factsFailures(run)],
  },
]
