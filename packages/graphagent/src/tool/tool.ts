import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Effect, Option, Schema, type Scope } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { ToolJsonSchema } from "./json-schema"
import { formatSchemaFailures } from "./schema-error"
import { Agent } from "@/agent/agent"

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
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail} Please rewrite the input so it satisfies the expected schema.`
  }
}

/**
 * Typed child-run capability reserved for H3 (#1026) and H6. Optional and
 * unused until H3 lands; `ctx.extra.promptOps` remains the active path until
 * then. H3 owns the concrete `ChildRunSpec`, `ChildRunView`, `ChildRunError`
 * and `ChildRunHandle` types in `src/session/child/run.ts`; this declaration
 * only reserves the typed context slot so tools stop reaching through
 * `extra.promptOps`. Only task/workflow receive it.
 */
export interface ChildRunHandle {
  readonly id: string
}

export interface ChildRunView {
  readonly id: string
  readonly childSessionID: SessionID
  readonly parentSessionID: SessionID
  readonly state: string
}

export type ChildRunCancelOrigin =
  | { kind: "main_agent_tool"; toolCallID: string }
  | { kind: "engine"; reason: string }

export interface ChildRuns {
  start(spec: unknown): Effect.Effect<ChildRunHandle, unknown, Scope.Scope>
  cancel(id: string, by: ChildRunCancelOrigin): Effect.Effect<void>
  inspect(id: string): Effect.Effect<ChildRunView>
  listByParent(parentSessionID: SessionID): Effect.Effect<readonly ChildRunView[]>
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  /** Typed child-run capability (H3 #1026); absent until the service lands. */
  children?: ChildRuns
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
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
   * Runs only when strict schema decoding fails: container fields are repaired,
   * then this hook, then the decoded value is strictly validated once.
   * Implementations must remain schema-specific and fail closed (return the
   * input unchanged when the shape is not recognized).
   */
  repairArguments?: (value: unknown) => unknown
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
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters, toolInfo.parseOptions)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        const invalidArguments = (error: unknown, input: unknown) => {
          const fallback = formatSchemaFailures(error)
          return new InvalidArgumentsError({
            tool: id,
            detail: toolInfo.formatValidationError
              ? toolInfo.formatValidationError(error, input)
              : fallback || "the input does not match the tool schema",
          })
        }
        return Effect.gen(function* () {
          // Strict decode first; the lenient retry only runs once strict
          // decoding already failed, so legitimate string arguments that look
          // like JSON are never re-parsed.
          const strict = yield* decode(args).pipe(Effect.option)
          let decoded: unknown
          if (Option.isSome(strict)) {
            decoded = strict.value
          } else {
            const base = toolInfo.repairContainerFields
              ? repairDeclaredContainers(args, toolInfo.repairContainerFields)
              : repairStringifiedContainers(args)
            const repaired = toolInfo.repairArguments ? toolInfo.repairArguments(base) : base
            // Only schema-owned key names are safe to include in diagnostics.
            if (toolInfo.repairArguments) {
              const changes = repairTypeChanges(args, repaired, diagnosticKeys)
              if (changes.length > 0)
                yield* Effect.logInfo("tool arguments repaired", { "tool.name": id, "repair.changes": changes })
            }
            decoded = yield* decode(repaired).pipe(Effect.mapError((error) => invalidArguments(error, repaired)))
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the decoder output is the schema type for this tool
          }
          const result = yield* execute(decoded as unknown as Schema.Schema.Type<Parameters>, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
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

function repairStringifiedContainers(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = parseStringifiedContainer(value)
    return parsed === undefined ? value : repairStringifiedContainers(parsed)
  }
  if (Array.isArray(value)) return value.map(repairStringifiedContainers)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairStringifiedContainers(item)]))
  }
  return value
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
