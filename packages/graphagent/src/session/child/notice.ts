// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionID } from "../schema"
import type { ChildRunOutcome, ChildRunReport } from "./types"

/**
 * How a task run is written down for a model (Issue #1026, PR3a): the tool
 * result of the `task` tool and the notice a background run's ending leaves in
 * its parent session share this one shape. The text is model-visible and
 * stays English.
 */

export type TaskState = "running" | "completed" | "error" | "cancelled"

export function renderTask(input: { sessionID: SessionID; state: TaskState; summary?: string; text: string }) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

/**
 * The notice for a detached task run that ended: the result it produced, the
 * failure it ended in, or, for a run its process lost, the fact that it left no
 * result. A cancelled run is never delivered; it is described here only so a
 * caller that asks gets a truthful line instead of a throw.
 */
export function resultNotice(input: {
  readonly childSessionID: SessionID
  readonly outcome: ChildRunOutcome
  readonly report?: ChildRunReport
}): string {
  const { childSessionID, outcome, report } = input
  const title = report?.title ?? "background task"
  switch (outcome.type) {
    case "completed":
      return renderTask({
        sessionID: childSessionID,
        state: "completed",
        summary: `Background task completed: ${title}`,
        text: report?.text ?? "",
      })
    case "error":
      return renderTask({
        sessionID: childSessionID,
        state: "error",
        summary: `Background task failed: ${title}`,
        text: report?.text ?? outcome.message,
      })
    case "interrupted":
      return renderTask({
        sessionID: childSessionID,
        state: "error",
        summary: `Background task interrupted: ${title}`,
        text: `The background task was interrupted before it finished, so it left no result. If its work is still needed, continue it with task_id="${childSessionID}".`,
      })
    default:
      return renderTask({
        sessionID: childSessionID,
        state: "cancelled",
        summary: `Background task cancelled: ${title}`,
        text: "The background task was cancelled. No result was delivered for it.",
      })
  }
}

export * as ChildNotice from "./notice"
