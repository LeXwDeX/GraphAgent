import { Database } from "@opencode-ai/core/database/database"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import {
  adoptionProvenance,
  type ReasoningReplacement,
} from "@opencode-ai/core/session/reasoning-distillation/adoption"
import { replaceCanonicalReasoning } from "@opencode-ai/core/session/reasoning-distillation/canonical"
import { assessRewriteControl } from "@opencode-ai/core/session/reasoning-distillation/control-markup"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"

const reject = (reason: string) => Effect.die(new Error(reason))

/** Atomically validate the current source and its mirror before publishing a completed background rewrite. */
export const adoptReasoning = Effect.fn("Session.adoptReasoning")(function* (input: {
  sessionID: SessionID
  part: SessionV1.ReasoningPart
  replacement: ReasoningReplacement
  canAdopt: Effect.Effect<boolean>
}) {
  const session = yield* Session.Service
  const events = yield* EventV2Bridge.Service
  const database = yield* Database.Service
  const { db } = database
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
  if (part.v2)
    entries.push({
      definition: SessionEvent.Reasoning.Ended,
      data: {
        sessionID: input.sessionID,
        assistantMessageID: SessionMessage.ID.make(part.v2.messageID),
        reasoningID: part.v2.reasoningID,
        text: edited.text,
        providerMetadata: edited.metadata,
        distillation,
        timestamp: DateTime.makeUnsafe(Date.now()),
      },
    })
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
    if (!part.v2) return
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, SessionMessage.ID.make(part.v2.messageID)))
      .get()
      .pipe(Effect.orDie)
    const message = row
      ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
          Effect.orDie,
        )
      : undefined
    const content = message?.type === "assistant" ? message.content : []
    const matches = content.filter((item) => item.id === part.v2?.reasoningID)
    if (
      row?.session_id !== input.sessionID ||
      matches.length !== 1 ||
      matches[0].type !== "reasoning" ||
      matches[0].text !== part.text ||
      matches[0].distillation ||
      !isDeepStrictEqual(matches[0].providerMetadata, part.metadata)
    )
      yield* reject("stale mirrored reasoning adoption")
  })
  return yield* events.publishMany(entries, { validate }).pipe(
    Effect.as<SessionV1.ReasoningPart | undefined>(adopted),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.logInfo("reasoning adoption rejected; retaining current history").pipe(Effect.as(undefined)),
    ),
  )
})
