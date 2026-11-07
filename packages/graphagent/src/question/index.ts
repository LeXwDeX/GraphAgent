import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Deferred, Effect, Layer, Schema, Context, Option as EffectOption } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { Config } from "@/config/config"

export const DEFAULT_TIMEOUT_SECONDS = 60
export const MAX_RESPONSE_PHASE_SECONDS = 300
const DEADLINE_RECHECK_MILLIS = 1_000

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedError<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class TimedOutError extends Schema.TaggedError<TimedOutError>()("QuestionTimedOutError", {}) {
  override get message() {
    return "The user is temporarily away"
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
  deadline: number
  readonly inactivityTimeoutMs: number
  maximumDeadline?: number
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError | TimedOutError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly interact: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = EffectOption.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Question.ask")(
      (input: { sessionID: SessionID; questions: ReadonlyArray<Info>; tool?: Tool }) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const pending = (yield* InstanceState.get(state)).pending
            const id = QuestionID.ascending()
            const timeoutSeconds = config
              ? ((yield* config.get()).question_timeout ?? DEFAULT_TIMEOUT_SECONDS)
              : DEFAULT_TIMEOUT_SECONDS
            const now = yield* Clock.currentTimeMillis
            const expiresAt = now + timeoutSeconds * 1_000
            yield* Effect.logInfo("asking", { id, questions: input.questions.length })

            const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
            const info: Request = {
              id,
              sessionID: input.sessionID,
              questions: input.questions,
              tool: input.tool,
              expiresAt,
            }
            const entry: PendingEntry = {
              info,
              deferred,
              deadline: expiresAt,
              inactivityTimeoutMs: timeoutSeconds * 1_000,
            }
            pending.set(id, entry)
            return yield* events.publish(Event.Asked, info).pipe(
              Effect.andThen(
                restore(
                  Effect.raceFirst(
                    Deferred.await(deferred),
                    Effect.gen(function* () {
                      for (;;) {
                        const current = yield* Clock.currentTimeMillis
                        yield* Effect.sleep(Math.min(DEADLINE_RECHECK_MILLIS, Math.max(0, entry.deadline - current)))
                        const timedOut = yield* Effect.uninterruptible(
                          Effect.gen(function* () {
                            if (pending.get(id) !== entry) return false
                            if ((yield* Clock.currentTimeMillis) < entry.deadline) return false
                            pending.delete(id)
                            yield* events.publish(Event.TimedOut, { sessionID: info.sessionID, requestID: id })
                            return true
                          }),
                        )
                        if (timedOut) return yield* new TimedOutError()
                        if (pending.get(id) !== entry) return yield* Effect.never
                      }
                    }),
                  ),
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(id)
                }),
              ),
            )
          }),
        ),
    )

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        yield* new NotFoundError({ requestID: input.requestID })
        return
      }
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        yield* new NotFoundError({ requestID })
        return
      }
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const interact = Effect.fn("Question.interact")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* new NotFoundError({ requestID })
        return
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= existing.deadline) return yield* new NotFoundError({ requestID })
      existing.maximumDeadline ??= now + MAX_RESPONSE_PHASE_SECONDS * 1_000
      existing.deadline = Math.min(now + existing.inactivityTimeoutMs, existing.maximumDeadline)
      if (existing.info.expiresAt === undefined) return
      existing.info = { ...existing.info, expiresAt: undefined }
      yield* events.publish(Event.Interacted, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, reject, interact, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Config.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, Config.node])

export * as Question from "."
