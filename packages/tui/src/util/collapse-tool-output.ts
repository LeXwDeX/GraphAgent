/**
 * Whether `output` runs past `maxLines` lines or `maxChars` characters, which is when `collapseToolOutput` folds it.
 * It stops at the first line over the cap and counts characters only when the string is long enough to need it, so
 * asking it of every tool output of a long transcript stays cheap.
 */
export function outputOverflows(output: string, maxLines: number, maxChars: number) {
  if (maxLines < 1) return true
  let lines = 1
  for (let at = output.indexOf("\n"); at !== -1; at = output.indexOf("\n", at + 1)) {
    if (++lines > maxLines) return true
  }
  // A character takes at least one UTF-16 unit, so a string within the cap has no more characters than the cap.
  return output.length > maxChars && Array.from(output).length > maxChars
}

/** What `collapseToolOutput` hands back. */
export interface CollapsedOutput {
  /**
   * What a folded block draws: the first `maxLines` lines, or, when those run past `maxChars`, the first characters of
   * them closed by a `…` inside the text. An output that does not fold comes back whole.
   */
  output: string
  overflow: boolean
  /**
   * Lines past `maxLines`, which the hint under a folded block counts. Nothing when the output is only cut at a long
   * line, or does not fold.
   */
  hidden: number
}

export interface CollapseOptions {
  /**
   * Closes an output cut by lines with a `…` line of its own, as the task block of a sub-agent view draws its
   * prompt. The hint line under a tool block opens with a `…` already, so those blocks leave this off.
   */
  ellipsisRow?: boolean
}

export function collapseToolOutput(
  output: string,
  maxLines: number,
  maxChars: number,
  options: CollapseOptions = {},
): CollapsedOutput {
  if (!outputOverflows(output, maxLines, maxChars)) return { output, overflow: false, hidden: 0 }

  const lines = output.split("\n")
  const hidden = Math.max(0, lines.length - maxLines)
  const kept = lines.slice(0, maxLines)
  const preview = kept.join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
      hidden,
    }
  }

  return { output: options.ellipsisRow ? [...kept, "…"].join("\n") : preview, overflow: true, hidden }
}
