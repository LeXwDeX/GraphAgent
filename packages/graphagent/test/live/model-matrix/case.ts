// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * `eval:case` (Issue #1474): turns one step of a real session into a case file that `eval:models --case` can ask
 * the configured models. Run it by hand from `packages/graphagent`; it never runs in CI:
 *
 *   bun run eval:case --from <export.json> --out <case.json> [--user-message N]
 *
 * - `--from <export.json>`  the whole output of `graphagent export <sessionID>`: `{ info, messages }`
 * - `--user-message N`      the user message to replay, counted from 0 among the user messages (default: the last)
 * - `--out <file>`          where the case goes; one inside this repository is refused, because the case holds the
 *                           real session up to that message and must not be committed. The file is created with
 *                           mode 0600.
 *
 * The case is `{ version: 1, session, request, recorded, expect? }`, see `case-file.ts`: the messages before the
 * user message, its text, and what the original model did first (its first tool call, or its text).
 *
 * The whole case is checked for credentials before anything is written: a value shaped like a key or a token, or
 * holding the value of a secret-looking environment variable of this process, refuses the case. Only the JSON path
 * and the kind of the finding are printed, never the value.
 *
 * Exit code: 0 when the case was written, 1 when it was refused (a finding, or `--out` inside this repository), 2
 * for a usage error (bad arguments, an unreadable export, a user message the export does not have).
 */

import { HttpRecorderInternal } from "@graphagent/http-recorder/internal"
import fs from "node:fs/promises"
import path from "node:path"
import { isRecord } from "../delegation-timing/classify"
import { CASE_VERSION, parseMessages, type CaseFile, type ExportedMessage, type Recorded } from "./case-file"
import { failed, insideRepo, readFlags, REPO_ROOT, type Parsed } from "./cli"

export interface CaseOptions {
  readonly from: string
  readonly out: string
  readonly userMessage?: number
}

const FLAGS = ["--from", "--out", "--user-message"]

/** The command line, or why it is wrong. Nothing is read from the file system here. */
export function parseCaseOptions(argv: readonly string[]): Parsed<CaseOptions> {
  const flags = readFlags(argv, FLAGS)
  if (!flags.ok) return flags
  const given = (flag: string) => flags.value[flag] ?? []
  for (const flag of FLAGS) if (given(flag).length > 1) return failed(`${flag} may be given once`)
  const [from] = given("--from")
  const [out] = given("--out")
  const [asked] = given("--user-message")
  if (from === undefined) return failed("--from is required: the output of graphagent export <sessionID>")
  if (out === undefined) return failed("--out is required: where to write the case, outside this repository")
  if (asked !== undefined && !/^\d+$/.test(asked)) return failed("--user-message must be a number from 0")
  const options = { from: path.resolve(from), out: path.resolve(out) }
  return { ok: true, value: asked === undefined ? options : { ...options, userMessage: Number(asked) } }
}

/** The non-synthetic text parts of a message, one per line. */
function textOf(message: ExportedMessage): string {
  return message.parts
    .flatMap((part) =>
      part.type === "text" && part.synthetic !== true && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
}

/** The first tool part of a message: the tool and the state it ended in. */
function firstTool(message: ExportedMessage): { name: string; state: Record<string, unknown> } | undefined {
  for (const part of message.parts) {
    if (part.type === "tool" && typeof part.tool === "string") {
      return { name: part.tool, state: isRecord(part.state) ? part.state : {} }
    }
  }
  return undefined
}

/** What an assistant message did first: its first tool call and the state it ended in, else its text. */
function recordedOf(message: ExportedMessage): { recorded: Recorded; expect?: { status: string } } | undefined {
  const tool = firstTool(message)
  if (tool) {
    const recorded: Recorded = {
      calls: [{ name: tool.name, input: isRecord(tool.state.input) ? tool.state.input : {} }],
    }
    return typeof tool.state.status === "string" ? { recorded, expect: { status: tool.state.status } } : { recorded }
  }
  const text = textOf(message)
  return text.trim() === "" ? undefined : { recorded: { text } }
}

/**
 * The case for one user message of an export: `session` holds the messages before it, `request` its text, and
 * `recorded` (and `expect`) what the assistant message right after it did. A user message that no assistant
 * message follows (the next message is another user message, or there is none) has no reply, so it makes no case.
 */
export function buildCase(exported: unknown, userMessage?: number): Parsed<CaseFile> {
  if (!isRecord(exported) || !isRecord(exported.info)) {
    return failed("not the output of graphagent export: expected { info, messages }")
  }
  const { id } = exported.info
  if (typeof id !== "string") return failed("not the output of graphagent export: info has no id")
  const messages = parseMessages(exported.messages)
  if (!messages) return failed("not the output of graphagent export: messages must be a list of { info, parts }")
  const users = messages.flatMap((message, index) => (message.info.role === "user" ? [index] : []))
  const wanted = userMessage ?? users.length - 1
  const at = users[wanted]
  const user = at === undefined ? undefined : messages[at]
  if (at === undefined || !user) {
    return failed(
      users.length === 0
        ? "the session has no user message"
        : `--user-message ${wanted} is out of range: the session has ${users.length} user messages, numbered from 0`,
    )
  }
  const request = textOf(user)
  if (request.trim() === "") return failed(`user message ${wanted} has no text to ask again`)
  const next = messages[at + 1]
  const done = next?.info.role === "assistant" ? recordedOf(next) : undefined
  if (!done) return failed(`no assistant message with a tool call or text follows user message ${wanted}`)
  return {
    ok: true,
    value: {
      version: CASE_VERSION,
      session: { info: { ...exported.info, id }, messages: messages.slice(0, at) },
      request,
      recorded: done.recorded,
      ...(done.expect ? { expect: done.expect } : {}),
    },
  }
}

/** A JSON path that is safe to print: one that itself holds a secret-shaped text is hidden. */
function printable(findingPath: string): string {
  return HttpRecorderInternal.secretFindings(findingPath).length > 0 ? "<path hidden: it holds a secret>" : findingPath
}

/** The findings of a value as `path: reason` lines, each once and at most `limit`; never the value itself. */
export function findingLines(value: unknown, limit = 20): string[] {
  const lines = [
    ...new Set(HttpRecorderInternal.secretFindings(value).map((item) => `${printable(item.path)}: ${item.reason}`)),
  ]
  return lines.length > limit ? [...lines.slice(0, limit), `... and ${lines.length - limit} more`] : lines
}

export interface Output {
  readonly log: (line: string) => void
  readonly error: (line: string) => void
}

/**
 * Runs the command and returns its exit code. Nothing is written until the destination, the export and the case
 * have all been accepted. `repoRoot` is only for the tests.
 */
export async function runCaseCommand(
  argv: readonly string[],
  output: Output,
  repoRoot: string = REPO_ROOT,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    output.log("usage: bun run eval:case --from <export.json> --out <case.json> [--user-message N]")
    return 0
  }
  const usage = (error: string) => {
    output.error(`eval:case: ${error}`)
    return 2
  }
  const parsed = parseCaseOptions(argv)
  if (!parsed.ok) return usage(parsed.error)
  const { from, out, userMessage } = parsed.value
  if (insideRepo(out, repoRoot)) {
    output.error("eval:case: refused: --out is inside this repository; the case holds real session content")
    return 1
  }
  if (out === from) return usage("--out is the export itself; the case is written to a file of its own")
  let exported: unknown
  try {
    exported = JSON.parse(await fs.readFile(from, "utf8"))
  } catch (error) {
    // A parse error can quote the text around the mistake, so only its kind is passed on.
    const why = error instanceof SyntaxError ? "not valid JSON" : error instanceof Error ? error.message : "unreadable"
    return usage(`cannot read --from: ${why}`)
  }
  const built = buildCase(exported, userMessage)
  if (!built.ok) return usage(built.error)
  const findings = findingLines(built.value)
  if (findings.length > 0) {
    output.error("eval:case: refused: the case holds values that look like credentials; nothing was written")
    for (const line of findings) output.error(`  ${line}`)
    return 1
  }
  try {
    await fs.writeFile(out, `${JSON.stringify(built.value, null, 2)}\n`, { mode: 0o600 })
    // `mode` only applies to a file that is created: an existing one keeps what it had.
    await fs.chmod(out, 0o600)
  } catch (error) {
    return usage(`cannot write --out: ${error instanceof Error ? error.message : "unwritable"}`)
  }
  const { recorded } = built.value
  const what = "text" in recorded ? "text" : `a ${recorded.calls[0].name} call`
  output.log(`eval:case: wrote ${out} (${built.value.session.messages.length} earlier messages, recorded ${what})`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await runCaseCommand(process.argv.slice(2), {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}
