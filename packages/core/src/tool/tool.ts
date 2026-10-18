export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@opencode-ai/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { CandidateSafety } from "../session/context-folding/types"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /** Hook-only PreToolUse fields that no tool schema accepts (see SessionConversationHooks). */
  readonly hookInput?: Readonly<Record<string, unknown>>
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<Input extends SchemaType<any>, Output extends SchemaType<any>> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
  /**
   * Hook-facing failure for an invocation that completed normally. Returning
   * text routes the after-tool hook to its failure event without changing the
   * tool result or its model-facing output (for example a nonzero shell exit).
   */
  readonly hookFailure?: (input: Schema.Schema.Type<Input>, output: Output["Encoded"]) => string | undefined
  /** Host-owned execution evidence. Public application tools remain untrusted by source kind. */
  readonly contextFolding?: Readonly<{ instructions: CandidateSafety["instructions"] }>
}

type Runtime = {
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly validate: (call: ToolCall) => Effect.Effect<void, ToolFailure>
  readonly replaceOutput: (call: ToolCall, value: unknown) => Effect.Effect<ToolOutput, ToolFailure>
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
  readonly hookFailure: (call: ToolCall, output: unknown) => Effect.Effect<string | undefined>
  readonly contextFolding: Readonly<{ instructions: CandidateSafety["instructions"] }>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<Input extends SchemaType<any>, Output extends SchemaType<any>>(
  config: Config<Input, Output>,
): Definition<Input, Output> {
  const tool = Object.freeze({}) as Definition<Input, Output>
  const definitions = new Map<string, ToolDefinition>()
  const decode = (call: ToolCall) =>
    Schema.decodeUnknownEffect(config.input)(call.input).pipe(
      Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
    )
  const project = (input: Schema.Schema.Type<Input>, value: Schema.Schema.Type<Output>) =>
    Schema.encodeEffect(config.output)(value).pipe(
      Effect.mapError(
        (error) =>
          new ToolFailure({ message: `Tool returned an invalid value for its output schema: ${error.message}` }),
      ),
      Effect.map((output) => ({
        structured: output,
        content:
          config.toModelOutput?.({ input, output }).map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : {
                  type: "file" as const,
                  uri: `data:${part.mime};base64,${part.data}`,
                  mime: part.mime,
                  name: part.name,
                },
          ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
      })),
    )
  runtimes.set(tool, {
    validate: (call) => decode(call).pipe(Effect.asVoid),
    replaceOutput: (call, value) =>
      decode(call).pipe(
        Effect.flatMap((input) =>
          Schema.decodeUnknownEffect(config.output)(value).pipe(
            Effect.mapError((error) => new ToolFailure({ message: `Invalid hook tool output: ${error.message}` })),
            Effect.flatMap((output) => project(input, output)),
          ),
        ),
      ),
    contextFolding: config.contextFolding ?? { instructions: "unknown" },
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      decode(call).pipe(
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(Effect.flatMap((output) => project(input, output))),
        ),
      ),
    hookFailure: (call, output) =>
      config.hookFailure
        ? decode(call).pipe(
            Effect.map((input) => config.hookFailure?.(input, output as Output["Encoded"])),
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.succeed(undefined),
  })
  return tool
}

/** The tool's hook-facing failure text for a completed invocation, if declared. */
export const hookFailure = (tool: AnyTool, call: ToolCall, output: unknown) =>
  runtimes.get(tool)?.hookFailure(call, output) ?? Effect.succeed(undefined)

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)
export const contextFolding = (tool: AnyTool) => runtimeOf(tool).contextFolding

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

/** Decode only; no permission checks or execution. */
export const validateInput = (tool: AnyTool, call: ToolCall) => runtimeOf(tool).validate(call)

/** Validate and project a hook replacement through the original output codec. */
export const replaceOutput = (tool: AnyTool, call: ToolCall, value: unknown) =>
  runtimeOf(tool).replaceOutput(call, value)
