// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionID } from "../schema"
import type { ChildRunFacts, ChildRunOutcome, ChildRunReport } from "./types"

/**
 * How a task run is written down for a model (Issue #1026, PR3a): the tool
 * result of the `task` tool and the notice a background run's ending leaves in
 * its parent session share this one shape. The text is model-visible and
 * stays English.
 */

export type TaskState = "running" | "completed" | "error" | "cancelled"

/**
 * The facts block (#1453) goes after the summary and before the result, so what the engine measured is read ahead
 * of what the subagent wrote. A completed run the engine cut short reads as `incomplete`, with the reason; it is how
 * the result reads, not a state of the run.
 */
export function renderTask(input: {
  sessionID: SessionID
  state: TaskState
  summary?: string
  text: string
  facts?: ChildRunFacts
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const cut = input.state === "completed" ? input.facts?.incomplete : undefined
  return [
    cut === undefined
      ? `<task id="${input.sessionID}" state="${input.state}">`
      : `<task id="${input.sessionID}" state="incomplete" reason="${cut}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    ...(input.facts ? [input.facts.block] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

/**
 * The instruction above a result the user's own background command left
 * (#1057): the parent presents the findings instead of acting on them.
 */
export function userBackgroundNotice(command: string | undefined) {
  return [
    `The user ran ${command === undefined ? "a command" : `/${command}`} in the background and it has finished.`,
    "Present its findings to the user faithfully and concisely, grouped by severity.",
    "Do not edit files or act on the findings unless the user asks.",
  ].join(" ")
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
        facts: report?.facts,
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
        text: `The background task was interrupted before it finished, so it left no result. If its work is still needed, continue it with the task tool: action="resume", task_id="${childSessionID}", plus subagent_type, description and prompt.`,
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
