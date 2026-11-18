// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "@/util/record"
import { ProbePlan } from "./plan"

/**
 * What the probe concludes from what the endpoint answered. Nothing here sends a request or imports the AI SDK:
 * the inputs are plain results (a status, an error text, the endpoint's own JSON chunks), so every branch can be
 * driven from a fixture, and a chunk of any shape is data to look at, never a reason to throw.
 *
 * One principle runs through all of it: what the endpoint was seen to send counts, however the request ended, and
 * the request's outcome only explains what was not seen (`failed` with a reason code, or `absent` when the request
 * completed and the thing was simply not there).
 */

/** Why a request failed. `http_<status>` is every response status the other codes do not name. */
export type Failure = "timeout" | "network" | "auth" | `http_${number}`

/**
 * How one request ended: `ok` (a 2xx response read to its end), `refused` (400 or 422, the endpoint rejecting the
 * request itself) or a failure code. Only the tool and replay probes read `refused` as an answer; for the others it
 * is a plain `http_400` or `http_422` failure.
 */
export type Outcome = "ok" | "refused" | Failure

export interface Attempt {
  readonly httpStatus?: number
  readonly error?: string
  readonly timedOut?: true
}

export interface ToolCallResult {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly invalid?: true
}

export interface ChatAttempt extends Attempt {
  /** The endpoint's event-stream chunks, each parsed from its JSON. */
  readonly raw: readonly unknown[]
  readonly toolCalls: readonly ToolCallResult[]
}

export type ModelsAttempt = (Attempt & { readonly body?: unknown }) | { readonly skipped: string }

/** The attempts of the probes that ran. A probe that did not run has no entry. */
export interface Results {
  readonly models?: ModelsAttempt
  readonly stream?: ChatAttempt
  readonly tool?: ChatAttempt
  readonly replayWith?: ChatAttempt
  readonly replayWithout?: ChatAttempt
  readonly length?: ChatAttempt
}

export interface ContextFinding {
  readonly status: "found" | "absent" | "failed" | "skipped"
  readonly tokens?: number
}

export interface Findings {
  readonly context: ContextFinding
  readonly usage: "reported" | "absent" | "failed"
  readonly toolCall: "supported" | "unsupported" | "inconclusive" | "failed"
  /** The delta field the reasoning arrived in, `absent` when a request completed without any, else `failed`. */
  readonly reasoningField: ProbePlan.ReasoningField | "absent" | "failed"
  readonly replay: "accepted" | "required" | "rejected" | "inconclusive" | "failed" | "skipped"
  /** The raw `finish_reason` values of every chat response, in order of first appearance. */
  readonly finishReasons: string[]
  /**
   * The observation behind each field above, keyed by the field name: complete, as received (the report is what
   * masks credentials and cuts it short). A failed item starts with its reason code, a skipped one is its reason code.
   */
  readonly evidence: Readonly<Record<string, string>>
}

export function outcomeOf(attempt: Attempt): Outcome {
  if (attempt.timedOut) return "timeout"
  const status = attempt.httpStatus
  if (status === undefined) return attempt.error === undefined ? "ok" : "network"
  if (status >= 200 && status < 300) return attempt.error === undefined ? "ok" : `http_${status}`
  if (status === 401 || status === 403) return "auth"
  if (status === 400 || status === 422) return "refused"
  return `http_${status}`
}

/** The failure code of an attempt that did not end `ok`, with a refusal counted as the plain HTTP failure it is. */
function failureOf(attempt: Attempt): Failure | undefined {
  const outcome = outcomeOf(attempt)
  if (outcome === "ok") return undefined
  return outcome === "refused" ? `http_${attempt.httpStatus ?? 0}` : outcome
}

function failedText(attempt: Attempt, code: string): string {
  return attempt.error ? `${code}: ${attempt.error}` : code
}

interface Verdict<T> {
  readonly finding: T
  readonly evidence: string
}

const NOT_RUN = "not_run"

function entryOf(body: unknown, apiID: string): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined
  for (const item of body.data) {
    if (isRecord(item) && item.id === apiID) return item
  }
  return undefined
}

function analyzeContext(models: ModelsAttempt | undefined, apiID: string): Verdict<ContextFinding> {
  if (models === undefined) return { finding: { status: "skipped" }, evidence: NOT_RUN }
  if ("skipped" in models) return { finding: { status: "skipped" }, evidence: models.skipped }
  const code = failureOf(models)
  if (code !== undefined) return { finding: { status: "failed" }, evidence: failedText(models, code) }
  const entry = entryOf(models.body, apiID)
  if (entry === undefined) {
    return { finding: { status: "absent" }, evidence: `no entry with id ${apiID} in GET /models` }
  }
  for (const key of ProbePlan.CONTEXT_KEYS) {
    const value = entry[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return { finding: { status: "found", tokens: value }, evidence: `${key}=${value} in GET /models` }
    }
  }
  return {
    finding: { status: "absent" },
    evidence: `the entry ${apiID} has no positive integer under ${ProbePlan.CONTEXT_KEYS.join(", ")}`,
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function analyzeUsage(stream: ChatAttempt | undefined): Verdict<Findings["usage"]> {
  if (stream === undefined) return { finding: "failed", evidence: NOT_RUN }
  let prompt: number | undefined
  let completion: number | undefined
  for (const chunk of stream.raw) {
    if (!isRecord(chunk) || !isRecord(chunk.usage)) continue
    prompt = count(chunk.usage.prompt_tokens) ?? prompt
    completion = count(chunk.usage.completion_tokens) ?? completion
  }
  if (prompt !== undefined || completion !== undefined) {
    const seen = [
      ...(prompt === undefined ? [] : [`prompt_tokens=${prompt}`]),
      ...(completion === undefined ? [] : [`completion_tokens=${completion}`]),
    ]
    return { finding: "reported", evidence: seen.join(", ") }
  }
  const code = failureOf(stream)
  if (code !== undefined) return { finding: "failed", evidence: failedText(stream, code) }
  return { finding: "absent", evidence: "no usage.prompt_tokens or usage.completion_tokens in any chunk" }
}

function isEcho(call: ToolCallResult): boolean {
  return (
    call.name === ProbePlan.TOOL_NAME &&
    call.invalid !== true &&
    isRecord(call.input) &&
    typeof call.input.text === "string"
  )
}

/** The call to the probe tool that carries a string `text`, which is what a working tool turn needs. */
export function echoCall(tool: ChatAttempt | undefined): ToolCallResult | undefined {
  return tool?.toolCalls.find(isEcho)
}

function finishReasonsOf(raw: readonly unknown[]): string[] {
  const seen: string[] = []
  for (const chunk of raw) {
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue
    const choice: unknown = chunk.choices[0]
    if (!isRecord(choice)) continue
    const reason = choice.finish_reason
    if (typeof reason === "string" && reason !== "" && !seen.includes(reason)) seen.push(reason)
  }
  return seen
}

function whyNoEcho(tool: ChatAttempt): string {
  const first = tool.toolCalls[0]
  if (first === undefined) {
    const reasons = finishReasonsOf(tool.raw)
    return reasons.length > 0 ? `no tool call; finish_reason ${reasons.join(", ")}` : "no tool call"
  }
  if (first.invalid) return `the call to ${first.name} did not parse`
  if (first.name !== ProbePlan.TOOL_NAME) return `called ${first.name}, not ${ProbePlan.TOOL_NAME}`
  return `${ProbePlan.TOOL_NAME} called without a string text`
}

function analyzeToolCall(tool: ChatAttempt | undefined): Verdict<Findings["toolCall"]> {
  if (tool === undefined) return { finding: "failed", evidence: NOT_RUN }
  const call = echoCall(tool)
  if (call !== undefined) {
    return { finding: "supported", evidence: `${call.name} called with ${JSON.stringify(call.input)}` }
  }
  const outcome = outcomeOf(tool)
  if (outcome === "refused") {
    const reason = tool.error ? `: ${tool.error}` : ""
    return { finding: "unsupported", evidence: `refused with HTTP ${tool.httpStatus}${reason}` }
  }
  if (outcome !== "ok") return { finding: "failed", evidence: failedText(tool, outcome) }
  return { finding: "inconclusive", evidence: whyNoEcho(tool) }
}

const present = (value: unknown): boolean =>
  (typeof value === "string" && value !== "") || (Array.isArray(value) && value.length > 0)

/** The text of a reasoning value: the string itself, or the string `text` of each element of a details array. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  let text = ""
  for (const item of value) {
    if (isRecord(item) && typeof item.text === "string") text += item.text
  }
  return text
}

function deltaOf(chunk: unknown): Record<string, unknown> | undefined {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return undefined
  const choice: unknown = chunk.choices[0]
  return isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined
}

/**
 * The reasoning field of one response and the text it carried. The first chunk with any of the three fields fixes
 * the field (in the order of `REASONING_FIELDS` within a chunk); the text is that field across all chunks. A
 * details array without any `text` names the field and leaves the text empty.
 */
export function reasoningOf(raw: readonly unknown[]): { field?: ProbePlan.ReasoningField; text: string } {
  let field: ProbePlan.ReasoningField | undefined
  let text = ""
  for (const chunk of raw) {
    const delta = deltaOf(chunk)
    if (delta === undefined) continue
    field ??= ProbePlan.REASONING_FIELDS.find((name) => present(delta[name]))
    if (field !== undefined) text += textOf(delta[field])
  }
  return field === undefined ? { text } : { field, text }
}

/**
 * The reasoning of the stream and tool responses together: the field is the stream response's, else the tool
 * response's; the text is the tool response's under that field, else the stream response's.
 */
export function reasoningAcross(
  stream: ChatAttempt | undefined,
  tool: ChatAttempt | undefined,
): { field?: ProbePlan.ReasoningField; text: string } {
  const fromStream = stream === undefined ? { text: "" } : reasoningOf(stream.raw)
  const fromTool = tool === undefined ? { text: "" } : reasoningOf(tool.raw)
  const field = fromStream.field ?? fromTool.field
  if (field === undefined) return { text: "" }
  const text = (fromTool.field === field ? fromTool.text : "") || (fromStream.field === field ? fromStream.text : "")
  return { field, text }
}

function analyzeReasoningField(
  stream: ChatAttempt | undefined,
  tool: ChatAttempt | undefined,
): Verdict<Findings["reasoningField"]> {
  const { field } = reasoningAcross(stream, tool)
  if (field !== undefined) {
    const source = stream !== undefined && reasoningOf(stream.raw).field !== undefined ? "stream" : "tool"
    return { finding: field, evidence: `delta.${field} of the ${source} response` }
  }
  const asked: ChatAttempt[] = []
  if (stream !== undefined) asked.push(stream)
  if (tool !== undefined) asked.push(tool)
  if (asked.some((attempt) => outcomeOf(attempt) === "ok")) {
    const names = ProbePlan.REASONING_FIELDS.join(", ")
    return { finding: "absent", evidence: `no ${names} in the stream and tool responses` }
  }
  const first = asked[0]
  const code = first === undefined ? undefined : failureOf(first)
  if (first === undefined || code === undefined) return { finding: "failed", evidence: NOT_RUN }
  return { finding: "failed", evidence: failedText(first, code) }
}

function describeLeg(attempt: ChatAttempt): string {
  if (outcomeOf(attempt) === "ok") return "ok"
  const reason = attempt.error ? `: ${attempt.error}` : ""
  return `refused (HTTP ${attempt.httpStatus}${reason})`
}

/** The evidence of a replay request that neither went through nor was refused, if this one is such. */
function failedLeg(label: string, attempt: ChatAttempt): string | undefined {
  const outcome = outcomeOf(attempt)
  return outcome === "ok" || outcome === "refused" ? undefined : `${failedText(attempt, outcome)} (${label})`
}

function analyzeReplay(results: Results, toolCall: Findings["toolCall"]): Verdict<Findings["replay"]> {
  const { replayWith, replayWithout } = results
  if (replayWith === undefined || replayWithout === undefined) {
    // The runner only skips the pair for these two reasons, and says which one it was by what it found.
    return { finding: "skipped", evidence: toolCall === "supported" ? "no_reasoning" : "no_tool_turn" }
  }
  const failure = failedLeg("replay_with", replayWith) ?? failedLeg("replay_without", replayWithout)
  if (failure !== undefined) return { finding: "failed", evidence: failure }
  const withOk = outcomeOf(replayWith) === "ok"
  const withoutOk = outcomeOf(replayWithout) === "ok"
  const evidence = `with: ${describeLeg(replayWith)}, without: ${describeLeg(replayWithout)}`
  if (withOk && withoutOk) return { finding: "accepted", evidence }
  if (withOk) return { finding: "required", evidence }
  if (withoutOk) return { finding: "rejected", evidence }
  return { finding: "inconclusive", evidence }
}

function analyzeFinishReasons(results: Results): Verdict<string[]> {
  const chats = [results.stream, results.tool, results.replayWith, results.replayWithout, results.length]
  const finding: string[] = []
  for (const attempt of chats) {
    for (const reason of attempt === undefined ? [] : finishReasonsOf(attempt.raw)) {
      if (!finding.includes(reason)) finding.push(reason)
    }
  }
  const length = results.length
  const cap = `maxOutputTokens=${ProbePlan.LENGTH_PROBE_TOKENS}`
  if (length === undefined) return { finding, evidence: "the length probe did not run" }
  const code = failureOf(length)
  if (code !== undefined) return { finding, evidence: `${failedText(length, code)} (length probe)` }
  const own = finishReasonsOf(length.raw)
  return { finding, evidence: `length probe (${cap}): ${own.length > 0 ? own.join(", ") : "no finish_reason"}` }
}

export function analyze(results: Results, apiID: string): Findings {
  const context = analyzeContext(results.models, apiID)
  const usage = analyzeUsage(results.stream)
  const toolCall = analyzeToolCall(results.tool)
  const reasoningField = analyzeReasoningField(results.stream, results.tool)
  const replay = analyzeReplay(results, toolCall.finding)
  const finishReasons = analyzeFinishReasons(results)
  return {
    context: context.finding,
    usage: usage.finding,
    toolCall: toolCall.finding,
    reasoningField: reasoningField.finding,
    replay: replay.finding,
    finishReasons: finishReasons.finding,
    evidence: {
      context: context.evidence,
      usage: usage.evidence,
      toolCall: toolCall.evidence,
      reasoningField: reasoningField.evidence,
      replay: replay.evidence,
      finishReasons: finishReasons.evidence,
    },
  }
}

export * as ProbeFindings from "./findings"
