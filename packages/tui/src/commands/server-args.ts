// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Argument completion for known server commands. Server-provided commands do
 * not describe their arguments, so the TUI keeps a small explicit table.
 */
export const SERVER_COMMAND_ARGS: Readonly<Record<string, readonly string[]>> = {
  "dag-mode": ["on", "off", "status", "budget"],
}

export interface ServerArgumentContext {
  command: string
  partial: string
  candidates: readonly string[]
}

/**
 * Match `/name <partial>` against the argument table. Only the first argument
 * is completed; trailing extra words disable argument completion.
 */
export function parseServerCommandArgs(text: string): ServerArgumentContext | undefined {
  const match = /^\/([^\s/]+)\s+([^\s]*)$/.exec(text)
  if (!match) return undefined
  const candidates = SERVER_COMMAND_ARGS[match[1]]
  if (!candidates) return undefined
  const partial = match[2]
  return {
    command: match[1],
    partial,
    candidates: candidates.filter((candidate) => candidate.startsWith(partial)),
  }
}
