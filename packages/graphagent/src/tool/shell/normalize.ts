// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import stripAnsi from "strip-ansi"

/**
 * What a command's terminal output looks like once the screen is gone: a progress bar redraws one line with `\r`
 * and colors arrive as escape sequences, and neither is text. Left in, they fill the 20 lines of the tail preview with
 * frames and noise (#1447).
 */

export interface Normalized {
  /** The text, the same string as the input when nothing changed. */
  text: string
  /** Frames dropped from lines that were redrawn with `\r`. */
  folded: number
  /** Whether ANSI escape sequences were removed. */
  ansi: boolean
}

/** One line with its `\r` frames folded into the last one; a CRLF line ending is not a frame and stays. */
function foldLine(line: string): { line: string; folded: number } {
  const crlf = line.endsWith("\r")
  const body = crlf ? line.slice(0, -1) : line
  if (!body.includes("\r")) return { line, folded: 0 }
  const frames = body.split("\r")
  return { line: frames[frames.length - 1] + (crlf ? "\r" : ""), folded: frames.length - 1 }
}

/**
 * Removes ANSI escape sequences and keeps only the last frame of each line that was redrawn with `\r`. The number of
 * lines does not change, so line counts and offsets into the saved original stay valid.
 */
export function normalize(text: string): Normalized {
  const plain = stripAnsi(text)
  const ansi = plain !== text
  let folded = 0
  const lines = plain.split("\n").map((line) => {
    const next = foldLine(line)
    folded += next.folded
    return next.line
  })
  if (folded === 0 && !ansi) return { text, folded, ansi }
  return { text: lines.join("\n"), folded, ansi }
}

/**
 * The line for `<shell_metadata>` that says the output was rewritten, and whether the original is still anywhere.
 * `saved` is whether the complete output was written to a file, which keeps the original text.
 */
export function note(normalized: Pick<Normalized, "folded" | "ansi">, saved: boolean): string {
  const did = [
    ...(normalized.folded > 0
      ? [`${normalized.folded} carriage-return ${normalized.folded === 1 ? "frame" : "frames"} folded`]
      : []),
    ...(normalized.ansi ? ["ANSI escape sequences removed"] : []),
  ]
  const tail = saved ? "The saved full output keeps the original text." : "The original text was not saved."
  return `output normalized: ${did.join("; ")}. ${tail}`
}

export * as ShellNormalize from "./normalize"
