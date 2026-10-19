import { Cause, DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { eq } from "drizzle-orm"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { latestCompaction } from "../history"
import { SessionSchema } from "../schema"
import { SessionMessageTable, SessionTable } from "../sql"
import { adoptionProvenance, type ReasoningReplacement } from "./adoption"
import { replaceCanonicalReasoning } from "./canonical"
import { assessRewriteControl } from "./control-markup"

const reject = (reason: string) => Effect.die(new Error(reason))

/** Atomically validate and publish a rewrite, including sources sent by intervening attempts. */
export const adoptReasoning = Effect.fn("CoreReasoningDistillation.adopt")(function* (input: {
  events: EventV2.Interface
  db: Database.Interface["db"]
  sessionID: SessionSchema.ID
  messageID: SessionMessage.ID
  part: SessionMessage.AssistantReasoning
  replacement: ReasoningReplacement
  canAdopt: Effect.Effect<boolean>
}) {
  const { part, replacement } = input
  if (
    replacement.messageID !== input.messageID ||
    replacement.partID !== part.id ||
    part.distillation ||
    part.text !== replacement.before ||
    replacement.after.trim() === "" ||
    replacement.after === replacement.before
  )
    return false
  const control = assessRewriteControl(part.text, replacement.after)
  if (control) {
    yield* Effect.logInfo("reasoning adoption rejected; retaining current history", {
      "reasoning_distillation.reason": control,
    })
    return false
  }
  const source = { text: part.text, metadata: part.providerMetadata, settled: true, distilled: false }
  const edited = replaceCanonicalReasoning(source, replacement.after)
  if (!edited) return false
  const validate = Effect.gen(function* () {
    if (!(yield* input.canAdopt)) yield* reject("reasoning rewrite was sealed or disabled")
    const session = yield* input.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session || session.revert) yield* reject("reasoning source was reverted")
    const row = yield* input.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, input.messageID))
      .get()
      .pipe(Effect.orDie)
    const compaction = yield* latestCompaction(input.db, input.sessionID)
    if (row && compaction && row.seq < compaction.seq) yield* reject("reasoning source is outside the replay range")
    const message = row
      ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }).pipe(
          Effect.orDie,
        )
      : undefined
    const current = message?.type === "assistant" ? message.content.filter((item) => item.id === part.id) : []
    if (!row || row.session_id !== input.sessionID || current.length !== 1 || !isDeepStrictEqual(current[0], part))
      yield* reject("stale reasoning adoption")
  })
  return yield* input.events
    .publishMany(
      [
        {
          definition: SessionEvent.Reasoning.Ended,
          data: {
            sessionID: input.sessionID,
            assistantMessageID: input.messageID,
            reasoningID: part.id,
            text: edited.text,
            providerMetadata: edited.metadata,
            distillation: adoptionProvenance(source),
            timestamp: DateTime.makeUnsafe(Date.now()),
          },
        },
      ],
      { validate },
    )
    .pipe(
      Effect.as(true),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.logInfo("reasoning adoption rejected; retaining current history").pipe(Effect.as(false)),
      ),
    )
})
