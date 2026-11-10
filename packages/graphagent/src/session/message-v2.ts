import { ThinkingReplay } from "./thinking-replay"
import { SessionID, MessageID } from "./schema"
import { SessionAbortReason } from "./abort-reason"
import { SessionV1 } from "@graphagent/core/v1/session"
import { METADATA_NAMESPACE } from "@graphagent/core/brand"
import { ProviderV2 } from "@graphagent/core/provider"
import { isContextOverflowFailure, LLMError, ProviderErrorEvent, ReasoningCarrier } from "@graphagent/llm"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@graphagent/core/v1/session"

import { NamedError } from "@graphagent/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { count } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"
import { ContextFolding } from "./context-folding"
import { isReplayableAssistantMessage } from "./message-replay"
import { isRecord } from "@/util/record"

export const node = LayerNode.group([Database.node])
export { isReplayableAssistantMessage }

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  PartPreview: SessionV1.Event.PartPreview,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const decodeFormat = Schema.decodeUnknownSync(SessionV1.Format)

const info = (row: typeof MessageTable.$inferSelect): Info => {
  const value = {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  } as Info
  // JSON persistence removes Schema.Class prototypes. Rehydrate the output
  // format before this user message can be consumed or republished as an event.
  if (value.role === "user" && value.format) value.format = decodeFormat(value.format)
  return value
}

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

/** Strictly newer than `row`, the ascending mirror of `older`. */
const newer = (row: Cursor) =>
  or(gt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), gt(MessageTable.id, row.id)))

/** At or before `row` under the `(time_created, id)` ordering. */
const through = (row: Cursor) =>
  or(
    lt(MessageTable.time_created, row.time),
    and(eq(MessageTable.time_created, row.time), lte(MessageTable.id, row.id)),
  )

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

import { reasoningForReplay } from "@graphagent/core/session/reasoning-distillation/canonical"

// Compaction changes the signed conversation prefix. Only these native carriers
// are known to encode Claude thinking/redacted_thinking blocks; other reasoning
// keeps its existing replay policy.
function claudeThinking(metadata: Record<string, any> | undefined, providerID: string) {
  return [metadata?.anthropic, metadata?.bedrock, metadata?.[providerID]].some(
    (value) => value?.signature != null || value?.redactedData != null || value?.redactedContent != null,
  )
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
    reasoningDistillationEnabled?: boolean
    stripSignedThinking?: boolean
    stripOpaqueReasoning?: boolean
  },
) {
  const result: UIMessage[] = []
  const claudeReplay = ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock"].includes(
    model.api.npm,
  )
  const compactions = new Map<MessageID, User>()
  for (const msg of input) {
    if (msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"))
      compactions.set(msg.info.id, msg.info)
  }
  const compactedThrough = input.reduce<User | undefined>((boundary, msg) => {
    if (msg.info.role !== "assistant" || !msg.info.summary || !msg.info.finish || msg.info.error) return boundary
    const marker = compactions.get(msg.info.parentID)
    if (!marker) return boundary
    return !boundary || before(boundary, marker) ? marker : boundary
  }, undefined)
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (!isReplayableAssistantMessage(msg)) continue
      // Any successful compaction inserts a summary before the retained old tail,
      // so opaque reasoning from that replaced prefix and from the summary itself
      // is not replayable. Every summarizer input strips opaque reasoning too,
      // whatever the prior marker. Fresh post-boundary reasoning stays replayable.
      const invalidatedThinking =
        options?.stripOpaqueReasoning === true ||
        msg.info.summary === true ||
        (compactedThrough !== undefined && before(msg.info, compactedThrough)) ||
        (claudeReplay && options?.stripSignedThinking === true)
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning =
        !invalidatedThinking &&
        msg.parts.some((part) => {
          if (part.type !== "reasoning") return false
          return part.metadata?.anthropic?.signature != null
        })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          const replay = reasoningForReplay({
            text: part.text,
            metadata: part.metadata,
            distillation: part.distillation,
            enabled: options?.reasoningDistillationEnabled === true,
          })
          const carrier = ReasoningCarrier.classify(replay.metadata, replay.text)
          const knownThinking = ThinkingReplay.origin(replay.metadata) !== undefined
          if (
            invalidatedThinking &&
            claudeReplay &&
            claudeThinking(replay.metadata, msg.info.providerID) &&
            !knownThinking
          )
            continue
          if (!knownThinking && (differentModel || (invalidatedThinking && carrier.kind === "opaque"))) {
            if (replay.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: replay.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: replay.text,
            providerMetadata: (invalidatedThinking && knownThinking
              ? ThinkingReplay.forceInvalidation(replay.metadata)
              : replay.metadata) as typeof part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
                // providerMetadata is a known UIMessage field and
                // convertToModelMessages carries it as providerOptions. This is
                // explicit provenance across the conversion boundary, not a
                // positional guess.
                providerMetadata: { [METADATA_NAMESPACE]: { synthetic: "attachment", cache: "none" } },
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  const messages = yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
  // `convertToModelMessages` drops message-level metadata for user messages, so
  // promote the synthetic attachment marker after conversion. Native cache
  // policy and provider transforms read the message marker; the part marker
  // stays for target selection.
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message
    const marked = message.content.some((part) => {
      if (typeof part !== "object" || part === null) return false
      if (!("providerOptions" in part)) return false
      const options = part.providerOptions
      if (!isRecord(options)) return false
      const local = options[METADATA_NAMESPACE]
      return isRecord(local) && local.synthetic === "attachment"
    })
    if (!marked) return message
    const options = isRecord(message.providerOptions) ? message.providerOptions : {}
    const local = isRecord(options[METADATA_NAMESPACE]) ? options[METADATA_NAMESPACE] : {}
    return {
      ...message,
      providerOptions: {
        ...options,
        [METADATA_NAMESPACE]: { ...local, synthetic: "attachment", cache: "none" },
      },
    }
  })
})

export const contextFoldingHistory = ContextFolding.history

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
    reasoningDistillationEnabled?: boolean
    stripSignedThinking?: boolean
    stripOpaqueReasoning?: boolean
  },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

/**
 * Ascending page strictly after a [`cursor`] — the forward mirror of `page`.
 * The ordering key is exactly the same `(time_created, id)` pair, so walking a
 * session with alternating `page`/`after` calls never skips or repeats a row.
 *
 * An unknown session yields an empty page instead of `NotFoundError`: transcript
 * materialization runs for session ids that unit layers never persisted.
 */
export const after = Effect.fn("MessageV2.after")(function* (input: {
  sessionID: SessionID
  limit: number
  after?: string
}) {
  const { db } = yield* Database.Service
  const start = input.after ? cursor.decode(input.after) : undefined
  const where = start
    ? and(eq(MessageTable.session_id, input.sessionID), newer(start))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

/**
 * Number of messages at or before a cursor under the `(time_created, id)`
 * ordering. Runs as a `COUNT(*)` without hydrating parts; transcript
 * materialization uses it to detect deletions and inserts before the point it
 * has already persisted.
 */
export const countThrough = Effect.fn("MessageV2.countThrough")(function* (input: {
  sessionID: SessionID
  cursor: string
}) {
  const at = cursor.decode(input.cursor)
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ count: count() })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID), through(at)))
    .get()
    .pipe(Effect.orDie)
  return row?.count ?? 0
})

/**
 * The newest `limit` user-role messages with parts, oldest first. The role
 * filter runs in SQLite (`json_extract`) so deriving prompt identity costs one
 * bounded read instead of loading the whole session.
 */
export const recentUsers = Effect.fn("MessageV2.recentUsers")(function* (input: {
  sessionID: SessionID
  limit: number
}) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(
      and(eq(MessageTable.session_id, input.sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`),
    )
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit)
    .all()
    .pipe(Effect.orDie)
  const items = yield* hydrate(db, rows)
  items.reverse()
  return items
})

export function stream(sessionID: SessionID) {
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      const next = yield* page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (item) result.push(item)
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

/** Message-row existence without hydrating parts. */
export const exists = Effect.fn("MessageV2.exists")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

const INFO_LOOKUP_CHUNK = 500

/**
 * Message metadata for a bounded set of ids, without parts. The ids are bound as
 * opaque strings: callers may pass stale or corrupt anchors and simply get no
 * entry for them, matching a map lookup on a fully read transcript.
 */
export function infosByIDs(
  db: Database.Interface["db"],
  input: { sessionID: SessionID; messageIDs: ReadonlyArray<string> },
): Effect.Effect<ReadonlyMap<string, SessionV1.Info>> {
  return Effect.gen(function* () {
    const ids = [...new Set(input.messageIDs)]
    const result = new Map<string, SessionV1.Info>()
    for (let start = 0; start < ids.length; start += INFO_LOOKUP_CHUNK) {
      const chunk = ids.slice(start, start + INFO_LOOKUP_CHUNK) as unknown as ReadonlyArray<MessageID>
      if (chunk.length === 0) continue
      const rows = yield* db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, input.sessionID), inArray(MessageTable.id, chunk)))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) result.set(String(row.id), info(row))
    }
    return result
  })
}

/**
 * A user message plus the assistant messages directly parented to it, in
 * `(time_created, id)` order. Turn-diff summarization needs exactly this slice,
 * not the whole transcript. Mirrors `page`: only a zero-row read distinguishes
 * a missing session from an empty result.
 */
export const turnMessages = Effect.fn("MessageV2.turnMessages")(function* (input: {
  sessionID: SessionID
  userMessageID: MessageID
}) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, input.sessionID),
        or(
          eq(MessageTable.id, input.userMessageID),
          and(
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_extract(${MessageTable.data}, '$.parentID') = ${input.userMessageID}`,
          ),
        ),
      ),
    )
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const session = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return [] as WithParts[]
  }
  return yield* hydrate(db, rows)
})

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(yield* stream(sessionID))
})

/**
 * Raw retained tail rows in replay-walk order (newest first). It pages
 * newest-first exactly like [`stream`], but stops as soon as the replay walk in
 * [`filterCompacted`] would break: at a completed compaction boundary without a
 * retained tail, or after reaching the boundary's `tail_start_id`. The write-
 * through history cache stores this raw slice and derives the model-visible
 * view lazily, so it must not apply [`filterCompacted`] here.
 */
export const collectCompactedTail = Effect.fn("MessageV2.collectCompactedTail")(function* (sessionID: SessionID) {
  const size = 50
  const collected = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  let done = false
  let before: string | undefined
  while (!done) {
    const next = yield* page({ sessionID, limit: size, before }).pipe(
      Effect.catchIf(NotFoundError.isInstance, () =>
        Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
      ),
    )
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0 && !done; i--) {
      const item = next.items[i]
      if (!item) continue
      collected.push(item)
      if (retain) {
        if (item.info.id === retain) done = true
        continue
      }
      if (item.info.role === "user" && completed.has(item.info.id)) {
        const part = item.parts.find((value): value is CompactionPart => value.type === "compaction")
        if (!part) continue
        if (!part.tail_start_id) {
          done = true
          continue
        }
        retain = part.tail_start_id
        if (item.info.id === retain) done = true
        continue
      }
      if (item.info.role === "assistant" && item.info.summary && item.info.finish && !item.info.error)
        completed.add(item.info.parentID)
    }
    if (done || !next.more || !next.cursor) break
    before = next.cursor
  }
  return collected
})

/**
 * Tail-bounded [`filterCompactedEffect`]. Messages older than the retained tail
 * were discarded by the full walk anyway, so the result is identical.
 */
export const filterCompactedTail = Effect.fn("MessageV2.filterCompactedTail")(function* (sessionID: SessionID) {
  return filterCompacted(yield* collectCompactedTail(sessionID))
})

interface ReplayPosition {
  id: string
  time_created: number
}

const replayBefore = (row: ReplayPosition, boundary: ReplayPosition) =>
  row.time_created < boundary.time_created || (row.time_created === boundary.time_created && row.id < boundary.id)

/**
 * Whether one message remains in the model-visible replay view produced by
 * [`filterCompacted`], without streaming and hydrating the whole session.
 *
 * The walk phase finds the newest user compaction marker whose completed
 * summary assistant is newer than it, then follows the marker's first compaction
 * part: absent/self tail stops at the marker, a newer tail leaves history
 * whole, and an older tail stops at that message. The reorder phase then applies
 * `filterCompacted`'s final trim: for the newest retained tail-bearing marker
 * with a newer summary assistant, messages older than its tail are dropped.
 */
export const isInReplayRange = Effect.fn("MessageV2.isInReplayRange")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
}) {
  const { db } = yield* Database.Service
  const target = yield* db
    .get<ReplayPosition>(
      sql`
      SELECT id, time_created FROM message
      WHERE session_id = ${input.sessionID} AND id = ${input.messageID}
    `,
    )
    .pipe(Effect.orDie)
  if (!target) return false

  const marker = yield* db
    .get<ReplayPosition>(
      sql`
      SELECT m.id AS id, m.time_created AS time_created
      FROM message m
      WHERE m.session_id = ${input.sessionID}
        AND json_extract(m.data, '$.role') = 'user'
        AND EXISTS (
          SELECT 1 FROM part p
          WHERE p.message_id = m.id
            AND p.session_id = m.session_id
            AND json_extract(p.data, '$.type') = 'compaction'
        )
        AND EXISTS (
          SELECT 1 FROM message a
          WHERE a.session_id = m.session_id
            AND json_extract(a.data, '$.role') = 'assistant'
            AND json_extract(a.data, '$.parentID') = m.id
            AND json_extract(a.data, '$.summary') = 1
            AND json_extract(a.data, '$.finish') IS NOT NULL
            AND json_extract(a.data, '$.finish') <> ''
            AND json_extract(a.data, '$.error') IS NULL
            AND (a.time_created > m.time_created OR (a.time_created = m.time_created AND a.id > m.id))
        )
      ORDER BY m.time_created DESC, m.id DESC
      LIMIT 1
    `,
    )
    .pipe(Effect.orDie)

  let boundary: ReplayPosition | undefined
  if (marker) {
    const part = yield* db
      .get<{ tail: string | null }>(
        sql`
        SELECT json_extract(data, '$.tail_start_id') AS tail
        FROM part
        WHERE message_id = ${marker.id}
          AND session_id = ${input.sessionID}
          AND json_extract(data, '$.type') = 'compaction'
        ORDER BY id ASC
        LIMIT 1
      `,
      )
      .pipe(Effect.orDie)
    const tail = part?.tail
    if (!tail) boundary = marker
    else if (tail === marker.id) boundary = marker
    else if (typeof tail !== "string") boundary = undefined
    else {
      const anchor = yield* db
        .get<ReplayPosition>(
          sql`
          SELECT id, time_created FROM message
          WHERE session_id = ${input.sessionID} AND id = ${tail}
        `,
        )
        .pipe(Effect.orDie)
      if (!anchor || replayBefore(marker, anchor)) boundary = undefined
      else boundary = anchor
    }
  }

  const reorderMarker = yield* db
    .get<ReplayPosition>(
      sql`
      SELECT m.id AS id, m.time_created AS time_created
      FROM message m
      WHERE m.session_id = ${input.sessionID}
        AND json_extract(m.data, '$.role') = 'user'
        AND EXISTS (
          SELECT 1 FROM part p
          WHERE p.message_id = m.id
            AND p.session_id = m.session_id
            AND json_extract(p.data, '$.type') = 'compaction'
            AND json_extract(p.data, '$.tail_start_id') IS NOT NULL
            AND json_extract(p.data, '$.tail_start_id') <> ''
        )
        ${
          boundary
            ? sql`AND (m.time_created > ${boundary.time_created} OR (m.time_created = ${boundary.time_created} AND m.id >= ${boundary.id}))`
            : sql``
        }
      ORDER BY m.time_created DESC, m.id DESC
      LIMIT 1
    `,
    )
    .pipe(Effect.orDie)

  if (reorderMarker) {
    const part = yield* db
      .get<{ tail: string | null }>(
        sql`
        SELECT json_extract(data, '$.tail_start_id') AS tail
        FROM part
        WHERE message_id = ${reorderMarker.id}
          AND session_id = ${input.sessionID}
          AND json_extract(data, '$.type') = 'compaction'
          AND json_extract(data, '$.tail_start_id') IS NOT NULL
          AND json_extract(data, '$.tail_start_id') <> ''
        ORDER BY id ASC
        LIMIT 1
      `,
      )
      .pipe(Effect.orDie)
    const tail = part?.tail
    if (typeof tail === "string" && tail !== "") {
      const anchor = yield* db
        .get<ReplayPosition>(
          sql`
          SELECT id, time_created FROM message
          WHERE session_id = ${input.sessionID} AND id = ${tail}
        `,
        )
        .pipe(Effect.orDie)
      if (anchor && (!boundary || !replayBefore(anchor, boundary)) && replayBefore(anchor, reorderMarker)) {
        const summary = yield* db
          .get<{ id: string }>(
            sql`
            SELECT id FROM message
            WHERE session_id = ${input.sessionID}
              AND json_extract(data, '$.role') = 'assistant'
              AND json_extract(data, '$.parentID') = ${reorderMarker.id}
              AND json_extract(data, '$.summary') = 1
              AND (
                time_created > ${reorderMarker.time_created}
                OR (time_created = ${reorderMarker.time_created} AND id > ${reorderMarker.id})
              )
            LIMIT 1
          `,
          )
          .pipe(Effect.orDie)
        if (summary) boundary = anchor
      }
    }
  }

  if (!boundary) return true
  return !replayBefore(target, boundary)
})

/** Presentation-only user messages do not create a new model work boundary. */
export function isIgnoredUser(message: {
  info: { role: string }
  parts?: ReadonlyArray<{ type: string; ignored?: boolean }>
}) {
  return (
    message.info.role === "user" &&
    !!message.parts?.length &&
    message.parts.every((part) => part.type === "text" && part.ignored)
  )
}

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. Derive each binding by max (time.created, id)
// — time.created is the primary order because MessageIDs are not
// lexicographically ordered across the 2026-08 id-scheme boundary (historical
// pre-wrap ids sort above new ids); the id tiebreak only resolves
// same-millisecond bursts. tasks are compaction/subtask parts attached to user
// messages newer than the latest finished assistant — i.e. unprocessed work.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && (!user || before(user, info))) user = info
    if (info.role === "assistant" && (!assistant || before(assistant, info))) assistant = info
    if (info.role === "assistant" && info.finish && (!finished || before(finished, info))) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && !before(finished, m.info)
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

export function before(a: { id: string; time: { created: number } }, b: { id: string; time: { created: number } }) {
  if (a.time.created !== b.time.created) return a.time.created < b.time.created
  return a.id < b.id
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        {
          message: ctx.aborted ? e.message : SessionAbortReason.provider(e.message),
        },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: ProviderError.isRetryableResponseStreamError(e),
          metadata: {
            code: e.name,
            ...(e.kind ? { kind: e.kind } : {}),
            ...(e.closeCode !== undefined ? { closeCode: String(e.closeCode) } : {}),
            ...(e.closeReason ? { closeReason: e.closeReason } : {}),
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case isContextOverflowFailure(e):
      return new ContextOverflowError({ message: errorMessage(e) }).toObject()
    // Native runtime failures must keep their status and retryability: flattening
    // them to Unknown would bypass the shared retry dispatch table.
    case e instanceof LLMError: {
      const reason = e.reason
      if (reason._tag === "Authentication") {
        return new AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      }
      const http = "http" in reason ? reason.http : undefined
      const statusCode =
        "status" in reason && typeof reason.status === "number" ? reason.status : http?.response?.status
      const retryAfterMs = "retryAfterMs" in reason ? reason.retryAfterMs : undefined
      let headers = http?.response?.headers ? { ...http.response.headers } : undefined
      if (retryAfterMs !== undefined) {
        headers ??= {}
        headers["retry-after-ms"] ??= String(retryAfterMs)
      }
      return new APIError(
        {
          message: e.message,
          statusCode,
          isRetryable: e.retryable || e.isTimeout,
          responseHeaders: headers,
          responseBody: http?.body,
          metadata: {
            code: reason._tag,
            ...("kind" in reason && typeof reason.kind === "string" ? { kind: reason.kind } : {}),
          },
        },
        { cause: e },
      ).toObject()
    }
    case ProviderError.isReasoningStateFailure(e): {
      const diagnostics = ProviderError.reasoningStateDiagnostics(e)
      return new APIError(
        {
          message: ProviderError.REASONING_STATE_MESSAGE,
          statusCode: diagnostics.statusCode,
          isRetryable: false,
          responseHeaders: diagnostics.responseHeaders,
          responseBody:
            diagnostics.responseBody ??
            (typeof e === "string"
              ? e
              : typeof e === "object" && e !== null && !(e instanceof Error)
                ? JSON.stringify(e)
                : undefined),
        },
        { cause: e },
      ).toObject()
    }
    case Schema.is(ProviderErrorEvent)(e):
      return new APIError({ message: e.message, isRetryable: e.retryable ?? false }).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
