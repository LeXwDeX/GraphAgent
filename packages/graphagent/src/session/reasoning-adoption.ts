import { Database } from "@graphagent/core/database/database"
import { Cause, Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EventV2 } from "@graphagent/core/event"
import { SessionV1 } from "@graphagent/core/v1/session"
import {
  adoptionProvenance,
  type ReasoningReplacement,
} from "@graphagent/core/session/reasoning-distillation/adoption"
import { replaceCanonicalReasoning } from "@graphagent/core/session/reasoning-distillation/canonical"
import { assessRewriteControl } from "@graphagent/core/session/reasoning-distillation/control-markup"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"

const reject = (reason: string) => Effect.die(new Error(reason))

/** Atomically validate the persisted source before publishing a completed background rewrite. */
export const adoptReasoning = Effect.fn("Session.adoptReasoning")(function* (input: {
  sessionID: SessionID
  part: SessionV1.ReasoningPart
  replacement: ReasoningReplacement
  canAdopt: Effect.Effect<boolean>
}) {
  const session = yield* Session.Service
  const events = yield* EventV2Bridge.Service
  const database = yield* Database.Service
  const { part, replacement } = input
  if (
    part.sessionID !== input.sessionID ||
    replacement.messageID !== part.messageID ||
    replacement.partID !== part.id ||
    part.text !== replacement.before ||
    part.time.end === undefined ||
    part.distillation ||
    replacement.after.trim() === "" ||
    replacement.after === replacement.before
  )
    return undefined
  const control = assessRewriteControl(part.text, replacement.after)
  if (control) {
    yield* Effect.logInfo("reasoning adoption rejected; retaining current history", {
      "reasoning_distillation.reason": control,
    })
    return undefined
  }
  const source = { text: part.text, metadata: part.metadata, settled: true, distilled: false }
  const edited = replaceCanonicalReasoning(source, replacement.after)
  if (!edited) return undefined
  const distillation = adoptionProvenance(source)
  const adopted: SessionV1.ReasoningPart = { ...part, text: edited.text, metadata: edited.metadata, distillation }
  const entries: EventV2.BatchEvent[] = [
    {
      definition: SessionV1.Event.PartUpdated,
      data: { sessionID: input.sessionID, part: adopted, time: Date.now() },
    },
  ]
  const validate = Effect.gen(function* () {
    if (!(yield* input.canAdopt)) yield* reject("reasoning rewrite was sealed or disabled")
    const currentSession = yield* session.get(input.sessionID).pipe(Effect.orDie)
    if (currentSession.revert) yield* reject("reasoning source was reverted")
    const replay = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
      Effect.provideService(Database.Service, database),
    )
    if (!replay.some((message) => message.info.id === part.messageID))
      yield* reject("reasoning source is outside the replay range")
    const current = yield* session.getPart({ sessionID: input.sessionID, messageID: part.messageID, partID: part.id })
    if (!isDeepStrictEqual(current, part)) yield* reject("stale reasoning adoption")
  })
  return yield* events.publishMany(entries, { validate }).pipe(
    Effect.as<SessionV1.ReasoningPart | undefined>(adopted),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.logInfo("reasoning adoption rejected; retaining current history").pipe(Effect.as(undefined)),
    ),
  )
})
