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

export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  if (!outputOverflows(output, maxLines, maxChars)) return { output, overflow: false }

  const lines = output.split("\n")
  const preview = lines.slice(0, maxLines).join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
    }
  }

  return { output: [...lines.slice(0, maxLines), "…"].join("\n"), overflow: true }
}
