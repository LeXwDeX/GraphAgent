// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The case file of the model matrix (Issue #1474): one step of a recorded session, cut out so that another model
 * can be asked the same thing. `eval:case` writes one from a `graphagent export`, `eval:models --case` replays it
 * against the configured models, and the hand-written synthetic cases in `cases/` are replayed in CI.
 *
 *   { version: 1, session: { info, messages }, request, agent?, recorded, expect? }
 *
 * - `session`: the exported session up to the user message that is replayed, the message not included.
 * - `request`: the text of that user message.
 * - `agent`: the agent that message was sent to (`build`, `plan`, ...), when the export names one. A live replay
 *   sends the request to it, and a run whose host has no agent of that name ends in an error that says so; a case
 *   without one is sent to the host's default agent. The field is optional, so a case written before it existed
 *   is still a case and the version stays 1.
 * - `recorded`: what the original model did first, as one scripted reply: its first tool call, or its text.
 * - `expect`: only with a recorded call, the state that call ended in (`completed` or `error`). The CI replay of a
 *   synthetic case runs the tool for real and compares; a live replay stops every call before it runs.
 *
 * A case made from a real session holds real session content. It is written outside the repository with mode 0600
 * and is never committed; only synthetic cases are.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { isRecord } from "../delegation-timing/classify"
import { failed, type Parsed } from "./cli"
import { replyHas } from "./judge"
import type { Reply, RunView, Scenario } from "./types"

export const CASE_VERSION = 1

/** What the recorded model did first: one tool call, or an answer in text. */
export type Recorded =
  | { readonly text: string }
  | { readonly calls: readonly [{ readonly name: string; readonly input: Record<string, unknown> }] }

/** A message as `graphagent export` writes it: `info` has at least its `id` and its `role`. */
export interface ExportedMessage {
  readonly info: Record<string, unknown> & { readonly id: string; readonly role: string }
  readonly parts: readonly Record<string, unknown>[]
}

export interface CaseFile {
  readonly version: typeof CASE_VERSION
  /** The session as `graphagent export` writes it, the messages cut at the replayed user message. */
  readonly session: {
    readonly info: Record<string, unknown> & { readonly id: string }
    readonly messages: readonly ExportedMessage[]
  }
  readonly request: string
  /** The agent the user message was sent to; the replay sends the request to it. */
  readonly agent?: string
  readonly recorded: Recorded
  readonly expect?: { readonly status: string }
}

/** The messages of an export: each is `{ info, parts }` with an `id` and a `role` of its own. */
export function parseMessages(value: unknown): ExportedMessage[] | undefined {
  if (!Array.isArray(value)) return undefined
  const messages: ExportedMessage[] = []
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.info) || !Array.isArray(item.parts)) return undefined
    const { id, role } = item.info
    if (typeof id !== "string" || typeof role !== "string") return undefined
    const parts = item.parts.filter(isRecord)
    if (parts.length !== item.parts.length) return undefined
    messages.push({ info: { ...item.info, id, role }, parts })
  }
  return messages
}

function parseRecorded(value: unknown): Parsed<Recorded> {
  if (!isRecord(value)) return failed("recorded must be { text } or { calls: [{ name, input }] }")
  if (typeof value.text === "string" && value.calls === undefined) {
    return value.text.trim() === "" ? failed("recorded.text is empty") : { ok: true, value: { text: value.text } }
  }
  if (!Array.isArray(value.calls) || value.text !== undefined || value.calls.length !== 1) {
    return failed("recorded must be { text } or { calls } with exactly one call")
  }
  const [call] = value.calls
  if (!isRecord(call) || typeof call.name !== "string" || call.name === "" || !isRecord(call.input)) {
    return failed("recorded.calls[0] must be { name, input } with an input object")
  }
  return { ok: true, value: { calls: [{ name: call.name, input: call.input }] } }
}

/** The agent a case names: absent, or the name of one. */
function parseAgent(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value }
  if (typeof value !== "string" || value.trim() === "") return failed("agent must be the name of an agent")
  return { ok: true, value }
}

/** A case file's content, checked: the shape the other code relies on, and nothing about what the session holds. */
export function parseCaseFile(json: unknown): Parsed<CaseFile> {
  if (!isRecord(json)) return failed("a case file is a JSON object")
  if (json.version !== CASE_VERSION) return failed(`version must be ${CASE_VERSION}`)
  const { session } = json
  if (!isRecord(session) || !isRecord(session.info)) return failed("session must be { info, messages } with info.id")
  const { id } = session.info
  if (typeof id !== "string") return failed("session must be { info, messages } with info.id")
  const messages = parseMessages(session.messages)
  if (!messages) return failed("session.messages must be a list of { info, parts } with an id and a role each")
  if (typeof json.request !== "string" || json.request.trim() === "") return failed("request must be a non-empty text")
  const agent = parseAgent(json.agent)
  if (!agent.ok) return agent
  const recorded = parseRecorded(json.recorded)
  if (!recorded.ok) return recorded
  const value: CaseFile = {
    version: CASE_VERSION,
    session: { info: { ...session.info, id }, messages },
    request: json.request,
    ...(agent.value === undefined ? {} : { agent: agent.value }),
    recorded: recorded.value,
  }
  if (json.expect === undefined) return { ok: true, value }
  if (!isRecord(json.expect) || typeof json.expect.status !== "string") return failed("expect must be { status }")
  if ("text" in recorded.value) return failed("expect is only for a recorded call")
  return { ok: true, value: { ...value, expect: { status: json.expect.status } } }
}

/** The case a file holds, or why it is not one. */
export async function loadCaseFile(file: string): Promise<Parsed<CaseFile>> {
  let json: unknown
  try {
    json = JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    // A parse error can quote the text around the mistake, so only its kind is passed on.
    const why = error instanceof SyntaxError ? "not valid JSON" : error instanceof Error ? error.message : "unreadable"
    return failed(`cannot read the case file: ${why}`)
  }
  return parseCaseFile(json)
}

/** A case's name: its file name without the extension, which the replay marker `[case <name>]` carries too. */
export const caseName = (file: string): string => path.basename(file, path.extname(file))

/**
 * What a replay of the case in CI must show: the recorded call as the first call, in the state `expect` says; or,
 * for a recorded text, no call and that text.
 */
export function expectationFailures(file: CaseFile, run: RunView): string[] {
  const first = run.calls[0]
  if ("text" in file.recorded) {
    return [...(first ? [`calls: expected no tool call, got ${first.tool}`] : []), ...replyHas(run, file.recorded.text)]
  }
  const [{ name }] = file.recorded.calls
  if (!first) return [`calls: no ${name} call`]
  const wanted = file.expect?.status
  return [
    ...(first.tool === name ? [] : [`calls: first call is ${first.tool}, expected ${name}`]),
    ...(wanted === undefined || first.status === wanted
      ? []
      : [`calls: first call is ${first.status}, expected ${wanted}`]),
  ]
}

/**
 * The CI replay of a case as a scenario of the matrix: an empty workspace, the request as the prompt, the recorded
 * reply as the whole script. The session is not imported and the agent is not used; only the request is sent, behind
 * the `[case <name>]` marker.
 */
export function caseScenario(name: string, file: CaseFile): Scenario {
  const reply: Reply = file.recorded
  return {
    id: name,
    files: {},
    prompt: file.request,
    scripts: { default: { replies: [reply] } },
    judge: (run) => expectationFailures(file, run),
  }
}
