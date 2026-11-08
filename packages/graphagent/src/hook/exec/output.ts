/**
 * Hook stdout/HTTP body classification and output validation.
 *
 * Pure-move extraction from the former `hook/settings.ts` (D1 PR1).
 */
import * as Log from "@/util/log"
import { HookOutputSchema, HookSpecificOutputSchema } from "../schema"
import { isRecord, type HookJSONOutput } from "../types"

const log = Log.create({ service: "hook.settings" })

/** Claude's terminal output field accepts only BEL and OSC 0/1/2/9/99/777. */
export function validTerminalSequence(value: string): boolean {
  if (!value) return false
  const sequence = /(?:\x07|\x1b\](?:0|1|2|9|99|777);[^\x07\x1b]*(?:\x07|\x1b\\))/gy
  let offset = 0
  while (offset < value.length) {
    sequence.lastIndex = offset
    const match = sequence.exec(value)
    if (!match) return false
    offset = sequence.lastIndex
  }
  return true
}

/** Outcome of reading synchronous hook output (reference 812-819). */
export type StdoutClass =
  { kind: "plain" } | { kind: "json"; value: HookJSONOutput } | { kind: "invalid"; message: string }

function tryParseJSON(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function validateOutput(value: unknown): StdoutClass {
  const parsed = HookOutputSchema.safeParse(value)
  return parsed.success
    ? { kind: "json", value: parsed.data as HookJSONOutput }
    : { kind: "invalid", message: parsed.error.message }
}

/**
 * Classify synchronous stdout. Only a whole-output JSON object is control output;
 * anything not starting with `{` or not ending with `}` is plain text (including a
 * truncated object). Several JSON lines are plain text unless one sets an output field.
 */
export function classifyStdout(stdout: string): StdoutClass {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { kind: "plain" }
  const whole = tryParseJSON(trimmed)
  if (whole.ok) return isRecord(whole.value) ? validateOutput(whole.value) : { kind: "plain" }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length >= 2 && lines[0]?.startsWith("{") && lines.at(-1)?.endsWith("}")) {
    const parsed = lines.map(tryParseJSON)
    if (parsed.every((line) => line.ok)) {
      const fields = new Set(Object.keys(HookOutputSchema.shape))
      const setsField = parsed.some(
        (line) => line.ok && isRecord(line.value) && Object.keys(line.value).some((key) => fields.has(key)),
      )
      return setsField
        ? { kind: "invalid", message: "multiple JSON lines include an output object" }
        : { kind: "plain" }
    }
  }
  return { kind: "invalid", message: "hook output is not valid JSON" }
}

/** HTTP bodies must be empty or one JSON object; any other 2xx body is a non-blocking failure. */
export function classifyHttpBody(body: string): StdoutClass | { kind: "empty" } {
  const trimmed = body.trim()
  if (!trimmed) return { kind: "empty" }
  const parsed = tryParseJSON(trimmed)
  if (!parsed.ok || !isRecord(parsed.value)) return { kind: "invalid", message: "http body is not a JSON object" }
  return validateOutput(parsed.value)
}

/** Async commands may print logs before a standalone compact JSON response. */
export function parseAsyncStdout(stdout: string, command: string): HookJSONOutput | undefined {
  const trimmed = stdout.trim()
  const lines = stdout.split(/\r?\n/).map((line) => line.trim())
  const candidates = [trimmed, ...lines.filter((line) => line.startsWith("{") && line !== trimmed).reverse()]
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue
    let raw: unknown
    try {
      raw = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!isRecord(raw)) continue
    // Claude drops malformed fields independently for async output. Keep the
    // valid siblings, including a valid nested additionalContext beside a bad
    // top-level field (or vice versa).
    const clean: Record<string, unknown> = {}
    for (const [name, schema] of Object.entries(HookOutputSchema.shape)) {
      if (!(name in raw)) continue
      if (name === "hookSpecificOutput" && isRecord(raw[name])) {
        const nested: Record<string, unknown> = {}
        for (const [field, fieldSchema] of Object.entries(HookSpecificOutputSchema.shape)) {
          if (field in raw[name] && fieldSchema.safeParse(raw[name][field]).success) nested[field] = raw[name][field]
        }
        clean[name] = nested
      } else if (schema.safeParse(raw[name]).success) clean[name] = raw[name]
    }
    const parsed = HookOutputSchema.safeParse(clean)
    if (parsed.success) return parsed.data as HookJSONOutput
  }
  if (lines.some((line) => line.startsWith("{"))) log.warn("async hook returned invalid JSON", { command })
  return undefined
}
