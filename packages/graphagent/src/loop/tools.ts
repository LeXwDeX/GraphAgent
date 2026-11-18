// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The analysis agent's tool set (#1328): the hook agent's read-only tools plus `submit_analysis`.
 *
 * Nothing here can write, reach the network or ask a question: read_file, list_dir, grep and the
 * whitelisted bash come from `hook/agent-tools` unchanged, and `submit_analysis` only records what the
 * model hands in. The tool is where a submission becomes an accepted result: it strips explicit nulls,
 * decodes the arguments, runs the drift guard (V1-V8) and either stores the result or returns the
 * numbered violations as the tool result, so the model retries inside the same conversation.
 */
import { Schema } from "effect"
import { jsonSchema, tool, type Tool } from "ai"
import { LoopAnalysisResult } from "@graphagent/schema/loop"
import { buildReadonlyTools, type BuildReadonlyToolsDeps } from "@/hook/agent-tools"
import { ToolJsonSchema } from "@/tool/json-schema"
import { formatSchemaFailures } from "@/tool/schema-error"
import { LoopFeedback } from "./feedback"
import type { LoopValidate } from "./validate"

export const SUBMIT = "submit_analysis"
/** Exactly the tools an analysis may call. */
export const NAMES = ["read_file", "list_dir", "grep", "bash", SUBMIT] as const

/** What `submit_analysis` has done so far in one analysis. The tool writes it, the driver reads it. */
export interface Submission {
  /** The first submission that decoded and passed V1-V8. Once set, later calls change nothing. */
  accepted: LoopAnalysisResult | undefined
  /** Submissions that were not accepted, plus stops without a submission (the driver counts those). */
  rejected: number
  /** The last rejection, as the model was told and as the rules it broke. */
  last: { readonly text: string; readonly violations: ReadonlyArray<LoopValidate.Violation> } | undefined
}

export function submission(): Submission {
  return { accepted: undefined, rejected: 0, last: undefined }
}

/** Records one rejected attempt and returns the text the model reads. */
export function reject(
  state: Submission,
  text: (attempt: number) => string,
  violations: ReadonlyArray<LoopValidate.Violation> = [],
): string {
  state.rejected += 1
  const message = text(state.rejected)
  state.last = { text: message, violations }
  return message
}

export interface BuildDeps extends BuildReadonlyToolsDeps {
  readonly submission: Submission
  /** V1-V8 for this analysis. The tool never judges content itself. */
  readonly check: (result: LoopAnalysisResult) => ReadonlyArray<LoopValidate.Violation>
  /** Tool results by tool call id, as the model should read them back on the next request. */
  readonly outputs: Map<string, string>
}

export function build(deps: BuildDeps): Record<string, Tool> {
  const submit = tool({
    description:
      "Submit the final analysis. Call it exactly once when you are ready. The runtime checks the result against " +
      "the drift rules; when it is rejected you get the violated rules back and must submit a corrected result.",
    inputSchema: jsonSchema(ToolJsonSchema.fromSchema(LoopAnalysisResult)),
    execute: async (args: unknown) => {
      deps.signal.throwIfAborted()
      const { submission: state } = deps
      if (state.accepted) return { output: LoopFeedback.ALREADY_ACCEPTED }

      const decoded = decode(args)
      if (!decoded.ok) return { output: reject(state, (attempt) => LoopFeedback.malformed(attempt, decoded.detail)) }

      const violations = deps.check(decoded.value)
      if (violations.length > 0)
        return { output: reject(state, (attempt) => LoopFeedback.violations(attempt, violations), violations) }

      state.accepted = decoded.value
      return { output: LoopFeedback.ACCEPTED }
    },
  })

  return recorded({ ...buildReadonlyTools(deps), [SUBMIT]: submit }, deps.outputs)
}

/** Wraps every tool so the driver can replay its result on the next request without parsing stream events. */
function recorded(tools: Record<string, Tool>, outputs: Map<string, string>): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => {
      const execute = item.execute
      if (!execute) return [name, item]
      const wrapped: Tool = {
        ...item,
        execute: async (args, options) => {
          try {
            const value: unknown = await execute(args, options)
            outputs.set(options.toolCallId, render(value))
            return value
          } catch (error) {
            outputs.set(options.toolCallId, `Error: ${error instanceof Error ? error.message : String(error)}`)
            throw error
          }
        },
      }
      return [name, wrapped]
    }),
  )
}

/** The text of a tool result: the hook tools answer `{ output: string }`. */
export function render(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null && "output" in value && typeof value.output === "string")
    return value.output
  return JSON.stringify(value) ?? String(value)
}

type Decoded =
  { readonly ok: true; readonly value: LoopAnalysisResult } | { readonly ok: false; readonly detail: string }

const decodeStrict = Schema.decodeUnknownSync(LoopAnalysisResult, { errors: "all" })

function attempt(value: unknown): Decoded {
  try {
    return { ok: true, value: decodeStrict(value) }
  } catch (error) {
    const detail = formatSchemaFailures(error, 12)
    return { ok: false, detail: detail || (error instanceof Error ? error.message.slice(0, 240) : "invalid arguments") }
  }
}

/**
 * Decodes the model's arguments. Explicit nulls on optional fields are dropped first (the schema rejects
 * them, models send them anyway). When that still fails, nested objects and arrays that arrived as JSON
 * strings are parsed and the decode is tried once more: the same repair the generic tool wrapper applies,
 * for model families that string-encode nested values.
 */
export function decode(args: unknown): Decoded {
  const stripped = withoutNulls(args)
  const first = attempt(stripped)
  if (first.ok) return first
  const repaired = parseContainers(stripped)
  if (repaired === stripped) return first
  const second = attempt(repaired)
  return second.ok ? second : { ok: false, detail: second.detail || first.detail }
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, withoutNulls(item)]),
  )
}

/** Returns the same reference when nothing was a stringified container. */
function parseContainers(value: unknown): unknown {
  if (typeof value === "string") {
    const text = value.trim()
    if (!text.startsWith("{") && !text.startsWith("[")) return value
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === "object" && parsed !== null ? parseContainers(parsed) : value
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    const mapped = value.map(parseContainers)
    return mapped.some((item, index) => item !== value[index]) ? mapped : value
  }
  if (typeof value !== "object" || value === null) return value
  const source = Object.entries(value)
  const entries = source.map(([key, item]) => [key, parseContainers(item)] as const)
  return entries.some(([, item], index) => item !== source[index]?.[1]) ? Object.fromEntries(entries) : value
}

export * as LoopTools from "./tools"
