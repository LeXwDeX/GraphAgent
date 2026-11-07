import { Schema } from "effect"
import { ToolContent, ToolFileContent, ToolTextContent } from "@graphagent/schema/llm"
import { JsonSchema, MessageRole, ProviderMetadata } from "./ids"
import { CacheHint, CachePolicy, GenerationOptions, HttpOptions, ModelSchema, ProviderOptions } from "./options"
import { isRecord } from "../utils/record"

const systemPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache: Schema.optional(CacheHint),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "LLM.SystemPart" })
export type SystemPart = Schema.Schema.Type<typeof systemPartSchema>

const makeSystemPart = (text: string): SystemPart => ({ type: "text", text })

const systemPartWithContent = Object.assign(systemPartSchema, {
  content: (input?: string | SystemPart | ReadonlyArray<SystemPart>) => {
    if (input === undefined) return []
    return typeof input === "string" ? [makeSystemPart(input)] : Array.isArray(input) ? [...input] : [input]
  },
})
Object.defineProperty(systemPartWithContent, "make", {
  value: makeSystemPart,
  configurable: true,
  writable: true,
  enumerable: true,
})
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- schema helpers are attached at runtime
export const SystemPart = systemPartWithContent as typeof systemPartSchema & {
  make: typeof makeSystemPart
  content: (input?: string | SystemPart | ReadonlyArray<SystemPart>) => SystemPart[]
}

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache: Schema.optional(CacheHint),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Content.Text" })
export type TextPart = Schema.Schema.Type<typeof TextPart>

export const MediaPart = Schema.Struct({
  type: Schema.Literal("media"),
  mediaType: Schema.String,
  data: Schema.Union([Schema.String, Schema.Uint8Array]),
  filename: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "LLM.Content.Media" })
export type MediaPart = Schema.Schema.Type<typeof MediaPart>

export { ToolContent, ToolFileContent, ToolTextContent }

const isToolResultValue = (value: unknown): value is ToolResultValue =>
  isRecord(value) &&
  (value.type === "text" || value.type === "json" || value.type === "error" || value.type === "content") &&
  "value" in value

const toolResultValueWithHelpers = Object.assign(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("json"),
      value: Schema.Unknown,
    }),
    Schema.Struct({
      type: Schema.Literal("text"),
      value: Schema.Unknown,
    }),
    Schema.Struct({
      type: Schema.Literal("error"),
      value: Schema.Unknown,
    }),
    Schema.Struct({
      type: Schema.Literal("content"),
      value: Schema.Array(ToolContent),
    }),
  ]).annotate({ identifier: "LLM.ToolResult" }),
  {
    is: isToolResultValue,
  },
)
const makeToolResultValue = (
  value: unknown,
  type: Schema.Schema.Type<typeof toolResultValueWithHelpers>["type"] = "json",
): Schema.Schema.Type<typeof toolResultValueWithHelpers> => {
  if (isToolResultValue(value)) return value
  if (type === "content") return { type, value: Array.isArray(value) ? value : [] }
  return { type, value }
}
Object.defineProperty(toolResultValueWithHelpers, "make", {
  value: makeToolResultValue,
  configurable: true,
  writable: true,
  enumerable: true,
})
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- schema helpers are attached at runtime
export const ToolResultValue = toolResultValueWithHelpers as typeof toolResultValueWithHelpers & {
  make: typeof makeToolResultValue
}
export type ToolResultValue = Schema.Schema.Type<typeof toolResultValueWithHelpers>

export interface ToolOutput {
  readonly structured: unknown
  readonly content: ReadonlyArray<ToolContent>
}

const toolOutputWithHelpers = Object.assign(
  Schema.Struct({
    structured: Schema.Unknown,
    content: Schema.Array(ToolContent),
  }).annotate({ identifier: "LLM.ToolOutput" }),
  {
    fromResultValue: (result: ToolResultValue): ToolOutput | undefined => {
      switch (result.type) {
        case "json":
          return { structured: result.value, content: [] }
        case "text":
          return { structured: {}, content: [{ type: "text", text: toolResultText(result.value) }] }
        case "content":
          return { structured: {}, content: result.value }
        case "error":
          return undefined
      }
    },
    toResultValue: (output: ToolOutput): ToolResultValue => {
      if (output.content.length === 0) return { type: "json", value: output.structured }
      if (output.content.length === 1 && output.content[0]?.type === "text")
        return { type: "text", value: output.content[0].text }
      return { type: "content", value: output.content }
    },
  },
)
const makeToolOutput = (structured: unknown, content: ReadonlyArray<ToolContent> = []): ToolOutput => ({
  structured,
  content,
})
Object.defineProperty(toolOutputWithHelpers, "make", {
  value: makeToolOutput,
  configurable: true,
  writable: true,
  enumerable: true,
})
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- schema helpers are attached at runtime
export const ToolOutput = toolOutputWithHelpers as typeof toolOutputWithHelpers & { make: typeof makeToolOutput }

const toolResultText = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const toolCallPartSchema = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  providerExecuted: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Content.ToolCall" })
const makeToolCallPart = (
  input: Omit<Schema.Schema.Type<typeof toolCallPartSchema>, "type">,
): Schema.Schema.Type<typeof toolCallPartSchema> => ({ type: "tool-call", ...input })
Object.defineProperty(toolCallPartSchema, "make", {
  value: makeToolCallPart,
  configurable: true,
  writable: true,
  enumerable: true,
})
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- schema helpers are attached at runtime
export const ToolCallPart = toolCallPartSchema as typeof toolCallPartSchema & { make: typeof makeToolCallPart }
export type ToolCallPart = Schema.Schema.Type<typeof toolCallPartSchema>

const toolResultPartSchema = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  result: ToolResultValue,
  providerExecuted: Schema.optional(Schema.Boolean),
  cache: Schema.optional(CacheHint),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Content.ToolResult" })
const makeToolResultPart = (
  input: Omit<Schema.Schema.Type<typeof toolResultPartSchema>, "type" | "result"> & {
    readonly result: unknown
    readonly resultType?: Schema.Schema.Type<typeof toolResultValueWithHelpers>["type"]
  },
): Schema.Schema.Type<typeof toolResultPartSchema> => ({
  type: "tool-result",
  id: input.id,
  name: input.name,
  result: ToolResultValue.make(input.result, input.resultType),
  providerExecuted: input.providerExecuted,
  cache: input.cache,
  metadata: input.metadata,
  providerMetadata: input.providerMetadata,
})
Object.defineProperty(toolResultPartSchema, "make", {
  value: makeToolResultPart,
  configurable: true,
  writable: true,
  enumerable: true,
})
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- schema helpers are attached at runtime
export const ToolResultPart = toolResultPartSchema as typeof toolResultPartSchema & { make: typeof makeToolResultPart }
export type ToolResultPart = Schema.Schema.Type<typeof toolResultPartSchema>

export const ReasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  encrypted: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Content.Reasoning" })
export type ReasoningPart = Schema.Schema.Type<typeof ReasoningPart>

export const ContentPart = Schema.Union([TextPart, MediaPart, ToolCallPart, ToolResultPart, ReasoningPart]).pipe(
  Schema.toTaggedUnion("type"),
)
export type ContentPart = Schema.Schema.Type<typeof ContentPart>

export class Message extends Schema.Class<Message>("LLM.Message")({
  id: Schema.optional(Schema.String),
  role: MessageRole,
  content: Schema.Array(ContentPart),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  native: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export namespace Message {
  export type ContentInput = string | ContentPart | ReadonlyArray<ContentPart>
  export type SystemContentInput = string | TextPart | ReadonlyArray<TextPart>
  export type Input = Omit<ConstructorParameters<typeof Message>[0], "content"> & {
    readonly content: ContentInput
  }

  export const text = (value: string): ContentPart => ({ type: "text", text: value })

  export const content = (input: ContentInput) =>
    typeof input === "string" ? [text(input)] : Array.isArray(input) ? [...input] : [input]

  export const make = (input: Message | Input) => {
    if (input instanceof Message) return input
    return new Message({ ...input, content: content(input.content) })
  }

  export const user = (content: ContentInput) => make({ role: "user", content })

  export const assistant = (content: ContentInput) => make({ role: "assistant", content })

  /**
   * Add an operator-authored instruction at this chronological point in the
   * conversation. This is distinct from the initial `LLMRequest.system`
   * prompt. Keep raw retrieved, tool, and web content out of privileged system
   * updates; pass that untrusted content through ordinary user/tool channels.
   */
  export const system = (content: SystemContentInput) => make({ role: "system", content })

  export const tool = (result: ToolResultPart | Parameters<typeof ToolResultPart.make>[0]) =>
    make({ role: "tool", content: ["type" in result ? result : ToolResultPart.make(result)] })
}

export class ToolDefinition extends Schema.Class<ToolDefinition>("LLM.ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  inputSchema: JsonSchema,
  outputSchema: Schema.optional(JsonSchema),
  cache: Schema.optional(CacheHint),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  native: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export namespace ToolDefinition {
  export type Input = ToolDefinition | ConstructorParameters<typeof ToolDefinition>[0]

  /** Normalize tool definition input into the canonical `ToolDefinition` class. */
  export const make = (input: Input) => (input instanceof ToolDefinition ? input : new ToolDefinition(input))
}

export class ToolChoice extends Schema.Class<ToolChoice>("LLM.ToolChoice")({
  type: Schema.Literals(["auto", "none", "required", "tool"]),
  name: Schema.optional(Schema.String),
}) {}

export namespace ToolChoice {
  export type Mode = Exclude<ToolChoice["type"], "tool">
  export type Input = ToolChoice | ConstructorParameters<typeof ToolChoice>[0] | ToolDefinition | string

  const isMode = (value: string): value is Mode => value === "auto" || value === "none" || value === "required"

  /** Select a specific named tool. */
  export const named = (value: string) => new ToolChoice({ type: "tool", name: value })

  /** Normalize ergonomic tool-choice inputs into the canonical `ToolChoice` class. */
  export const make = (input: Input) => {
    if (input instanceof ToolChoice) return input
    if (input instanceof ToolDefinition) return named(input.name)
    if (typeof input === "string") return isMode(input) ? new ToolChoice({ type: input }) : named(input)
    return new ToolChoice(input)
  }
}

export const ResponseFormat = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text") }),
  Schema.Struct({ type: Schema.Literal("json"), schema: JsonSchema }),
  Schema.Struct({ type: Schema.Literal("tool"), tool: ToolDefinition }),
]).pipe(Schema.toTaggedUnion("type"))
export type ResponseFormat = Schema.Schema.Type<typeof ResponseFormat>

export class LLMRequest extends Schema.Class<LLMRequest>("LLM.Request")({
  id: Schema.optional(Schema.String),
  model: ModelSchema,
  system: Schema.Array(SystemPart),
  messages: Schema.Array(Message),
  tools: Schema.Array(ToolDefinition),
  toolChoice: Schema.optional(ToolChoice),
  generation: Schema.optional(GenerationOptions),
  /** Omit the provider output-token cap after route and model defaults are resolved. */
  omitMaxTokens: Schema.optional(Schema.Boolean),
  providerOptions: Schema.optional(ProviderOptions),
  http: Schema.optional(HttpOptions),
  responseFormat: Schema.optional(ResponseFormat),
  cache: Schema.optional(CachePolicy),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export namespace LLMRequest {
  export type Input = ConstructorParameters<typeof LLMRequest>[0]

  export const input = (request: LLMRequest): Input => ({
    id: request.id,
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    generation: request.generation,
    omitMaxTokens: request.omitMaxTokens,
    providerOptions: request.providerOptions,
    http: request.http,
    responseFormat: request.responseFormat,
    cache: request.cache,
    metadata: request.metadata,
  })

  export const update = (request: LLMRequest, patch: Partial<Input>) => {
    if (Object.keys(patch).length === 0) return request
    return new LLMRequest({
      ...input(request),
      ...patch,
      model: patch.model ?? request.model,
    })
  }
}
