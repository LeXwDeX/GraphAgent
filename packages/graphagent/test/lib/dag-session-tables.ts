// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Table rows store message and part payloads without their discriminated union; the casts restore the shapes the session service returns. */

// A `Session.Service` slice backed by the real session tables, for tests that
// drive DAG delivery without starting a model. Delivery reads three things
// from the session service: the parent row (its durable `dag_mode`), the
// transcript (to tell whether the latest user turn was answered), and single
// parts (the receipt of a report or wake that an earlier attempt committed).
// Pair it with `SessionProjector` so that a delivered report is projected into
// those tables and a retry finds its own receipt.
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Project } from "@graphagent/core/project"
import { before } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { isRecord } from "@/util/record"

/** The `dag_delivery` marker kind (`source` or `answer`) a delivered report part carries. */
export function reportPartKind(data: unknown): string | undefined {
  if (!isRecord(data) || data.type !== "text" || !isRecord(data.metadata)) return undefined
  const marker = data.metadata.dag_delivery
  return isRecord(marker) && typeof marker.kind === "string" ? marker.kind : undefined
}

/** The text of a text part payload. */
export function partText(data: unknown): string | undefined {
  return isRecord(data) && data.type === "text" && typeof data.text === "string" ? data.text : undefined
}

export interface TableSessionOptions {
  /** Runs before every `get`; a failure or defect it raises is the read's own. */
  readonly onGet?: (sessionID: string) => Effect.Effect<void, Session.NotFound>
  /** Child sessions `create` hands out, by title; the harness names gates after it. */
  readonly onCreate?: (sessionID: string, title: string | undefined) => void
}

/** Provide the test's own `Database` layer: `tableSession().pipe(Layer.provide(database))`. */
export function tableSession(options: TableSessionOptions = {}) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      let created = 0
      return Layer.mock(Session.Service, {
        get: (sessionID) =>
          Effect.gen(function* () {
            if (options.onGet) yield* options.onGet(sessionID)
            const row = yield* db
              .select({ dagMode: SessionTable.dag_mode })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            return {
              id: sessionID,
              slug: "parent",
              projectID: Project.ID.make("project-1"),
              directory: process.cwd(),
              title: "Parent",
              agent: "build",
              model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
              version: "test",
              time: { created: 0, updated: 0 },
              dagMode: row?.dagMode ?? "off",
            }
          }),
        create: (value) =>
          Effect.sync(() => {
            created += 1
            const id = SessionID.make(`ses_child_${created}`)
            options.onCreate?.(id, value?.title)
            return {
              id,
              slug: "child",
              projectID: Project.ID.make("project-1"),
              directory: process.cwd(),
              title: value?.title ?? id,
              version: "test",
              time: { created: 0, updated: 0 },
            }
          }),
        messages: (input) =>
          Effect.gen(function* () {
            const rows = yield* db
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.session_id, input.sessionID))
              .all()
              .pipe(Effect.orDie)
            const parts = yield* db
              .select()
              .from(PartTable)
              .where(eq(PartTable.session_id, input.sessionID))
              .all()
              .pipe(Effect.orDie)
            const history = rows
              .map((row): SessionV1.WithParts => ({
                info: { ...row.data, id: row.id, sessionID: row.session_id } as SessionV1.Info,
                parts: parts
                  .filter((part) => part.message_id === row.id)
                  .map(
                    (part) =>
                      ({
                        ...part.data,
                        id: part.id,
                        sessionID: part.session_id,
                        messageID: part.message_id,
                      }) as SessionV1.Part,
                  ),
              }))
              .toSorted((left, right) => (before(left.info, right.info) ? -1 : 1))
            return input.limit === undefined ? history : history.slice(-input.limit)
          }),
        getPart: (input) =>
          Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(PartTable)
              .where(
                and(
                  eq(PartTable.session_id, input.sessionID),
                  eq(PartTable.message_id, input.messageID),
                  eq(PartTable.id, input.partID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!row) return undefined
            return {
              ...row.data,
              id: row.id,
              sessionID: row.session_id,
              messageID: row.message_id,
            } as SessionV1.Part
          }),
      })
    }),
  )
}
