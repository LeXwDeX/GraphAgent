// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import path from "node:path"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import type { MessageID, SessionID } from "./schema"

/**
 * The messages an automatic compaction replaces, saved as text before they leave the context (Issue #1469). The summary
 * only narrates them; this file is where the model reads what was said and done word for word, with `read` and `grep`.
 * It sits beside the saved tool outputs, which every agent may already read, and lives as long as its session: nothing
 * cleans it by age, and `Session.remove` deletes it.
 */

interface Input {
  readonly sessionID: SessionID
  /** The compaction marker: one file per compaction, so a later compaction never overwrites an earlier one. */
  readonly compactionID: MessageID
  readonly messages: readonly SessionV1.WithParts[]
}

const prefixOf = (sessionID: string) => `compacted_${sessionID}_`

/** Where the export of one compaction lives. */
export const pathOf = (input: Pick<Input, "sessionID" | "compactionID">) =>
  path.join(TRUNCATION_DIR, `${prefixOf(input.sessionID)}${input.compactionID}.txt`)

const stamp = (ms: number) => {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString()
}

// A tool call is its name, state and input on one line, then its complete output or error as stored.
function toolLines(part: SessionV1.ToolPart): string[] {
  const { state } = part
  const head = `[tool ${part.tool} ${state.status}] ${JSON.stringify(state.input)}`
  if (state.status === "completed") return state.output ? [head, state.output] : [head]
  if (state.status === "error") return [head, state.error]
  return [head]
}

// Text is written as the user or the model wrote it. Reasoning is left out: it is the model's own scratch work, long and
// often opaque, and what it led to is in the text and tool parts. Step, snapshot and bookkeeping parts say nothing the
// messages do not.
function partLines(part: SessionV1.Part): string[] {
  switch (part.type) {
    case "text":
      return part.text ? [part.text] : []
    case "tool":
      return toolLines(part)
    case "patch":
      return part.files.length > 0 ? [`[patch] ${part.files.join(", ")}`] : []
    case "file":
      return [`[Attached ${part.mime}: ${part.filename ?? "file"}]`]
    default:
      return []
  }
}

/** The export text: a header, then each message under a `=== role id time` line. */
export function render(input: Input): string {
  const lines = [
    `# Messages compacted from session ${input.sessionID} (compaction ${input.compactionID}). Reasoning parts are not included.`,
  ]
  for (const message of input.messages) {
    lines.push("", `=== ${message.info.role} ${message.info.id} ${stamp(message.info.time.created)}`)
    for (const part of message.parts) lines.push(...partLines(part))
  }
  return `${lines.join("\n")}\n`
}

/**
 * Saves the export, readable by its owner only: the messages hold whatever the session read and ran. Returns the path;
 * the caller decides what a failure costs.
 */
export const write = Effect.fn("CompactionExport.write")(function* (input: Input) {
  const fs = yield* FileSystem.FileSystem
  const file = pathOf(input)
  yield* fs.makeDirectory(TRUNCATION_DIR, { recursive: true })
  yield* fs.writeFileString(file, render(input), { mode: 0o600 })
  return file
}, Effect.provide(NodeFileSystem.layer))

/** Deletes every export of the session, whatever fails: a leftover file is no reason to keep a session. */
export const clear = Effect.fn("CompactionExport.clear")(function* (sessionID: SessionID) {
  const fs = yield* FileSystem.FileSystem
  const prefix = prefixOf(sessionID)
  const names = yield* fs.readDirectory(TRUNCATION_DIR).pipe(Effect.catch(() => Effect.succeed<string[]>([])))
  yield* Effect.forEach(
    names.filter((name) => name.startsWith(prefix)),
    (name) => fs.remove(path.join(TRUNCATION_DIR, name), { force: true }).pipe(Effect.ignore),
    { discard: true },
  )
}, Effect.provide(NodeFileSystem.layer))

/** What the continuation text tells the model about a saved export. */
export function retrievalNote(input: { path: string; sessionID: SessionID }) {
  const file = input.path
  return `Earlier messages were saved verbatim in ${file}; each starts with a "=== role id time" line. Search it with grep (pattern, path="${file}") or read a range with read (filePath="${file}", offset, limit). All exports of this session: ${TRUNCATION_DIR}/${prefixOf(input.sessionID)}*.txt.`
}

export * as CompactionExport from "./compaction-export"
