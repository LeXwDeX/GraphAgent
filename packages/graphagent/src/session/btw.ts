// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ConfigReasoningDistillation } from "@graphagent/core/config/reasoning-distillation"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Flag } from "@graphagent/core/flag/flag"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { LLMEvent } from "@graphagent/llm"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { NotFoundError } from "@/storage/storage"
import { Cause, Context, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { randomUUID } from "node:crypto"
import { DEFAULT_MAX_CONTEXT_TOKENS, selectBtwContext } from "./btw-context"
import { LLM } from "./llm"
import { MessageID, SessionID } from "./schema"
import { Session } from "./session"
import { RuntimeSlots } from "./runtime-slots"
import { SystemPrompt } from "./system"
import BTW_PROMPT from "./prompt/btw.txt"

export const DEFAULT_TIMEOUT: Duration.Input = "120 seconds"
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_000

export class BtwInvalidRequestError extends Schema.TaggedError<BtwInvalidRequestError>()("BtwInvalidRequestError", {
  message: Schema.String,
}) {}

export class BtwSessionNotFoundError extends Schema.TaggedError<BtwSessionNotFoundError>()("BtwSessionNotFoundError", {
  sessionID: SessionID,
  message: Schema.String,
}) {}

export class BtwBusyError extends Schema.TaggedError<BtwBusyError>()("BtwBusyError", {
  sessionID: SessionID,
  message: Schema.String,
}) {}

export class BtwCancelledError extends Schema.TaggedError<BtwCancelledError>()("BtwCancelledError", {
  sessionID: SessionID,
  id: Schema.String,
  message: Schema.String,
}) {}

export class BtwTimeoutError extends Schema.TaggedError<BtwTimeoutError>()("BtwTimeoutError", {
  message: Schema.String,
}) {}

export class BtwUpstreamError extends Schema.TaggedError<BtwUpstreamError>()("BtwUpstreamError", {
  message: Schema.String,
}) {}

export type BtwError =
  | BtwInvalidRequestError
  | BtwSessionNotFoundError
  | BtwBusyError
  | BtwCancelledError
  | BtwTimeoutError
  | BtwUpstreamError

export const AskResult = Schema.Struct({
  id: Schema.String,
  answer: Schema.String,
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cacheReadTokens: Schema.optional(Schema.Number),
    }),
  ),
  context: Schema.Struct({
    messages: Schema.Number,
    estimatedTokens: Schema.Number,
    truncated: Schema.Boolean,
    inFlightDropped: Schema.Boolean,
  }),
})
export type AskResult = Schema.Schema.Type<typeof AskResult>

export interface AskInput {
  readonly sessionID: SessionID
  readonly id?: string
  readonly question: string
  readonly model?: { providerID: string; modelID: string }
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<AskResult, BtwError>
  readonly cancel: (input: { sessionID: SessionID; id: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionBtw") {}

const BTW_AGENT: Agent.Info = {
  name: "btw",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: BTW_PROMPT,
}

const MAX_QUESTION_CHARS = 8_000
const MAX_ID_CHARS = 64

const isNotFoundError = (error: unknown): error is NotFoundError => NotFoundError.isInstance(error)

interface Collected {
  readonly text: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadInputTokens?: number
  }
}

type InFlight = {
  readonly id: string
  readonly ready: Deferred.Deferred<Fiber.Fiber<Collected, unknown> | undefined>
}

export interface LayerOptions {
  /** Injectable for tests; production uses 120 seconds. */
  readonly timeout?: Duration.Input
  /** Upper bound on the side-question context budget. */
  readonly maxContextTokens?: number
  /** Upper bound on the answer length. */
  readonly maxOutputTokens?: number
}

export const layer = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const config = yield* Config.Service
      const llm = yield* LLM.Service
      const systemPrompt = yield* SystemPrompt.Service

      const inFlight = new Map<SessionID, InFlight>()

      const unregister = (sessionID: SessionID, id: string) =>
        Effect.sync(() => {
          if (inFlight.get(sessionID)?.id === id) inFlight.delete(sessionID)
        })

      /** `provider/model`, exactly one slash and both segments non-empty. */
      const parseConfiguredModel = (value: string) => {
        const segments = value.split("/")
        if (segments.length !== 2 || segments[0].length === 0 || segments[1].length === 0) return undefined
        return { providerID: segments[0], modelID: segments[1] }
      }

      const resolveModel = Effect.fn("SessionBtw.resolveModel")(function* (input: {
        session: Session.Info
        messages: SessionV1.WithParts[]
        requested: AskInput["model"]
        configured: string | undefined
      }) {
        let ref: { providerID: string; modelID: string } | undefined = input.requested
        if (!ref && input.configured !== undefined) {
          const parsed = parseConfiguredModel(input.configured)
          if (!parsed) {
            return yield* new BtwInvalidRequestError({
              message: `Configured side question model "${input.configured}" must be in the format provider/model.`,
            })
          }
          ref = parsed
        }
        if (!ref && input.session.model) {
          ref = { providerID: input.session.model.providerID, modelID: input.session.model.id }
        }
        if (!ref) {
          for (const msg of input.messages) {
            if (msg.info.role !== "user" || !msg.info.model) continue
            ref = { providerID: msg.info.model.providerID, modelID: msg.info.model.modelID }
          }
        }
        if (!ref) {
          const fallback = yield* provider
            .defaultModel()
            .pipe(Effect.mapError((error) => new BtwInvalidRequestError({ message: error.message })))
          ref = { providerID: fallback.providerID, modelID: fallback.modelID }
        }
        return yield* provider
          .getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID))
          .pipe(
            Effect.catchTag("ProviderModelNotFoundError", (error) =>
              Effect.fail(new BtwInvalidRequestError({ message: error.message })),
            ),
          )
      })

      const ask = Effect.fn("SessionBtw.ask")(function* (input: AskInput) {
        const question = input.question.trim()
        if (question.length === 0 || question.length > MAX_QUESTION_CHARS) {
          return yield* new BtwInvalidRequestError({
            message: `Question must be non-empty and at most ${MAX_QUESTION_CHARS} characters.`,
          })
        }
        if (input.id !== undefined && (input.id.length === 0 || input.id.length > MAX_ID_CHARS)) {
          return yield* new BtwInvalidRequestError({
            message: `Side-question id must be non-empty and at most ${MAX_ID_CHARS} characters.`,
          })
        }

        const session = yield* sessions
          .get(input.sessionID)
          .pipe(
            Effect.catchIf(isNotFoundError, (error) =>
              Effect.fail(new BtwSessionNotFoundError({ sessionID: input.sessionID, message: error.message })),
            ),
          )
        const messages = yield* sessions
          .messages({ sessionID: input.sessionID })
          .pipe(
            Effect.catchIf(isNotFoundError, (error) =>
              Effect.fail(new BtwSessionNotFoundError({ sessionID: input.sessionID, message: error.message })),
            ),
          )

        const cfg = yield* config.get()
        const model = yield* resolveModel({
          session,
          messages,
          requested: input.model,
          configured: cfg.btw?.model,
        })
        const reasoningDistillationEnabled = ConfigReasoningDistillation.resolveEnabled({
          disabledByEnvironment: Flag.GRAPHAGENT_DISABLE_REASONING_DISTILLATION,
          enabled: cfg.reasoningDistillation?.enabled,
          modelEnabled: cfg.provider?.[model.providerID]?.models?.[model.id]?.reasoningDistillation?.enabled,
        }).enabled

        const selected = yield* selectBtwContext({
          history: messages,
          revert: session.revert,
          model,
          cfg,
          question,
          reasoningDistillationEnabled,
          maxContextTokens: options.maxContextTokens ?? cfg.btw?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
        })

        const language = yield* systemPrompt.language(cfg.language)
        const environment = (yield* systemPrompt.environment(model))[0]
        // A side question is a one-shot request: it has no cache prefix to
        // protect, so the directory and date stay in its system text. The main
        // loop carries them in runtime-context slots instead.
        const ctx = yield* InstanceState.context
        const slots = [
          RuntimeSlots.environment({ directory: ctx.directory, root: ctx.root, git: ctx.project.vcs === "git" }),
          RuntimeSlots.date(yield* DateTime.nowAsDate),
        ].flatMap((slot) => slot.parts)
        const system = [...language, ...(environment === undefined ? [] : [environment]), ...slots]

        const id = input.id ?? randomUUID()
        const btwSessionID = SessionID.descending()
        const user: SessionV1.User = {
          id: MessageID.ascending(),
          sessionID: btwSessionID,
          role: "user",
          time: { created: Date.now() },
          agent: BTW_AGENT.name,
          model: { providerID: model.providerID, modelID: model.id },
        }

        const work = llm
          .stream({
            agent: BTW_AGENT,
            user,
            system,
            small: false,
            tools: {},
            model,
            sessionID: btwSessionID,
            retries: 1,
            messages: selected.messages,
            purpose: "auxiliary",
            maxOutputTokens: options.maxOutputTokens ?? cfg.btw?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            onThinkingInvalidated: () => Effect.void,
          })
          .pipe(
            Stream.runFold(
              () => ({ text: "", usage: undefined }) as Collected,
              (acc, event): Collected => ({
                text: LLMEvent.is.textDelta(event) ? acc.text + event.text : acc.text,
                usage: "usage" in event && event.usage !== undefined ? event.usage : acc.usage,
              }),
            ),
          )

        const ready = yield* Deferred.make<Fiber.Fiber<Collected, unknown> | undefined>()
        const registered = yield* Effect.sync(() => {
          if (inFlight.has(input.sessionID)) return false
          inFlight.set(input.sessionID, { id, ready })
          return true
        })
        if (!registered) {
          return yield* new BtwBusyError({
            sessionID: input.sessionID,
            message: `Another side question is already running for session ${input.sessionID}.`,
          })
        }

        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(work.pipe(Effect.ensuring(unregister(input.sessionID, id))))
            yield* Deferred.succeed(ready, fiber)
            return yield* Fiber.await(fiber)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* unregister(input.sessionID, id)
                yield* Deferred.succeed(ready, undefined)
              }),
            ),
          ),
        ).pipe(
          Effect.timeoutOrElse({
            duration: options.timeout ?? DEFAULT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new BtwTimeoutError({
                  message: "Side question timed out.",
                }),
              ),
          }),
        )

        if (Exit.isFailure(outcome)) {
          if (Exit.hasInterrupts(outcome)) {
            return yield* new BtwCancelledError({
              sessionID: input.sessionID,
              id,
              message: "Side question was cancelled.",
            })
          }
          return yield* new BtwUpstreamError({ message: Cause.pretty(outcome.cause) })
        }

        const collected = outcome.value
        const answer = collected.text.trim()
        if (answer.length === 0) {
          return yield* new BtwUpstreamError({ message: "The model returned no text." })
        }

        return {
          id,
          answer,
          model: { providerID: model.providerID, modelID: model.id },
          usage: collected.usage
            ? {
                inputTokens: collected.usage.inputTokens ?? 0,
                outputTokens: collected.usage.outputTokens ?? 0,
                ...(collected.usage.cacheReadInputTokens === undefined
                  ? {}
                  : { cacheReadTokens: collected.usage.cacheReadInputTokens }),
              }
            : undefined,
          context: {
            messages: selected.messages.length,
            estimatedTokens: selected.estimatedTokens,
            truncated: selected.truncated,
            inFlightDropped: selected.inFlightDropped,
          },
        } satisfies AskResult
      })

      const cancel = Effect.fn("SessionBtw.cancel")(function* (input: { sessionID: SessionID; id: string }) {
        const entry = inFlight.get(input.sessionID)
        if (!entry || entry.id !== input.id) return false
        const fiber = yield* Deferred.await(entry.ready)
        if (!fiber) return false
        yield* Fiber.interrupt(fiber)
        return true
      })

      return Service.of({ ask, cancel })
    }),
  )

export const defaultLayer = Layer.suspend(() =>
  layer().pipe(
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
  ),
)

export const node = LayerNode.make(layer(), [Session.node, Provider.node, Config.node, LLM.node, SystemPrompt.node])

export * as SessionBtw from "./btw"
