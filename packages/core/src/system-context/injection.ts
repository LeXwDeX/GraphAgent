// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The envelope of text the application inserts into the model's context (Issue #1456).
 *
 * Every such text is one `<system-reminder source="…">` block: the `source` says who wrote it, and the system
 * prompt says what each source is worth. Text from outside the application (hook output, a project's instruction
 * files, a third-party server's usage notes, a subagent's report) is escaped on the way in, so it can neither close
 * its block nor pass for another one. Escaping changes only the `<` that opens a tag of `ESCAPED_TAGS`; the rest of
 * the text stays as it is.
 */

/** The tags no inserted text may carry. The one table in the repository: every escape and every block derives from it. */
export const ESCAPED_TAGS = ["system-reminder", "upstream-output", "engine-facts"] as const

/**
 * The seven kinds of inserted text; the `source` attribute of every block.
 * - `reminder`: engine state reminder; its `kind` attribute is `todo`, `plan` or `dag`.
 * - `hook`: hook output and a hook's reason for blocking.
 * - `background-result`: the result notice of a background subagent.
 * - `instruction-file`: AGENTS.md and remote instructions; `path` is the file path or URL, and `status="unavailable"`
 *   marks one that could not be loaded.
 * - `mcp-instructions`: the usage notes of an MCP server; `server` is its name.
 * - `runtime`: the engine saying what just happened and what to do next; the text carries no prefix of its own.
 * - `compaction`: the continuation text after a compaction.
 */
export const SOURCES = [
  "reminder",
  "hook",
  "background-result",
  "instruction-file",
  "mcp-instructions",
  "runtime",
  "compaction",
] as const

export type Source = (typeof SOURCES)[number]

// An opening or closing tag of the table, in any letter case, whose name does not continue into a longer one.
const ESCAPED_TAG = new RegExp(`<(/?(?:${ESCAPED_TAGS.join("|")}))(?![A-Za-z0-9_-])`, "gi")

// A block's opening tag, in the old format (`<system-reminder>`) as well as the new one (`<system-reminder source=…>`).
const OPENING_TAG = /<system-reminder[\s>]/

/**
 * Write the `<` of every tag of `ESCAPED_TAGS` (opening or closing, with or without attributes) as `&lt;`; the rest
 * of the text is left exactly as it is, so escaping twice changes nothing more.
 */
export function escape(text: string): string {
  return text.replace(ESCAPED_TAG, "&lt;$1")
}

// `&`, quotes and angle brackets as entities, so a value can neither end its attribute nor start a tag; a line
// break as a space, so the opening tag stays on one line.
function attributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|[\n\r\u2028\u2029]/g, " ")
}

/** The opening tag of a block alone: `source` first, then `attrs` in their insertion order. */
export function open(source: Source, attrs?: Readonly<Record<string, string>>): string {
  const rest = Object.entries(attrs ?? {}).map(([key, value]) => ` ${key}="${attributeValue(value)}"`)
  return `<system-reminder source="${source}"${rest.join("")}>`
}

/** One block: the opening tag, the escaped text on its own lines, the closing tag. */
export function wrap(source: Source, text: string, attrs?: Readonly<Record<string, string>>): string {
  return `${open(source, attrs)}\n${escape(text)}\n</system-reminder>`
}

/** Whether the text holds the opening tag of a block, in the old format as well as the new one. */
export function has(text: string): boolean {
  return OPENING_TAG.test(text)
}

export * as Injection from "./injection"
