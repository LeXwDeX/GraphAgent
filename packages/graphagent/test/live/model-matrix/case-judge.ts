// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What decides a live replay of a case (Issue #1474): did the model make the step the recorded session made?
 * The model's first tool call is stopped before it runs (`case-hook.ts`), so what is judged is the decision, not
 * its effect:
 *
 * - the recorded step is a tool call: the first call the model made is a call of the same tool, and its
 *   arguments are valid for that tool;
 * - the recorded step is text: the model made no tool call and said something.
 *
 * The arguments are checked against the `Parameters` the tool module exports, strictly: the repair the tool
 * would try on a bad call (`repairArguments`) is not applied, because a model that needs it is the thing the
 * matrix is there to tell apart. A tool that is not in `PARAMETERS` is compared by name only.
 */

import { AgentParameters, AgentTool } from "@/tool/agent"
import { ApplyPatchTool, Parameters as ApplyPatch } from "@/tool/apply_patch"
import { EditTool, Parameters as Edit } from "@/tool/edit"
import { GlobTool, Parameters as Glob } from "@/tool/glob"
import { GrepTool, Parameters as Grep } from "@/tool/grep"
import { LspTool, Parameters as Lsp } from "@/tool/lsp"
import { PlanExitTool, Parameters as Plan } from "@/tool/plan"
import { QuestionTool, Parameters as Question } from "@/tool/question"
import { ReadTool, Parameters as Read } from "@/tool/read"
import { describeSchemaFailures } from "@/tool/schema-error"
import { ShellTool, Parameters as Shell } from "@/tool/shell"
import { SkillTool, Parameters as Skill } from "@/tool/skill"
import { TaskTool, Parameters as Task } from "@/tool/task"
import { TodoWriteTool, Parameters as Todo } from "@/tool/todo"
import { WebFetchTool, Parameters as WebFetch } from "@/tool/webfetch"
import { WebSearchTool, Parameters as WebSearch } from "@/tool/websearch"
import { WorkflowParameters, WorkflowTool } from "@/tool/workflow"
import { WriteTool, Parameters as Write } from "@/tool/write"
import { Schema } from "effect"
import type { CaseFile } from "./case-file"
import type { StoppedCall } from "./case-hook"
import type { Call } from "./types"

/**
 * The parameter schema of every tool a model can call that `test/tool/parameters.test.ts` covers, by the tool's
 * own id. `invalid` is left out: the engine uses it, a model does not call it.
 */
const PARAMETERS: ReadonlyMap<string, Schema.Decoder<unknown>> = new Map<string, Schema.Decoder<unknown>>([
  [AgentTool.id, AgentParameters],
  [ApplyPatchTool.id, ApplyPatch],
  [EditTool.id, Edit],
  [GlobTool.id, Glob],
  [GrepTool.id, Grep],
  [LspTool.id, Lsp],
  [PlanExitTool.id, Plan],
  [QuestionTool.id, Question],
  [ReadTool.id, Read],
  [ShellTool.id, Shell],
  [SkillTool.id, Skill],
  [TaskTool.id, Task],
  [TodoWriteTool.id, Todo],
  [WebFetchTool.id, WebFetch],
  [WebSearchTool.id, WebSearch],
  [WorkflowTool.id, WorkflowParameters],
  [WriteTool.id, Write],
])

/** The tools whose arguments a case replay checks. */
export const CHECKED_TOOLS: readonly string[] = [...PARAMETERS.keys()]

/**
 * Why `input` is not valid arguments of `tool`: the paths and kinds of what is wrong, never a value (the summary
 * the tool itself gives a model). `undefined` when they are valid, and for a tool that is not checked.
 */
export function argumentFailure(tool: string, input: unknown): string | undefined {
  const schema = PARAMETERS.get(tool)
  if (!schema) return undefined
  const decoded = Schema.decodeUnknownResult(schema)(input)
  if (decoded._tag === "Success") return undefined
  return describeSchemaFailures(decoded.failure) || "the arguments do not match the tool schema"
}

/** What a live replay of a case left to judge. */
export interface Observation {
  /** The first call the hook stopped, from the audit file. */
  readonly stopped?: StoppedCall
  /** The calls of the replayed step in the transcript, in order; they show a call that never reached the hook. */
  readonly calls: readonly Call[]
  /** The model's answer to the request: the last non-synthetic assistant text after it. */
  readonly reply: string
}

/** The criteria the model did not meet, in words; empty means it made the recorded step. */
export function caseFailures(file: CaseFile, seen: Observation): string[] {
  const first = seen.stopped ?? seen.calls[0]
  if ("text" in file.recorded) {
    // A model that called a tool had its turn stopped there, so it has no reply to judge.
    if (first) return [`calls: expected no tool call, the model called ${first.tool}`]
    return seen.reply.trim() === "" ? ["reply: empty"] : []
  }
  const [{ name }] = file.recorded.calls
  if (!first) return [`calls: no tool call, expected ${name}`]
  if (first.tool !== name) return [`calls: first call is ${first.tool}, expected ${name}`]
  const wrong = argumentFailure(name, first.input)
  return wrong === undefined ? [] : [`arguments: ${name} ${wrong}`]
}
