import { SessionAttention } from "@/notification/attention"
/**
 * MCP elicitation adapter (spec rev with form + url modes; this change
 * implements the flat-primitive form-mode subset).
 *
 * Lives in the MCP module because it owns the protocol edge. Resolves Question,
 * SettingsHook, and Notification via `Effect.serviceOption` so MCP layers stay
 * self-contained (AGENTS.md invariant). Session routing uses the actual client
 * binding held for the outstanding MCP tool call; with no session or no
 * Question service the adapter declines immediately — it never hangs the server.
 *
 * Lifecycle:
 *   elicitation/create ─▶ build Question request from requestedSchema
 *                          ─▶ fire Elicitation hook (blocking hook deny → decline, no surface)
 *                          ─▶ route through Notification emitter (type "elicitation_dialog")
 *                          ─▶ Question.ask (blocks until reply/reject/timeout)
 *   user reply ─▶ validate ─▶ accept+content / decline
 *   user dismissal ─▶ cancel; timeout / no-context ─▶ decline
 *   ─▶ fire ElicitationResult hook (result | cancelled)
 *   ─▶ respond to server
 */
import { Effect, Option } from "effect"
import type { Client } from "@modelcontextprotocol/client"
import { consumerContext } from "@/hook/consumer-context"
import { Question } from "@/question"
import { SettingsHook, type TriggerResult } from "@/hook/settings"
import { Notification } from "@/notification"
import { clientElicitationBinding, withClientReverseRequest } from "./elicitation-binding"
import { SessionID } from "@/session/schema"

/** Hard cap on how long an elicitation waits for a user answer. */
const ELICITATION_TIMEOUT_MS = 300_000

export type ElicitAction = "accept" | "decline" | "cancel"
export interface ElicitResponse {
  action: ElicitAction
  content?: Record<string, string | number | boolean | string[]>
}

function responseContent(input: Record<string, unknown>): ElicitResponse["content"] {
  const content: NonNullable<ElicitResponse["content"]> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") content[key] = value
    else if (Array.isArray(value) && value.every((item): item is string => typeof item === "string"))
      content[key] = value
    else return undefined
  }
  return content
}
function hookResponse(input: { action: ElicitAction; content?: Record<string, unknown> }): ElicitResponse {
  if (input.content === undefined) return { action: input.action }
  const content = responseContent(input.content)
  return content === undefined ? { action: "decline" } : { action: input.action, content }
}

/**
 * A single flat-primitive property from the requested schema, after validation
 * that the schema is conforming. Non-conforming properties (nested objects,
 * arrays, url-mode) cause the whole elicitation to be rejected.
 */
interface FieldSpec {
  name: string
  description?: string
  kind: "enum" | "boolean" | "string" | "number" | "integer"
  enumValues?: string[]
}

/**
 * Classify a requested-schema property into a FieldSpec, or return a rejection
 * reason. MCP form-mode allows flat objects whose properties are primitive
 * string/number/integer/boolean, optionally with an enum.
 */
export function classifyProperty(name: string, prop: unknown): { field: FieldSpec } | { reject: string } {
  if (typeof prop !== "object" || prop === null || Array.isArray(prop))
    return { reject: `property "${name}" must be an object` }
  const p = prop as Record<string, unknown>
  const type = p.type
  // enum (string enum) → options
  if (Array.isArray(p.enum)) {
    const enumValues = p.enum.filter((v): v is string => typeof v === "string")
    if (enumValues.length !== p.enum.length) return { reject: `property "${name}" enum must be all strings` }
    return {
      field: {
        name,
        description: typeof p.description === "string" ? p.description : undefined,
        kind: "enum",
        enumValues,
      },
    }
  }
  if (type === "boolean") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "boolean" },
    }
  }
  if (type === "string") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "string" },
    }
  }
  if (type === "number") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "number" },
    }
  }
  if (type === "integer") {
    return {
      field: { name, description: typeof p.description === "string" ? p.description : undefined, kind: "integer" },
    }
  }
  return { reject: `property "${name}" type "${String(type)}" not supported (flat primitives only)` }
}

/**
 * Map a flat-primitive requestedSchema into Question `Info[]` (one per field),
 * or reject the whole schema. Exposed for unit testing.
 */
export function schemaToQuestions(
  message: string,
  requestedSchema: unknown,
): { questions: Question.Info[] } | { reject: string } {
  if (typeof requestedSchema !== "object" || requestedSchema === null)
    return { reject: "requestedSchema must be an object" }
  const schema = requestedSchema as Record<string, unknown>
  if (schema.type !== "object") return { reject: "requestedSchema must be type 'object'" }
  const properties = schema.properties
  if (typeof properties !== "object" || properties === null || Array.isArray(properties))
    return { reject: "requestedSchema.properties must be an object" }

  const fields: FieldSpec[] = []
  for (const [name, prop] of Object.entries(properties as Record<string, unknown>)) {
    const result = classifyProperty(name, prop)
    if ("reject" in result) return result
    fields.push(result.field)
  }

  const QuestionV1Info = Question.Info
  const questions = fields.map((field) => {
    if (field.kind === "enum") {
      return QuestionV1Info.make({
        question: field.description ?? `${field.name}: ${field.enumValues!.join(" | ")}`,
        header: field.name,
        options: field.enumValues!.map((value) => Question.Option.make({ label: value, description: value })),
        multiple: undefined,
        custom: false,
      })
    }
    if (field.kind === "boolean") {
      return QuestionV1Info.make({
        question: field.description ?? `${field.name}?`,
        header: field.name,
        options: [
          Question.Option.make({ label: "Yes", description: "true" }),
          Question.Option.make({ label: "No", description: "false" }),
        ],
        multiple: undefined,
        custom: false,
      })
    }
    // string / number → free-text input
    return QuestionV1Info.make({
      question: field.description ?? `${field.name} (${field.kind})`,
      header: field.name,
      options: [],
      multiple: undefined,
      custom: true,
    })
  })
  return { questions }
}

/**
 * Validate a set of answers (arrays of selected labels, one per field) against
 * the field specs, coercing to the MCP content shape. Returns the structured
 * content on success, or undefined if any answer is invalid (→ decline).
 * Exposed for unit testing.
 */
export function validateAndCoerce(
  fields: FieldSpec[],
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string | number | boolean> | undefined {
  const content: Record<string, string | number | boolean> = {}
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const answer = answers[i] ?? []
    if (field.kind === "enum") {
      // single-select; take first selected label, must be in enum
      const selected = answer[0]
      if (!selected || !field.enumValues!.includes(selected)) return undefined
      content[field.name] = selected
    } else if (field.kind === "boolean") {
      const selected = answer[0]
      if (selected === "Yes") content[field.name] = true
      else if (selected === "No") content[field.name] = false
      else return undefined
    } else if (field.kind === "string") {
      const selected = answer[0]
      if (typeof selected !== "string") return undefined
      content[field.name] = selected
    } else {
      // number / integer
      const selected = answer[0]
      if (typeof selected !== "string") return undefined
      const num = Number(selected)
      if (!Number.isFinite(num)) return undefined
      if (field.kind === "integer" && !Number.isInteger(num)) return undefined
      content[field.name] = num
    }
  }
  return content
}

/** Re-derive FieldSpec[] from a requestedSchema for use by validateAndCoerce. */
export function fieldSpecsFromSchema(requestedSchema: unknown): FieldSpec[] {
  const schema = requestedSchema as { properties?: Record<string, unknown> }
  const properties = schema.properties ?? {}
  const fields: FieldSpec[] = []
  for (const [name, prop] of Object.entries(properties as Record<string, unknown>)) {
    const result = classifyProperty(name, prop)
    if ("field" in result) fields.push(result.field)
  }
  return fields
}

/**
 * The Effect that handles one elicitation/create request. Pure of protocol I/O:
 * returns an ElicitResponse the caller (a Promise wrapper) sends to the server.
 *
 * `deps` carried by the ambient context (Question, SettingsHook, Notification
 * all resolved via serviceOption); absent services cause safe decline.
 */
export const handleElicitation = Effect.fn("MCP.elicitation.handle")(function* (input: {
  message: string
  requestedSchema: unknown
  mode?: string
  serverName?: string
  url?: string
  elicitationID?: string
  /**
   * The session bound to this actual MCP client call. Undefined → decline.
   */
  sessionID?: string
}) {
  const question = Option.getOrUndefined(yield* Effect.serviceOption(Question.Service))
  const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
  const notification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
  const sessionID = input.sessionID

  if (!sessionID) return { action: "decline" } satisfies ElicitResponse

  // Elicitation hook fires before surfacing. A blocking deny short-circuits to
  // decline without surfacing the Question.
  if (settingsHook) {
    const hookResult = yield* settingsHook
      .trigger(
        {
          event: "Elicitation",
          serverName: input.serverName,
          message: input.message,
          requestedSchema: input.requestedSchema,
          mode: input.mode === "url" ? "url" : input.mode === "form" ? "form" : undefined,
          url: input.url,
          elicitationID: input.elicitationID,
        },
        yield* consumerContext(sessionID).pipe(Effect.orDie),
      )
      .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
    if (hookResult.blocked) {
      yield* Effect.logWarning("elicitation declined: hook blocked")
      return { action: "decline" } satisfies ElicitResponse
    }
    if (hookResult.elicitation) return hookResponse(hookResult.elicitation)
  }

  // Hook answers do not need a Question UI (including URL-mode requests).
  if (!question || (input.mode !== undefined && input.mode !== "form"))
    return { action: "decline" } satisfies ElicitResponse
  const mapped = schemaToQuestions(input.message, input.requestedSchema)
  if ("reject" in mapped) return { action: "decline" } satisfies ElicitResponse

  // Dismissing the dialog is cancellation, not an explicit decline.
  const fields = fieldSpecsFromSchema(input.requestedSchema)
  let response: ElicitResponse = yield* Effect.scoped(
    Effect.gen(function* () {
      const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
      if (notification)
        yield* (attention ? attention.quiet(sessionID, 6_000) : Effect.sleep("6 seconds")).pipe(
          Effect.andThen(
            notification.notify({
              message: "MCP elicitation requires a response",
              notificationType: "elicitation_dialog",
              sessionID,
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        )
      return yield* question.ask({ sessionID: SessionID.make(sessionID), questions: mapped.questions }).pipe(
        Effect.timeoutOption(ELICITATION_TIMEOUT_MS),
        Effect.map((opt): ElicitResponse => {
          const content = Option.isNone(opt) ? undefined : validateAndCoerce(fields, opt.value)
          return content === undefined ? { action: "decline" } : { action: "accept", content }
        }),
        Effect.catch((error) =>
          Effect.succeed<ElicitResponse>({
            action: error._tag === "QuestionRejectedError" ? "cancel" : "decline",
          }),
        ),
      )
    }),
  )

  // The result hook replaces the whole response content. Cancel preserves the
  // submitted values; decline deliberately withholds them.
  if (settingsHook) {
    const erResult = yield* settingsHook
      .trigger(
        {
          event: "ElicitationResult",
          serverName: input.serverName,
          action: response.action,
          content: response.content,
          mode: input.mode,
          elicitationID: input.elicitationID,
        },
        yield* consumerContext(sessionID).pipe(Effect.orDie),
      )
      .pipe(Effect.catch(() => Effect.succeed<TriggerResult>({ additionalContexts: [], systemMessages: [] })))
    yield* SettingsHook.landSystemMessages(erResult, { sessionID })
    if (erResult.blocked) response = { action: "decline" }
    else if (erResult.elicitation) {
      const replacement = erResult.elicitation
      response =
        replacement.action === "decline"
          ? { action: "decline" }
          : replacement.action === "cancel"
            ? { action: "cancel", ...(response.content ? { content: response.content } : {}) }
            : hookResponse(replacement)
    }
  }
  return response
})

/**
 * Register the elicitation handler on a connected MCP client. The handler is a
 * plain async function (Promise-returning) that bridges into the Effect world.
 */
export function registerElicitationHandler(
  client: Client,
  bridge: import("@/effect/bridge").EffectBridge.Shape,
  serverName?: string,
) {
  // The handler receives the full JSON-RPC request `{ method, params: {...} }`;
  // the elicitation fields live under `params`. On 2026-era connections the
  // client drives input_required retries through this same handler.
  const handler = async (
    request: {
      params?: { message?: string; requestedSchema?: unknown; mode?: string; url?: string; elicitationId?: string }
    },
    context?: { mcpReq?: { signal?: AbortSignal } },
  ) => {
    const binding = clientElicitationBinding(client)
    // Never guess a session from another client's/global most recent call.
    if (!binding?.sessionID || binding.inHook) return { action: "decline" } satisfies ElicitResponse
    const params = request.params ?? {}
    const signal = context?.mcpReq?.signal
      ? AbortSignal.any([binding.controller.signal, context.mcpReq.signal])
      : binding.controller.signal
    return withClientReverseRequest(client, () =>
      bridge.promise(
        handleElicitation({
          message: params.message ?? "",
          requestedSchema: params.requestedSchema,
          mode: params.mode,
          url: params.url,
          elicitationID: params.elicitationId,
          serverName,
          sessionID: binding.sessionID,
        }).pipe(
          Effect.tap((response) =>
            Effect.gen(function* () {
              const notification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
              if (notification)
                yield* notification.notify({
                  sessionID: binding.sessionID,
                  notificationType: "elicitation_response",
                  message: `MCP elicitation response sent: ${response.action}`,
                })
            }),
          ),
          Effect.raceFirst(
            Effect.callback<never>((resume) => {
              const abort = () => resume(Effect.interrupt)
              signal.addEventListener("abort", abort, { once: true })
              if (signal.aborted) abort()
              return Effect.sync(() => signal.removeEventListener("abort", abort))
            }),
          ),
        ),
      ),
    )
  }
  client.setRequestHandler("elicitation/create", handler as never)
}
