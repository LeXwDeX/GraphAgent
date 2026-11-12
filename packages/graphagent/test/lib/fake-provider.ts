// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { Global } from "@graphagent/core/global"
import { LLM, type StreamInput } from "@/session/llm"
import { AgentScheduler } from "@/session/agent-scheduler"
import { LLMEvent } from "@graphagent/llm"
import { Effect, Layer, Stream } from "effect"
import { markStep, touch } from "./engine-probe"

/**
 * A script returns either a fixed event list or a stream. Streams let a
 * scripted turn await real work (a tool execution) between events.
 */
export type ScriptedEvents = LLMEvent[] | Stream.Stream<LLMEvent, unknown>

/**
 * Scripted in-process LLM provider for the H0 performance scenarios.
 *
 * It replaces `LLM.Service` instead of speaking HTTP so scenarios stay
 * deterministic and free of sockets. Every request is fingerprinted from the
 * exact `StreamInput` the production engine built: tool schemas, system
 * prompt, conversation prefix and tool choice.
 */
export interface RequestFingerprint {
  readonly step: number
  readonly purpose: string
  readonly small: boolean
  readonly messageCount: number
  readonly toolsHash: string
  readonly systemHash: string
  readonly prefixHash: string
  readonly toolChoice: string
}

export interface FakeProviderOptions {
  /** Build the event script for one request. Defaults to a single text reply. */
  readonly script?: (input: StreamInput, request: RequestFingerprint) => ScriptedEvents
  /** Reply used for auxiliary requests such as title generation. */
  readonly title?: string
  /** Reply used for conversation requests. */
  readonly reply?: string
  /** Reasoning organizer the service hands out; defaults to none (distillation off). */
  readonly organizer?: LLM.Interface["organizer"]
  /**
   * Hold a process-scheduler model-stream permit for the life of every stream,
   * like the production `LLM.stream` does. The fake replaces that service, so
   * without this it would bypass the scheduler and leave its request counters at
   * zero. Each grant also records a `capacity()` snapshot (see `grants`): a
   * stream's lifetime is too short for a polling sampler to catch, and the
   * in-flight count can only rise at a grant, so the peak of these snapshots is
   * the exact peak.
   */
  readonly scheduled?: boolean
}

export function textScript(text: string, reason: "stop" | "unknown" = "stop"): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason }),
    LLMEvent.finish({ reason }),
  ]
}

export interface ToolCallRequest {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/**
 * Script one request that calls a local tool and reports its result.
 *
 * The fake provider replaces `LLM.Service`, so it must also do what the real
 * AI SDK stream does: invoke `StreamInput.tools[name].execute` and emit the
 * matching `tool-result`. Tool parts, permissions and metadata wiring all live
 * in that execute wrapper, so this drives the production path unchanged.
 */
export function toolCallScript(input: StreamInput, call: ToolCallRequest): Stream.Stream<LLMEvent, unknown> {
  const tool = input.tools[call.name]
  const request: LLMEvent[] = [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: call.id, name: call.name }),
    LLMEvent.toolInputDelta({ id: call.id, name: call.name, text: JSON.stringify(call.input) }),
    LLMEvent.toolInputEnd({ id: call.id, name: call.name }),
    LLMEvent.toolCall({ id: call.id, name: call.name, input: call.input }),
  ]
  const result = Effect.gen(function* () {
    if (!tool?.execute) return yield* Effect.die(new Error(`scripted tool ${call.name} is unavailable`))
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- scripted input is unknown by design; the tool validates it like the AI SDK path
    const execute = tool.execute as (input: unknown, options: unknown) => PromiseLike<unknown>
    const output = yield* Effect.tryPromise(() =>
      Promise.resolve(
        execute(call.input, {
          toolCallId: call.id,
          messages: input.messages,
          abortSignal: new AbortController().signal,
        }),
      ),
    )
    return [
      LLMEvent.toolResult({ id: call.id, name: call.name, result: { type: "json", value: output } }),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ] satisfies LLMEvent[]
  })
  return Stream.fromIterable(request).pipe(
    Stream.concat(Stream.fromEffect(result).pipe(Stream.flatMap((events) => Stream.fromIterable(events)))),
  )
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

// Tool descriptions may embed machine-specific global paths (the shell tool
// publishes `Global.Path.tmp`). CI runners and developer machines resolve
// different temp/config roots, so replace every resolved global path with a
// stable placeholder before hashing. Longest-first keeps nested roots (a temp
// directory inside the home directory) fully normalized.
const environmentPaths = [
  Global.Path.tmp,
  Global.Path.home,
  Global.Path.config,
  Global.Path.data,
  Global.Path.cache,
  Global.Path.state,
]
  .filter((value, index, all) => value.length > 1 && all.indexOf(value) === index)
  .sort((left, right) => right.length - left.length)

function normalizeEnvironment(value: string) {
  return environmentPaths.reduce((text, prefix) => text.split(prefix).join("<global>"), value)
}

function toolShape(tools: StreamInput["tools"]) {
  return Object.keys(tools)
    .sort()
    .map((name) => {
      const tool = tools[name] as { description?: unknown; inputSchema?: unknown }
      return normalizeEnvironment(
        `${name}:${JSON.stringify(tool?.description ?? "")}:${JSON.stringify(tool?.inputSchema ?? "")}`,
      )
    })
    .join("\n")
}

function fingerprint(input: StreamInput, step: number): RequestFingerprint {
  const purpose = input.purpose ?? (input.small ? "auxiliary" : "conversation")
  return {
    step,
    purpose,
    small: input.small === true,
    messageCount: input.messages.length,
    toolsHash: hash(toolShape(input.tools)),
    systemHash: hash(input.system.join("\n")),
    prefixHash: hash(JSON.stringify(input.messages.slice(0, 8))),
    toolChoice: input.toolChoice ?? "auto",
  }
}

export interface FakeProvider {
  readonly layer: Layer.Layer<LLM.Service>
  readonly requests: RequestFingerprint[]
  /** Scheduler snapshots taken right after each model-stream grant (`scheduled` only). */
  readonly grants: AgentScheduler.CapacitySnapshot[]
  /** Request count; feeds `settle()` activity so in-flight replies are awaited. */
  readonly activity: () => number
  reset(): void
}

export function makeFakeProvider(options?: FakeProviderOptions): FakeProvider {
  const requests: RequestFingerprint[] = []
  const grants: AgentScheduler.CapacitySnapshot[] = []
  const serve = (input: StreamInput): Stream.Stream<LLMEvent, unknown> => {
    markStep()
    const request = fingerprint(input, requests.length)
    requests.push(request)
    touch()
    const auxiliary = request.purpose === "auxiliary" || request.small
    const events: ScriptedEvents = auxiliary
      ? textScript(options?.title ?? "E2E Title")
      : (options?.script?.(input, request) ?? textScript(options?.reply ?? "ok"))
    return Array.isArray(events) ? Stream.fromIterable(events) : events
  }
  const organizer = options?.organizer ?? (() => Effect.succeed(undefined))
  const unscheduled = Layer.succeed(LLM.Service, LLM.Service.of({ organizer, stream: serve }))
  // The permit is acquired in the stream's own scope, so it is released when the
  // stream ends, fails or is interrupted (the production shape). Lane selection
  // mirrors `LLM.stream`: auxiliary purposes, child sessions, then interactive.
  const scheduled = Layer.effect(
    LLM.Service,
    Effect.gen(function* () {
      const scheduler = yield* AgentScheduler.Service
      return LLM.Service.of({
        organizer,
        stream: (input) => {
          const stream = serve(input)
          return Stream.scoped(
            Stream.unwrap(
              Effect.gen(function* () {
                yield* scheduler.request({
                  lane:
                    input.lane ??
                    (input.purpose === "auxiliary" ? "auxiliary" : input.parentSessionID ? "child" : "interactive"),
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                  sessionID: input.sessionID,
                })
                grants.push(yield* scheduler.capacity())
                // A real stream spans many scheduler turns; yielding between events
                // lets other fibers' streams overlap with this one while it holds
                // its permit, without adding wall-clock time.
                return stream.pipe(Stream.tap(() => Effect.yieldNow))
              }),
            ),
          )
        },
      })
    }),
  ).pipe(Layer.provide(AgentScheduler.defaultLayer))
  return {
    layer: options?.scheduled ? scheduled : unscheduled,
    requests,
    grants,
    activity: () => requests.length,
    reset: () => {
      requests.length = 0
      grants.length = 0
    },
  }
}
