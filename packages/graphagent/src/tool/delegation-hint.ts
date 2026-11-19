// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Injection } from "@graphagent/core/system-context/injection"
import { isRecord } from "@/util/record"
import { ShellID } from "./shell/id"
import { MAX_LINES } from "./truncate"

/**
 * The delegation line of a truncated result (#1454). When webfetch, websearch, bash or read cuts its output, the
 * result of a root session ends with one `runtime` block that holds a `task` call it can run as written: a subagent
 * reads the saved text and answers one question, so the rest of the text never takes the main context. The line is
 * for a result that has a full copy to read and that the model is not already paging by hand. This module only
 * says what the line is; the pipeline decides whether the session can make the call, and nothing here reads or
 * writes the result.
 */

/** Who reads the saved text, and where it is. */
export type Hint = { agent: "explore" | "researcher"; path: string }

/** The arguments that give a `read` a window of its own: a model that sets one is already paging. */
const READ_WINDOW = ["offset", "limit", "page", "charOffset"] as const

// The agent that reads what a tool cut: a researcher for the web (it has no shell), explore for the rest.
function agentOf(tool: string): Hint["agent"] | undefined {
  if (tool === "webfetch" || tool === "websearch") return "researcher"
  if (tool === ShellID.ToolID) return "explore"
  return undefined
}

// The saved copy of a truncated result: absent when it could not be written, and then there is nothing to read.
function savedPath(metadata: Record<string, unknown>) {
  const path = metadata.outputPath
  return typeof path === "string" && path !== "" ? path : undefined
}

// A file longer than the line cap, or one the byte budget cut, read without a window. The default page of an
// ordinary source file is not a reason to delegate, and a directory has no text to hand over. A page the byte
// budget cut counts lines only up to the cut (#1573), so a file of few, long lines (minified code, a log of long
// records) is told by `byBytes`, not by its line count.
function readHint(args: Readonly<Record<string, unknown>>, metadata: Record<string, unknown>): Hint | undefined {
  const display = metadata.display
  if (!isRecord(display) || display.type !== "file") return undefined
  if (typeof display.path !== "string" || display.path === "") return undefined
  const long = typeof display.totalLines === "number" && display.totalLines > MAX_LINES
  if (!long && display.byBytes !== true) return undefined
  if (READ_WINDOW.some((key) => args[key] !== undefined)) return undefined
  return { agent: "explore", path: display.path }
}

/**
 * Who should read the truncated result of this call, or `undefined` when the call gets no line: its result was not
 * truncated, it has no saved copy, it is a read with a window or of a directory or of a short file the byte budget did
 * not cut, or it is another tool. `args` are the arguments the tool ran with, `metadata` is its result's.
 */
export function hintOf(tool: string, args: Readonly<Record<string, unknown>>, metadata: unknown): Hint | undefined {
  if (!isRecord(metadata) || metadata.truncated !== true) return undefined
  if (tool === "read") return readHint(args, metadata)
  const agent = agentOf(tool)
  const path = savedPath(metadata)
  return agent === undefined || path === undefined ? undefined : { agent, path }
}

/**
 * The block the line is written in. `prompt` is a JSON string, so a path with a quote or a line break cannot end
 * the call early; it carries no return format, which the task tool adds for the agent it starts.
 */
export function block(hint: Hint): string {
  const prompt = JSON.stringify(`Read ${hint.path} and answer: <your question>.`)
  return Injection.wrap(
    "runtime",
    `Delegate: task subagent_type="${hint.agent}" description="Read the file" prompt=${prompt}`,
  )
}

export * as DelegationHint from "./delegation-hint"
