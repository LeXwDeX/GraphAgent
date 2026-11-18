// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import stripAnsi from "strip-ansi"
import type { Part, ToolPart } from "@graphagent/sdk"
import type { PartPreview } from "../../context/stream-buffer"
import { reasoningSummary, type ThinkingMode } from "../../context/thinking"
import type { BackgroundCard } from "../../session/background-card"
import { cellWidth, type AmbiguousWidth } from "../../ui/width"
import { outputOverflows } from "../../util/collapse-tool-output"
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

/** Lines of a bash output a block shows before it folds. */
export const SHELL_OUTPUT_LINES = 10
/** Lines of any other tool output a block shows before it folds. */
export const GENERIC_OUTPUT_LINES = 3

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

/** Whether a bash call draws a block, which it does once its output is known; before that it is one line. */
export function shellShowsBlock(metadata: Record<string, unknown>) {
  return stringValue(metadata.output) !== undefined
}

/** The output a bash block shows: what the call reports, without terminal escapes. */
export function shellOutput(metadata: Record<string, unknown>) {
  return stripAnsi(stringValue(metadata.output)?.trim() ?? "")
}

/** The output a generic tool block shows. */
export function genericOutput(output: string | undefined) {
  return output?.trim() ?? ""
}

/** Whether a generic tool draws a block: a call that was blocked, or one whose output the reader asked to see. */
export function genericShowsBlock(attention: string | undefined, output: string | undefined, showOutput: boolean) {
  return Boolean(attention) || (Boolean(output) && showOutput)
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
 * with a body and a tool output past its cap fold under `expanded`; the error of a failed call that is drawn as one
 * line folds under `errorExpanded`.
 */
export function foldFlag(part: Part, env: FoldEnv, source: FoldSource): ViewFlag | undefined {
  if (part.type === "reasoning") return reasoningFolds(source.text(part), env.thinking) ? "expanded" : undefined
  if (part.type !== "tool") return undefined

  const metadata = source.metadata(part)
  const display = toolDisplay(part.tool)
  if (display === "bash" && shellShowsBlock(metadata)) {
    const cap = outputCharCap(SHELL_OUTPUT_LINES, env.width)
    return outputOverflows(shellOutput(metadata), SHELL_OUTPUT_LINES, cap) ? "expanded" : undefined
  }
  if (display === "generic") {
    const output = completedOutput(part.state)
    if (genericShowsBlock(toolAttention(part.tool, part.state), output, env.showGenericToolOutput)) {
      const cap = outputCharCap(GENERIC_OUTPUT_LINES, env.width)
      return outputOverflows(genericOutput(output), GENERIC_OUTPUT_LINES, cap) ? "expanded" : undefined
    }
  }
  if (drawsFixedBlock(display, metadata)) return undefined
  return toolFailed(part.state) ? "errorExpanded" : undefined
}
