import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { and, eq, gt, or } from "drizzle-orm"
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
import type { SessionID } from "./schema"

/** A normal adoption rejection. Database/schema defects are not wrapped and must propagate. */
class AdoptionRejected extends Error {}
const reject = (reason: string) => Effect.die(new AdoptionRejected(reason))
const expectedRejection = (cause: Cause.Cause<unknown>) =>
  cause.reasons.every((reason) => Cause.isDieReason(reason) && reason.defect instanceof AdoptionRejected)

/**
 * Commit one accepted rewrite of a settled reasoning part, and its v2 mirror when present. Validation runs inside the
 * event transaction: the job must still be adoptable (not sealed by a send barrier, feature enabled), the session must
 * not be reverted, no later assistant attempt may exist, and the persisted part (and mirror) must be exactly the
 * organized source. Returns the adopted part.
 */
export const adoptReasoning = Effect.fn("Session.adoptReasoning")(function* (input: {
  sessionID: SessionID
  part: SessionV1.ReasoningPart
  replacement: ReasoningReplacement
  canAdopt: Effect.Effect<boolean>
}) {
  const session = yield* Session.Service
  const events = yield* EventV2Bridge.Service
  const { db } = yield* Database.Service
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
    // Durable send fence: the in-memory barrier only covers this process. The prompt loop persists each attempt's
    // assistant message before it re-reads this part for the request, so once any process has persisted a later
    // attempt the part is never rewritten, and an adoption committed before that claim is in its request.
    const own = yield* db
      .select({ time: MessageTable.time_created })
      .from(MessageTable)
      .where(and(eq(MessageTable.id, part.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get()
      .pipe(Effect.orDie)
    if (!own) yield* Effect.die("reasoning source message was removed")
    const later = own
      ? yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, input.sessionID),
              or(
                gt(MessageTable.time_created, own.time),
                and(eq(MessageTable.time_created, own.time), gt(MessageTable.id, part.messageID)),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
      : []
    if (later.some((row) => row.data.role === "assistant"))
      yield* reject("reasoning was already resent by a later attempt")
    const current = yield* session.getPart({ sessionID: input.sessionID, messageID: part.messageID, partID: part.id })
    if (!isDeepStrictEqual(current, part)) yield* reject("stale reasoning adoption")
    if (!part.v2) return
    // The core/V2 runner persists attempts in SessionMessageTable instead of MessageTable. Mixed runners must see
    // those attempts too, otherwise a V1 adoption can rewrite a part the V2 request already sent. An earlier
    // continuation of the same assistant turn may already own a V2 row, but that attempt cannot have carried this
    // part, so the part's own attempt is the send boundary rather than its V1 message's creation time. The
    // per-session seq orders attempts: producer clocks and ids are not comparable across processes.
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, SessionMessage.ID.make(part.v2.messageID)))
      .get()
      .pipe(Effect.orDie)
    const laterMirrored = row
      ? yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              eq(SessionMessageTable.type, "assistant"),
              gt(SessionMessageTable.seq, row.seq),
            ),
          )
          .limit(1)
          .all()
          .pipe(Effect.orDie)
      : []
    if (laterMirrored.length > 0) yield* reject("reasoning was already resent by a later mirrored attempt")
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
      (cause) => !Cause.hasInterrupts(cause) && (!Cause.hasDies(cause) || expectedRejection(cause)),
      () => Effect.logInfo("reasoning adoption rejected; retaining current history").pipe(Effect.as(undefined)),
    ),
  )
})
