// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** The `todowrite` scenarios: recording a list, and replacing it after a call with a status the tool does not have. */

import { ranTool, todosAre } from "../judge"
import type { Scenario } from "../types"
import { call, say } from "./kit"

const TESTS = "write tests"
const DOCS = "update docs"
const RELEASE = "tag release"
const ANNOUNCE = "announce"

/** One item of the list; `priority` is part of the tool's input and not of what the scenarios judge. */
const item = (content: string, status: string) => ({ content, status, priority: "medium" })

const THREE_PENDING = [item(TESTS, "pending"), item(DOCS, "pending"), item(RELEASE, "pending")]

export const TODO_SCENARIOS: readonly Scenario[] = [
  {
    id: "todowrite.call",
    files: {},
    prompt: `Use the todowrite tool to record exactly these 3 todos, all with status pending: "${TESTS}", "${DOCS}", "${RELEASE}".`,
    scripts: {
      default: {
        replies: [call("todowrite", { todos: THREE_PENDING }), say("Recorded 3 todos.")],
        contract: [{ tool: "todowrite", includes: ["Todo list replaced:"] }],
      },
    },
    judge: (run) => [
      ...ranTool(run, "todowrite"),
      ...todosAre(run, { [TESTS]: "pending", [DOCS]: "pending", [RELEASE]: "pending" }),
    ],
  },
  {
    id: "todowrite.update",
    files: {},
    prompt: `Use the todowrite tool twice. First record 3 pending todos: "${TESTS}", "${DOCS}", "${RELEASE}". Then record the full list again with "${DOCS}" completed and a new pending todo "${ANNOUNCE}".`,
    scripts: {
      default: {
        replies: [
          call("todowrite", { todos: THREE_PENDING }),
          // `done` is not a status: the list stays as it was, and the error names the ones there are.
          call("todowrite", { todos: [item(TESTS, "pending"), item(DOCS, "done"), item(RELEASE, "pending")] }),
          call("todowrite", {
            todos: [
              item(TESTS, "pending"),
              item(DOCS, "completed"),
              item(RELEASE, "pending"),
              item(ANNOUNCE, "pending"),
            ],
          }),
          say("Updated the todo list."),
        ],
        trap: { call: 1, includes: ["The todowrite tool was called with invalid arguments: ", '"in_progress"'] },
        contract: [{ tool: "todowrite", includes: ["Todo list replaced: 3 before, 4 now."] }],
      },
    },
    judge: (run) => {
      const written = run.calls.filter((entry) => entry.tool === "todowrite" && entry.status === "completed").length
      return [
        ...ranTool(run, "todowrite"),
        ...(written >= 2 ? [] : [`calls: ${written} completed todowrite call, expected at least 2`]),
        ...todosAre(run, { [TESTS]: "pending", [DOCS]: "completed", [RELEASE]: "pending", [ANNOUNCE]: "pending" }),
      ]
    },
  },
]
