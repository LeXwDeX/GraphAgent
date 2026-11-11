// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as MemoryModel from "./model"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { streamObject } from "ai"
import { Provider } from "@/provider/provider"
import { AgentScheduler } from "@/session/agent-scheduler"
import type { Lane } from "@/session/agent-scheduler-state"

// Liveness is judged per-part, never by a whole-call wall clock: a stream
// that keeps delivering parts is alive, however long the call runs. Two
// caveats: streamObject's fullStream DROPS reasoning-only parts (the ai SDK
// forwards text-delta/finish/error only), so a model that reasons silently
// past these windows still trips the timers — and CONNECT_TIMEOUT bounds the
// wait for the FIRST part while IDLE_TIMEOUT bounds the silence BETWEEN
// parts, re-armed by every arriving part.
const CONNECT_TIMEOUT = Duration.seconds(60)
const IDLE_TIMEOUT = Duration.seconds(60)

const JSON_HINT = "Return only a JSON object that matches the provided schema."

export interface Request {
  readonly model: Provider.Model
  readonly system: string
  readonly prompt: string
  readonly schema: Schema.Decoder<unknown>
  readonly maxOutputTokens: number
  /** Triggering session. With a scheduler available, the call takes a request permit for it. */
  readonly sessionID?: string
  /** Lane inherited from the triggering turn; auxiliary when omitted. */
  readonly lane?: Lane
}

export interface Interface {
  readonly generate: (input: Request) => Effect.Effect<unknown, ModelError>
}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()("MemoryModel.TimeoutError", {}) {
  override get message() {
    return "MEMORY model call timed out"
  }
}

const EMPTY_PROVIDER_ERROR = "(provider stream error with an empty message)"

function defectMessage(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (typeof value === "string") return value === "" ? EMPTY_PROVIDER_ERROR : value
  if (value instanceof Error) return value.message === "" ? EMPTY_PROVIDER_ERROR : value.message
  if (!isRecord(value) || depth >= 4 || seen.has(value)) return String(value)
  seen.add(value)
  if (typeof value.message === "string") return value.message === "" ? EMPTY_PROVIDER_ERROR : value.message
  for (const key of ["error", "cause", "data"] as const) {
    if (value[key] !== undefined) return defectMessage(value[key], seen, depth + 1)
  }
  return String(value)
}

export class GenerateError extends Schema.TaggedError<GenerateError>()("MemoryModel.GenerateError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    // AI SDK versions may surface a provider SSE error as either its bare
    // message or a structured { error: { message } } value. Keep an explicitly
    // empty provider message identifiable across both representations.
    return `MEMORY model call failed: ${defectMessage(this.cause)}`
  }
}

export type ModelError = TimeoutError | GenerateError | Provider.ModelNotFoundError

export class Service extends Context.Service<Service, Interface>()("@graphagent/MemoryModel") {}

export function make(input: {
  readonly execute: (request: Request) => Effect.Effect<unknown, ModelError>
  readonly timeout?: Duration.Input
}) {
  return Service.of({
    generate: Effect.fn("MemoryModel.generate")((request) => {
      const effect = input.execute(requireJsonToken(request))
      // An injected timeout (tests) stays a hard deadline; production relies on
      // the per-chunk liveness below, so an actively streaming call is never
      // killed by a wall clock.
      if (input.timeout === undefined) return effect
      return effect.pipe(
        Effect.timeoutOrElse({
          duration: input.timeout,
          orElse: () => Effect.fail(new TimeoutError()),
        }),
      )
    }),
  })
}

// Providers serving response_format json_object reject prompts that do not
// contain the literal word "json"; the maintenance prompts never mention it.
function requireJsonToken(request: Request): Request {
  if (/json/i.test(request.system) || /json/i.test(request.prompt)) return request
  return { ...request, system: `${request.system}\n${JSON_HINT}` }
}

// Signals that the stream went silent past the liveness window.
export class Stalled extends Error {}

// Drains `parts`, re-arming the idle watchdog on every part the consumer
// sees. NOTE: for streamObject that excludes reasoning-only parts (they are
// filtered out upstream), so silent reasoning does NOT count as liveness.
// Arms `connectTimeout` until the first part and `idleTimeout` between parts;
// a silent window invokes `onStall` (abort the request) and fails with
// `Stalled`, while an `errorOf` hit fails with that part's error.
export const drainWithLiveness = <T>(input: {
  parts: AsyncIterable<T>
  connectTimeout: Duration.Duration
  idleTimeout: Duration.Duration
  onStall: () => void
  errorOf: (part: T) => unknown | undefined
}) =>
  new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      action()
    }
    const arm = (duration: Duration.Duration) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () =>
          finish(() => {
            input.onStall()
            reject(new Stalled())
          }),
        Duration.toMillis(duration),
      )
    }
    arm(input.connectTimeout)
    void (async () => {
      try {
        for await (const part of input.parts) {
          arm(input.idleTimeout)
          const error = input.errorOf(part)
          if (error !== undefined) throw error
        }
        finish(resolve)
      } catch (cause) {
        finish(() => reject(cause))
      }
    })()
  })

// Providers without structured-outputs support (every openai-compatible model
// today) downgrade response_format to bare {"type":"json_object"} and never
// see the schema passed to streamObject — the model then free-styles a
// different shape every call and client-side validation always rejects
// (issue #395). The schema therefore rides in the system prompt: the draft-07
// document with every $ref inlined, since "#/definitions/..." pointers are
// meaningless to the model. Optional fields arrive as anyOf [T, null]; the
// null arm is dropped so the schema reads "provide T or omit the key",
// matching what the decoder actually accepts.
function jsonSchemaText(schema: Schema.Decoder<unknown>) {
  const root = Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({ target: "draft-07" })
  const defs = { ...recordOf(root.definitions), ...recordOf(root.$defs) }
  const walk = (node: unknown, refs: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, refs))
    if (!isRecord(node)) return node
    const ref = typeof node.$ref === "string" ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(node.$ref)?.[1] : undefined
    if (ref !== undefined) {
      if (refs.has(ref)) return {}
      return walk(defs[ref] ?? {}, new Set([...refs, ref]))
    }
    if (Array.isArray(node.anyOf) && Object.keys(node).length === 1) {
      const kept = node.anyOf.filter(isRecord).filter((arm) => arm.type !== "null")
      if (kept.length === 1) return walk(kept[0], refs)
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === "definitions" || key === "$defs" || key === "$id" || key === "$schema") continue
      out[key] = walk(value, refs)
    }
    return out
  }
  return JSON.stringify(walk(root, new Set()))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

const streamGenerate = (input: {
  language: Parameters<typeof streamObject>[0]["model"]
  system: string
  prompt: string
  schema: Schema.Decoder<unknown>
  temperature?: number
  maxOutputTokens: number
  connectTimeout: Duration.Duration
  idleTimeout: Duration.Duration
}): Effect.Effect<unknown, TimeoutError | GenerateError> => {
  const system = `${input.system}\n\nThe response must be a single JSON object that validates against this JSON Schema:\n${jsonSchemaText(input.schema)}`
  return Effect.tryPromise({
    try: (signal) =>
      (async () => {
        const controller = new AbortController()
        const forwardAbort = () => controller.abort()
        signal.addEventListener("abort", forwardAbort)
        try {
          const result = streamObject({
            model: input.language,
            system,
            prompt: input.prompt,
            schema: (() => {
              const standard = Schema.toStandardSchemaV1(input.schema)
              const json = Schema.toStandardJSONSchemaV1(input.schema)
              return {
                ...json,
                ...standard,
                "~standard": {
                  ...json["~standard"],
                  ...standard["~standard"],
                },
              }
            })(),
            temperature: input.temperature,
            maxOutputTokens: input.maxOutputTokens,
            abortSignal: controller.signal,
            onError: () => {},
          })
          await drainWithLiveness({
            parts: result.fullStream,
            connectTimeout: input.connectTimeout,
            idleTimeout: input.idleTimeout,
            onStall: () => controller.abort(),
            errorOf: (part) => (part.type === "error" ? part.error : undefined),
          })
          return await result.object
        } finally {
          signal.removeEventListener("abort", forwardAbort)
        }
      })(),
    catch: (cause) => (cause instanceof Stalled ? new TimeoutError() : new GenerateError({ cause })),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    // Optional: narrow test layers and `make`-built services keep working
    // without a scheduler, in which case calls run unscheduled.
    const scheduler = yield* Effect.serviceOption(AgentScheduler.Service)
    return make({
      execute: Effect.fnUntraced(function* (input) {
        const generate = Effect.gen(function* () {
          const language = yield* provider.getLanguage(input.model)
          return yield* streamGenerate({
            language,
            system: input.system,
            prompt: input.prompt,
            schema: input.schema,
            temperature: input.model.capabilities.temperature ? 0 : undefined,
            maxOutputTokens: input.maxOutputTokens,
            connectTimeout: CONNECT_TIMEOUT,
            idleTimeout: IDLE_TIMEOUT,
          })
        })
        const sessionID = input.sessionID
        if (Option.isNone(scheduler) || sessionID === undefined) return yield* generate
        // One permit covers the whole model call: it is released when the
        // stream ends, fails, or is interrupted, never earlier.
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* scheduler.value
              .request({
                lane: input.lane ?? "auxiliary",
                providerID: input.model.providerID,
                modelID: input.model.id,
                sessionID,
              })
              .pipe(Effect.catchTag("AgentSchedulerTimeout", (cause) => Effect.fail(new GenerateError({ cause }))))
            return yield* generate
          }),
        )
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Provider.defaultLayer), Layer.provide(AgentScheduler.defaultLayer))

export const node = LayerNode.make(layer, [Provider.node, AgentScheduler.node])
