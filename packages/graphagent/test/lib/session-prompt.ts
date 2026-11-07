import { Cause, Effect, Option } from "effect"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export function withIdleAdmission<Error, Value extends object>(
  service: Value & {
    readonly promptIfIdle: (
      input: SessionPrompt.PromptInput,
    ) => Effect.Effect<Option.Option<SessionV1.WithParts>, Error>
  },
) {
  return {
    ...service,
    withIdle: <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const status = yield* Effect.serviceOption(SessionStatus.Service)
        if (Option.isSome(status) && (yield* status.value.get(sessionID)).type !== "idle") return Option.none<A>()
        return Option.some(yield* work)
      }),
    prepareIfIdle: (input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
      Effect.as(
        persistAdmission ?? Effect.void,
        Option.some({
          activate: Effect.void,
          result: Effect.suspend(() => service.promptIfIdle(input)).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.die(Cause.squash(cause)),
            ),
          ),
          abort: Effect.void,
        }),
      ),
  }
}
