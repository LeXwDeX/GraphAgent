// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import stripAnsi from "strip-ansi"
import type { Part, ToolPart } from "@graphagent/sdk"
import type { PartPreview } from "../../context/stream-buffer"
import { reasoningSummary, type ThinkingMode } from "../../context/thinking"
import { t } from "../../i18n"
import type { BackgroundCard } from "../../session/background-card"
import { cellWidth, type AmbiguousWidth } from "../../ui/width"
import { outputOverflows } from "../../util/collapse-tool-output"
import { remoteLine } from "../../util/remote-text"
import {
  parseApplyPatchFiles,
  parseQuestionAnswers,
  parseTodos,
  stringValue,
  toolDisplay,
} from "../../util/tool-display"
import { resultPreviewRoom } from "./result-card"
import { DELEGATION_PROMPT_LINES, type ViewFlag } from "./rows"
import { toolAttention } from "./tool-attention"

/**
 * What can fold in a session transcript, and when. The blocks decide what they draw from these functions and
 * `view.expand.toggle` decides which block to open from the same ones, so the key and the click agree on what
 * folds. They read the part and a few view settings, never a mounted node: the key has to find the blocks of
 * a windowed transcript that are not on screen, and those are not mounted.
 */

/**
 * Lines of a tool output that a call row draws under its `⎿` before it folds into one result line (#1614). Every tool
 * with an output to draw folds at this count, and the hint under the row counts the lines the fold leaves out.
 */
export const TOOL_FOLD_LINES = 6

/** Characters a folded output shows: the lines it may take, each as wide as the content less its gutter. */
export function outputCharCap(lines: number, width: number) {
  return lines * Math.max(20, width - 6)
}

/**
 * The metadata a tool block draws from. A running call shows the tail of its output from the stream buffer, ahead
 * of the stored snapshot, which has not caught up with it yet (#886 5.3).
 */
export function toolMetadata(
  part: ToolPart,
  preview: (part: ToolPart) => PartPreview | undefined,
): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  const metadata = part.state.metadata ?? {}
  const shown = preview(part)
  return shown ? { ...metadata, output: shown.tail, previewTotalLength: shown.totalLength } : metadata
}

/** The stored output of a finished call: nothing while it runs, and nothing once it failed. */
export function completedOutput(state: ToolPart["state"]) {
  return state.status === "completed" ? state.output : undefined
}

/** What the server writes as the output of a command that printed nothing. */
const NO_OUTPUT = "(no output)"

/**
 * The output a bash row draws: what the call reports, without terminal escapes. It is only the tail the server keeps
 * (`SHELL_TAIL_LINES`), so what the row keeps of it is the last line, not the first. Empty for a command that
 * printed nothing, which the server reports as the placeholder `(no output)`.
 */
export function shellOutput(metadata: Record<string, unknown>) {
  const output = stripAnsi(stringValue(metadata.output)?.trim() ?? "")
  return output === NO_OUTPUT ? "" : output
}

/** The output a generic tool row draws. */
export function genericOutput(output: string | undefined) {
  return output?.trim() ?? ""
}

/**
 * The output the row of a generic tool draws under its result line: the one the reader asked to see. A call that was
 * blocked draws why instead (`toolAttention`), and nothing else.
 */
export function genericRowOutput(attention: string | undefined, output: string | undefined, showOutput: boolean) {
  return !attention && showOutput ? genericOutput(output) : ""
}

/** Lines in `text`, which has no line break at its ends. */
function lineCount(text: string) {
  let count = 1
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++
  return count
}

/** The first line of `text`. */
export function firstLine(text: string) {
  const at = text.indexOf("\n")
  return at === -1 ? text : text.slice(0, at)
}

/** The last line of `text`: what a command ends on is what its folded row keeps of the output. */
export function lastLine(text: string) {
  return text.slice(text.lastIndexOf("\n") + 1)
}

/**
 * Whether the output of a call folds at `width`, the content width of the transcript, and how many of its lines the
 * fold leaves out: all but the one the row keeps under the call. An output folds past `TOOL_FOLD_LINES` lines, or past
 * the characters those lines take; one long line is cut and leaves no line out. A row, a click and `view.expand.toggle`
 * all ask this, so the key never lands on a row that cannot change.
 */
export function foldOutput(output: string, width: number) {
  if (!output || !outputOverflows(output, TOOL_FOLD_LINES, outputCharCap(TOOL_FOLD_LINES, width))) {
    return { folds: false, hidden: 0 }
  }
  return { folds: true, hidden: lineCount(output) - 1 }
}

/**
 * The lines the open row of a call draws under its result line, for the height of a row that is not measured yet: its
 * whole output, or the error of a call that failed (and the output it printed, which a bash call keeps).
 */
export function openToolLines(part: ToolPart) {
  const state = part.state
  if (state.status === "pending") return 0
  const output =
    toolDisplay(part.tool) === "bash" ? shellOutput(state.metadata ?? {}) : genericOutput(completedOutput(state))
  if (state.status !== "error") return output ? lineCount(output) : 0
  const error = state.error.trim()
  return (error ? lineCount(error) : 0) + (output ? lineCount(output) + 1 : 0)
}

/** Whether a write call draws a block, which it does once its diagnostics are known. */
export function writeShowsBlock(metadata: Record<string, unknown>) {
  return metadata.diagnostics !== undefined
}

/** Whether an edit call draws a block, which it does once its diff is known. */
export function editShowsBlock(metadata: Record<string, unknown>) {
  return stringValue(metadata.diff) !== undefined
}

/** The error of a call that failed. */
export function toolError(state: ToolPart["state"]) {
  return state.status === "error" ? state.error : undefined
}

/** The first line of `error` that has text, as one displayable line: what the row of a failed call says it failed on. */
export function errorLine(error: string | undefined) {
  for (const line of (error ?? "").split(/\r?\n/)) {
    const text = remoteLine(line)
    if (text) return text
  }
  return undefined
}

/** Whether `error` is the user or the permission rules turning the call down, which is not a failure. */
export function errorDenied(error: string | undefined) {
  return Boolean(
    error?.includes("QuestionRejectedError") ||
    error?.includes("rejected permission") ||
    error?.includes("specified a rule") ||
    error?.includes("user dismissed"),
  )
}

/** A call that failed on its own account. Its one-line row keeps the error folded under it until it is opened. */
export function toolFailed(state: ToolPart["state"]) {
  const error = toolError(state)
  return Boolean(error && !errorDenied(error))
}

/**
 * Whether the reasoning of `text` has a body to open under its header. Only the hide mode folds it: a shown
 * reasoning is open already, and a header without a body has nothing under it.
 */
export function reasoningFolds(text: string, thinking: ThinkingMode) {
  return thinking === "hide" && Boolean(reasoningSummary(text.replace("[REDACTED]", "")).body)
}

/**
 * Whether the prompt a sub-agent view opens with runs past what its task block shows before it folds, which is
 * `DELEGATION_PROMPT_LINES` lines or the characters those lines take at `width`, the content width of the transcript.
 * It is the test the tool outputs fold by, so the block, a click and `view.expand.toggle` agree on it.
 */
export function delegationFolds(text: string, width: number) {
  return outputOverflows(text, DELEGATION_PROMPT_LINES, outputCharCap(DELEGATION_PROMPT_LINES, width))
}

/**
 * The line under a tool output that folds (`tool.fold.*`): what the fold leaves out and what opens it, or what
 * closes it once it is open. `hidden` counts the lines past the cap (`collapseToolOutput`); with none, the output
 * is only cut at a long line. `key` is the binding of `view.expand.toggle`, which the session reads once and which
 * is empty while it is unbound: a block without one says "click" and names no key.
 */
export function foldHint(fold: { expanded: boolean; hidden: number }, key: string) {
  if (fold.expanded) return key ? t("tool.fold.less", { key }) : t("tool.fold.lessClick")
  if (fold.hidden <= 0) return key ? t("tool.fold.long", { key }) : t("tool.fold.longClick")
  const n = fold.hidden
  if (key) return t(n === 1 ? "tool.fold.more.one" : "tool.fold.more.other", { n, key })
  return t(n === 1 ? "tool.fold.moreClick.one" : "tool.fold.moreClick.other", { n })
}

/**
 * Whether the card of a background result has more to show than its one line of preview: a body of more than one line,
 * or a first line wider than the room that line has at `width`, the content width of the transcript, at the reader's
 * `ambiguous_width`. A body that is that one line has nothing to open. The card, its hint and `view.expand.toggle` all
 * read this, so the key never lands on a card that cannot change. A click on the card does not fold it: it opens the
 * sub-agent.
 */
export function resultCardFolds(
  card: Pick<BackgroundCard, "body" | "firstLine">,
  width: number,
  ambiguousWidth: AmbiguousWidth,
) {
  return (
    card.body.includes("\n") || cellWidth(card.firstLine, ambiguousWidth) > resultPreviewRoom(width, ambiguousWidth)
  )
}

/** Tools that draw a block without a fold once their metadata is there; a failed call of one is a block, not a row. */
function drawsFixedBlock(display: string, metadata: Record<string, unknown>) {
  switch (display) {
    case "write":
      return writeShowsBlock(metadata)
    case "edit":
      return editShowsBlock(metadata)
    case "apply_patch":
      return parseApplyPatchFiles(metadata.files).length > 0
    case "todowrite":
      return parseTodos(metadata.todos).length > 0
    case "question":
      return parseQuestionAnswers(metadata.answers) !== undefined
    default:
      return false
  }
}

/** What decides how much a part can fold: the settings of the view it is drawn in. */
export interface FoldEnv {
  /** Content width of the transcript: the wider it is, the more characters an output shows before it folds. */
  width: number
  thinking: ThinkingMode
  showGenericToolOutput: boolean
}

/** Where the text and the metadata of a part come from; the stream buffer overlays both while a part is written. */
export interface FoldSource {
  /** The text of a reasoning part. */
  text(part: Part): string
  /** `toolMetadata` of a tool part. */
  metadata(part: ToolPart): Record<string, unknown>
}

/**
 * The view flag a click on `part` flips, or undefined when the part has nothing to fold right now. A reasoning
 * with a body and a tool output past its cap fold under `expanded`; the error of a failed call, which its row draws
 * as one line, folds under `errorExpanded`.
 */
export function foldFlag(part: Part, env: FoldEnv, source: FoldSource): ViewFlag | undefined {
  if (part.type === "reasoning") return reasoningFolds(source.text(part), env.thinking) ? "expanded" : undefined
  if (part.type !== "tool") return undefined

  const metadata = source.metadata(part)
  const display = toolDisplay(part.tool)
  // Only a call that completed has an output its row draws. While it runs the row says so, and a call that failed
  // says why: its error folds under `errorExpanded`.
  if (part.state.status === "completed") {
    if (display === "bash" && foldOutput(shellOutput(metadata), env.width).folds) return "expanded"
    if (display === "generic") {
      const attention = toolAttention(part.tool, part.state)
      const output = genericRowOutput(attention, completedOutput(part.state), env.showGenericToolOutput)
      if (foldOutput(output, env.width).folds) return "expanded"
    }
  }
  if (drawsFixedBlock(display, metadata)) return undefined
  return toolFailed(part.state) ? "errorExpanded" : undefined
}
