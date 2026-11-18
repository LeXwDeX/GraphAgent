// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import stripAnsi from "strip-ansi"

/**
 * One displayable line from a remote string (a server error, a check name, a
 * review excerpt). ANSI escapes are removed, line breaks collapse to a single
 * space and the remaining C0/C1 control characters are dropped, so the text can
 * neither restyle the terminal nor hide part of itself in a one-row slot.
 */
export function remoteLine(input: string): string {
  return stripAnsi(input)
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
}

/**
 * A multi-line remote text (a background run's result) for a block that keeps its lines: ANSI escapes are removed,
 * line breaks become `\n`, and the other C0/C1 control characters except the tab are dropped.
 */
export function remoteText(input: string): string {
  return stripAnsi(input)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
}
