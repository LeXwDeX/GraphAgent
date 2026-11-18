import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Effect, Option, Schema } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { addCorrections } from "@graphagent/core/session/outcome"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { ModelContext } from "./model-context"
import { ToolJsonSchema } from "./json-schema"
import { describeSchemaFailures } from "./schema-error"
import { ToolError } from "./tool-error"
import * as Receipt from "./receipt"
import { Agent } from "@/agent/agent"
import { isRecord } from "@/util/record"
import type { ChildRuns as ChildRunsModule } from "@/session/child/run"

interface Metadata {
  [key: string]: any
}

/**
 * Declared filesystem effect of a tool. `read` promises that a call cannot
 * change the workspace, so a step containing only read tools reuses its start
 * snapshot. `workspace_write` may change tracked files. `unknown` is treated
 * as a write; MCP and direct-shell entries always use it.
 */
export type Effects = "read" | "workspace_write" | "unknown"

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedError<InvalidArgumentsError>()("ToolInvalidArgumentsError", {
  tool: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return ToolError.render({ kind: "invalid_arguments", tool: this.tool, detail: this.detail })
  }
}

/**
 * Typed child-run capability (H3 #1026). The concrete types live in
 * `src/session/child/run.ts`; this module re-exports the ones a tool sees.
 * `ChildRuns` is the view narrowed to the calling session: the parent is fixed
 * by the engine and cannot be named by the tool. The task tool drives its child
 * sessions through it: every prompt goes out as a delegation under the
 * credential of the child's run. The workflow tool only reads run state
 * (`inspect.status`).
 */
export type { ChildRunHandle, ChildRunView } from "@/session/child/run"
export type ChildRunCancelOrigin = ChildRunsModule.ChildCancelBy
export type ChildRuns = ChildRunsModule.Scoped

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  /** Typed child-run capability (H3 #1026), narrowed to the calling session; only the task tool receives it. */
  children?: ChildRuns
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  /**
   * Non-durable running output preview (#1016 HS4a). Hosts that cannot stream
   * previews omit it; the tool then keeps the final result as its only output.
   */
  preview?(input: { tail: string; totalLength: number }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
  /**
   * Failure text for after-tool hooks on a result that completed normally.
   * The shell reports a nonzero exit as ordinary output so the model keeps the
   * command output; hooks still need the reference's PostToolUseFailure event.
   * This never changes the model-facing result or persisted metadata.
   */
  hookFailure?: string
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  /** Parse options applied when decoding LLM-supplied arguments. Tools whose
   * parameters are a discriminated union use `onExcessProperty: "error"` so a
   * call carrying another action's fields is rejected instead of silently
   * dropping them. */
  parseOptions?: {
    errors?: "first" | "all"
    onExcessProperty?: "ignore" | "error"
  }
  /**
   * Top-level fields whose stringified JSON container should be repaired before
   * strict decoding. Tools with scalar fields that may legitimately contain JSON
   * text (message content, cursors, keys) declare only their container fields;
   * leave this unset to keep the shared recursive repair for older tools.
   */
  repairContainerFields?: readonly string[]
  /**
   * Tool-scoped compatibility repair for provider-emitted argument shapes.
   * Runs only when strict schema decoding fails. It sees the raw arguments
   * first and the result is strictly decoded; when that still fails, container
   * fields are repaired, this hook runs once more on the repaired value, and
   * that value is strictly validated once. A call that decodes after a repair
   * is recorded as `args_repaired` in the result metadata.
   * Implementations must remain schema-specific and fail closed (return the
   * input unchanged when the shape is not recognized).
   */
  repairArguments?: (value: unknown) => unknown
  /**
   * Numeric parameters the tool caps. `max` is the constant the tool caps the value with. A call that asks for more
   * is told so at the end of its result and records `clamped` (#1451). The declaration is not part of the tool's
   * description or schema.
   */
  clamps?: Readonly<Record<string, { max: number }>>
  /** The output is JSON that clients parse: the wrapper adds no text to it and only records corrections in metadata. */
  structuredOutput?: boolean
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  /** `input` is the repaired input that failed the final strict decode. */
  formatValidationError?(error: unknown, input?: unknown): string
  /** Declared filesystem effect; missing means `unknown` (treated as a write). */
  effects?: Effects
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  DefWithoutID<Parameters, M> | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

/**
 * The OpenAI tools contract requires `parameters` to be a JSON Schema object.
 * A root-level combinator (anyOf/oneOf/allOf) is outside that contract:
 * OpenAI tolerates it, DeepSeek rejects it with a schema error, GLM silently
 * emits empty tool arguments, and qwen-family models string-encode property
 * values whose schema is a nested union (issue #297 — repaired by the
 * retry pass in the execute wrapper below). Tools that need a discriminated
 * union must nest it under a property (e.g. `{ params: <union> }`).
 * Violations fail at construction time here instead of degrading at provider
 * runtime.
 */
function assertObjectRootedParameters(
  id: string,
  toolInfo: DefWithoutID<never, never> | { parameters: unknown; jsonSchema?: unknown },
): JSONSchema7 {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the tool API accepts a schema or a precomputed JSON schema
  const root = toolInfo.jsonSchema ?? ToolJsonSchema.fromSchema(toolInfo.parameters as unknown as Schema.Top)
  if (!isPlainObjectRoot(root)) {
    return yieldOrDieRootCombinator(id, root)
  }
  return root
}

function isPlainObjectRoot(root: unknown): root is JSONSchema7 {
  return (
    typeof root === "object" &&
    root !== null &&
    !Array.isArray(root) &&
    (root as { type?: unknown }).type === "object" &&
    (root as { anyOf?: unknown }).anyOf === undefined &&
    (root as { oneOf?: unknown }).oneOf === undefined &&
    (root as { allOf?: unknown }).allOf === undefined
  )
}

function yieldOrDieRootCombinator(id: string, root: unknown): never {
  const combinator = ["anyOf", "oneOf", "allOf"].find((key) =>
    Array.isArray((root as unknown as Record<string, unknown>)?.[key]),
  )
  throw new Error(
    `Tool "${id}" parameters must serialize to a plain object root (type: "object" with properties); found a root-level ${combinator ?? "non-object"} combinator. Nest the union under a property, e.g. Schema.Struct({ params: <union> }). Root-level combinators violate the OpenAI tools contract: DeepSeek rejects them and GLM answers with empty tool arguments.`,
  )
}

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      const root = assertObjectRootedParameters(id, toolInfo as { parameters: unknown; jsonSchema?: unknown })
      const diagnosticKeys = new Set(Object.keys(root.properties ?? {}))
      const stringKeys = stringPropertyKeys(root)
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters, toolInfo.parseOptions)
      const invalidArguments = (error: unknown, input: unknown) => {
        const fallback = describeSchemaFailures(error)
        return new InvalidArgumentsError({
          tool: id,
          detail: toolInfo.formatValidationError
            ? toolInfo.formatValidationError(error, input)
            : fallback || "the input does not match the tool schema",
        })
      }
      // Only schema-owned key names are safe to include in diagnostics.
      const logRepair = (before: unknown, after: unknown) => {
        const changes = repairTypeChanges(before, after, diagnosticKeys)
        return changes.length > 0
          ? Effect.logInfo("tool arguments repaired", { "tool.name": id, "repair.changes": changes })
          : Effect.void
      }
      // The strict decode failed: repair the arguments and decode once more.
      const repairAndDecode = Effect.fnUntraced(function* (args: unknown) {
        const repairHook = toolInfo.repairArguments
        // The tool's own repair sees the raw input first, so a JSON-shaped string value is
        // never turned into a container before the tool has mapped its keys.
        if (repairHook) {
          const direct = repairHook(args)
          if (direct !== args) {
            const attempt = yield* decode(direct).pipe(Effect.option)
            if (Option.isSome(attempt)) {
              yield* logRepair(args, direct)
              return { value: attempt.value, given: direct }
            }
          }
        }
        const base = toolInfo.repairContainerFields
          ? repairDeclaredContainers(args, toolInfo.repairContainerFields)
          : repairStringifiedContainers(args, stringKeys)
        const repaired = repairHook ? repairHook(base) : base
        if (repairHook) yield* logRepair(args, repaired)
        const value = yield* decode(repaired).pipe(Effect.mapError((error) => invalidArguments(error, repaired)))
        return { value, given: repaired }
      })
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          // Strict decode first; the lenient retry only runs once strict
          // decoding already failed, so legitimate string arguments that look
          // like JSON are never re-parsed.
          const strict = yield* decode(args).pipe(Effect.option)
          let decoded: unknown
          let given: unknown = args
          let repaired = false
          if (Option.isSome(strict)) {
            decoded = strict.value
          } else {
            const fixed = yield* repairAndDecode(args)
            decoded = fixed.value
            given = fixed.given
            repaired = true
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the decoder output is the schema type for this tool
          }
          const notes = argumentNotes({
            tool: id,
            original: args,
            given,
            decoded,
            repaired,
            allowed: diagnosticKeys,
            clamps: toolInfo.clamps,
          })
          for (const kind of notes.kinds) yield* Receipt.logCorrection(id, kind)
          const toolCtx = repaired ? yield* markCorrection(ctx, "args_repaired") : ctx
          const result = yield* execute(decoded as unknown as Schema.Schema.Type<Parameters>, toolCtx)
          const metadata = repaired ? addCorrections(result.metadata, "args_repaired") : result.metadata
          if (result.metadata.truncated !== undefined) {
            return appendNotes(repaired ? { ...result, metadata } : result, notes, toolInfo.structuredOutput)
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, { context: ModelContext.contextOf(ctx.extra) }, agent)
          return appendNotes(
            {
              ...result,
              output: truncated.content,
              metadata: {
                ...metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
            },
            notes,
            toolInfo.structuredOutput,
          )
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

function valueTypeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Report type changes, using a fixed placeholder for keys outside the schema. */
function repairTypeChanges(before: unknown, after: unknown, allowed: ReadonlySet<string>): string[] {
  if (typeof before !== "object" || before === null || typeof after !== "object" || after === null) return []
  const leftEntries = new Map(Object.entries(before))
  const rightEntries = new Map(Object.entries(after))
  const changes: string[] = []
  for (const key of new Set([...leftEntries.keys(), ...rightEntries.keys()])) {
    const left = valueTypeName(leftEntries.get(key))
    const right = valueTypeName(rightEntries.get(key))
    if (left !== right) changes.push(`${allowed.has(key) ? key : "<unknown>"}:${left}->${right}`)
  }
  return changes
}

/** What the wrapper tells the model about the arguments of a call: the sentences, and the kinds they are recorded under. */
type ArgumentNotes = { readonly lines: readonly string[]; readonly kinds: readonly string[] }

/** A top-level value of the arguments; `undefined` when they are no object or lack the key. */
function argumentValue(value: unknown, key: string): unknown {
  return isRecord(value) ? Reflect.get(value, key) : undefined
}

/**
 * Corrections the harness made to the arguments of a call before the tool ran (#1451), one sentence each.
 * `original` is what the model sent, `given` the value the successful decode was handed, `decoded` its result and
 * `allowed` the parameters the schema declares. A call that decoded as sent gets a sentence for the keys the
 * decoder ignored (`excess_keys`). A repaired call gets one for what the repair set and the keys it did not use,
 * so those keys are named there and not under a kind. A number above its declared maximum gets one (`clamped`).
 */
function argumentNotes(input: {
  tool: string
  original: unknown
  given: unknown
  decoded: unknown
  repaired: boolean
  allowed: ReadonlySet<string>
  clamps: Def["clamps"]
}): ArgumentNotes {
  const lines: string[] = []
  const kinds: string[] = []
  // A key the tool never read: it is not declared, and the decode did not carry it over either.
  const unused = isRecord(input.original)
    ? Object.keys(input.original).filter(
        (key) => !input.allowed.has(key) && !(isRecord(input.decoded) && Object.hasOwn(input.decoded, key)),
      )
    : []
  if (!input.repaired) {
    if (unused.length > 0) {
      lines.push(Receipt.excessKeyNote(input.tool, unused))
      kinds.push("excess_keys")
    }
  } else {
    const set = [...input.allowed].filter(
      (key) => valueTypeName(argumentValue(input.given, key)) !== valueTypeName(argumentValue(input.original, key)),
    )
    lines.push(Receipt.repairedNote(set, unused))
  }
  for (const [param, { max }] of Object.entries(input.clamps ?? {})) {
    const requested = argumentValue(input.decoded, param)
    if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= max) continue
    lines.push(Receipt.clampNote(param, requested, max))
    if (!kinds.includes("clamped")) kinds.push("clamped")
  }
  return { lines, kinds }
}

/**
 * `result` with the notes added after its output, which is already truncated, so the wrapper truncates once and
 * every note stays whole. A tool whose output is JSON gets none. The kinds go into `metadata.corrections` either way.
 */
function appendNotes<R extends ExecuteResult>(result: R, notes: ArgumentNotes, structured: boolean | undefined): R {
  const output =
    structured || notes.lines.length === 0 ? result.output : `${result.output}\n\n${notes.lines.join("\n")}`
  const metadata = notes.kinds.length > 0 ? addCorrections(result.metadata, ...notes.kinds) : result.metadata
  return output === result.output && metadata === result.metadata ? result : { ...result, output, metadata }
}

// Some models string-encode a tool-argument container whose schema is a
// nested union (qwen family, issue #297): the wire carries {"params":
// "{\"action\": \"list\"}"} instead of a nested object. Re-parse strings that
// sit where a container is expected and let the strict decode judge the
// result. Runs only after the strict decode failed, so plain string
// parameters are never touched.
function parseStringifiedContainer(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Repair only the top-level container fields a tool declares. Scalar fields
 * such as message content, cursors and idempotency keys may legitimately hold
 * JSON-looking text and must reach the schema unchanged. */
function repairDeclaredContainers(value: unknown, fields: readonly string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  let repaired: Record<PropertyKey, unknown> | undefined
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue
    const current = Reflect.get(value, field)
    if (typeof current !== "string") continue
    const parsed = parseStringifiedContainer(current)
    if (parsed === undefined) continue
    repaired ??= { ...value }
    Reflect.set(repaired, field, parsed)
  }
  return repaired ?? value
}

/**
 * Re-parse every string that holds a JSON container. `keep` names the top-level
 * keys whose string value is final (the schema types them as strings), so text
 * such as `{"a":1}` in a `content` or `oldString` argument stays text; only the
 * top level is protected, nested values are always re-parsed.
 */
function repairStringifiedContainers(value: unknown, keep?: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    const parsed = parseStringifiedContainer(value)
    return parsed === undefined ? value : repairStringifiedContainers(parsed)
  }
  if (Array.isArray(value)) return value.map((item) => repairStringifiedContainers(item))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, keep?.has(key) ? item : repairStringifiedContainers(item)]),
    )
  }
  return value
}

/**
 * The call as the tool sees it once the harness has corrected something for it
 * (`kind`: a repaired argument, a fuzzy match, ...). The correction is written to
 * the running part at once and every later metadata update of the tool keeps it,
 * so a call that then fails or is aborted still reports it; a call that completes
 * carries it in its result metadata. The write replaces what the call reported
 * so far, so mark before reporting metadata of your own. Marks add up: a tool
 * keeps reporting through the context this returns.
 */
export const markCorrection = Effect.fnUntraced(function* (ctx: Context, kind: string) {
  const marked: Context = {
    ...ctx,
    metadata: (input) => ctx.metadata({ ...input, metadata: addCorrections(input.metadata ?? {}, kind) }),
  }
  yield* marked.metadata({})
  return marked
})

/** Top-level properties the parameter schema declares as plain strings. */
function stringPropertyKeys(root: JSONSchema7): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const [key, property] of Object.entries(root.properties ?? {})) {
    if (typeof property === "object" && property.type === "string") keys.add(key)
  }
  return keys
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

/**
 * Fix broken multi-byte Unicode escapes in LLM-generated JSON.
 * e.g., `\u008  ba` → `\u00e9` (concatenated nibbles split across spaces)
 */
export function fixJsonUnicodeEscapes(json: string): string {
  return json.replace(/\\u00([0-9a-fA-F])\s+([0-9a-fA-F]{2})/g, "\\u00$1$2")
}

/**
 * Parse JSON with pre-processing to fix common LLM quirks.
 */
export function safeParseJson(json: string): unknown {
  return JSON.parse(fixJsonUnicodeEscapes(json))
}

export * as Tool from "./tool"
