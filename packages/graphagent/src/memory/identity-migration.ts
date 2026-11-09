// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as MemoryIdentityMigration from "./identity-migration"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { FSUtil } from "@graphagent/core/fs-util"
import { ProjectV2 } from "@graphagent/core/project"
import { EffectFlock } from "@graphagent/core/util/effect-flock"
import { Context, Effect, Layer, Schema } from "effect"
import { join } from "node:path"
import { MemoryHome } from "./home"
import { MemorySchema } from "./schema"
import { MemoryStore } from "./store"

export interface Interface {
  readonly migrateHome: (
    oldID: ProjectV2.ID,
    newID: ProjectV2.ID,
  ) => Effect.Effect<
    void,
    | FSUtil.Error
    | EffectFlock.LockError
    | MemoryStore.StoreError
    | ConflictError
    | InvalidHomeError
    | SourceChangedError
  >
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/MemoryIdentityMigration") {}

export class ConflictError extends Schema.TaggedError<ConflictError>()("MemoryIdentityMigration.Conflict", {
  topic_ids: Schema.Array(Schema.String),
}) {}

export class InvalidHomeError extends Schema.TaggedError<InvalidHomeError>()(
  "MemoryIdentityMigration.InvalidHome",
  {
    paths: Schema.Array(Schema.String),
  },
) {}

/**
 * The source Home changed while the migration was merging it into the target
 * (a process still running under the old identity committed). Nothing was
 * removed; the migration is safe to retry and converges.
 */
export class SourceChangedError extends Schema.TaggedError<SourceChangedError>()(
  "MemoryIdentityMigration.SourceChanged",
  {
    project_id: Schema.String,
  },
) {}

// Content identity for the migration merge: everything except the metadata fields
// the match controller mutates on live topics (MemoryStore.markMatched bumps
// last_matched_at / match_count / revision / updated_at without touching content).
// Two topics that differ only in those must not register as a user-visible conflict.
function sameContent(left: MemorySchema.Topic, right: MemorySchema.Topic): boolean {
  const content = (topic: MemorySchema.Topic) =>
    JSON.stringify({
      schema_version: topic.schema_version,
      id: topic.id,
      name: topic.name,
      summary: topic.summary,
      metadata: {
        categories: topic.metadata.categories,
        status: topic.metadata.status,
        importance: topic.metadata.importance,
        keywords: topic.metadata.keywords,
        related_topics: topic.metadata.related_topics,
        created_at: topic.metadata.created_at,
        item_count: topic.metadata.item_count,
      },
      items: topic.items,
    })
  return content(left) === content(right)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const home = yield* MemoryHome.Service
    const store = yield* MemoryStore.Service

    const inspectHome = Effect.fnUntraced(function* (directory: string) {
      const unexpected = (yield* fs.readDirectoryEntries(directory)).filter(
        (entry) =>
          !(
            (entry.name === "topics" && entry.type === "directory") ||
            (entry.name === "generations" && entry.type === "directory") ||
            (entry.name === "manifest.json" && entry.type === "file") ||
            // The store's own atomicWrite residue (`manifest.json.<pid>.<uuid>.tmp`)
            // is left behind if a process dies between the temp write and the rename.
            // It is harmless garbage, not foreign state — rejecting it would wedge
            // every identity upgrade after such a crash.
            (entry.type === "file" && entry.name.startsWith("manifest.json.") && entry.name.endsWith(".tmp"))
          ),
      )
      if (unexpected.length === 0) return
      yield* new InvalidHomeError({ paths: unexpected.map((entry) => join(directory, entry.name)) })
    })

    // Three-phase merge. Locking rules that make opposite-direction migrations
    // (remote→remote identity changes) deadlock-free:
    //  - a dedicated pair lock serializes the two directions of the same pair;
    //  - at most ONE `memory-project:*` lock is held at any moment (phases 1 and
    //    3 hold the source lock, phase 2 holds none — the store locks the target
    //    itself inside updateTopics), so no hold-and-wait cycle can form between
    //    concurrent migrations or with writers on either identity.
    const migrateHomeUnsafe = Effect.fnUntraced(function* (oldID: ProjectV2.ID, newID: ProjectV2.ID) {
      const source = home.directory(oldID)
      const target = home.directory(newID)

      // Phase 1 — snapshot the source under the source lock. Even a missing
      // target can have a writer holding its lock with an empty snapshot, so
      // moving the source there without the target lock would lose topics.
      const snapshot = yield* flock.withLock(
        Effect.gen(function* () {
          if (!(yield* fs.existsSafe(source))) return undefined
          yield* inspectHome(source)
          return yield* store.readSnapshot(oldID)
        }),
        `memory-project:${oldID}`,
        home.locks,
      )
      if (!snapshot) return

      // Phase 2 — merge into the target. updateTopics takes the target lock.
      if (yield* fs.existsSafe(target)) yield* inspectHome(target)
      const targetTopics = yield* store.inspectTopics(newID)
      const targetByID = new Map(targetTopics.map((topic) => [topic.id, topic]))
      const conflicts = snapshot.topics
        .filter((topic) => {
          const current = targetByID.get(topic.id)
          return current && !sameContent(current, topic)
        })
        .map((topic) => topic.id)
      if (conflicts.length > 0) yield* new ConflictError({ topic_ids: conflicts })

      yield* store.updateTopics(newID, (topics) => {
        const current = new Map(topics.map((topic) => [topic.id, topic]))
        // Recheck the entire source against the snapshot read under the
        // target lock, including topics changed or removed by live writers.
        const conflicts = snapshot.topics.filter((topic) => {
          const existing = current.get(topic.id)
          return existing && !sameContent(existing, topic)
        })
        if (conflicts.length > 0)
          throw new MemoryStore.StoreError({
            message: `Memory identity migration conflicted for Topics: ${conflicts.map((topic) => topic.id).join(", ")}`,
          })
        const changed = snapshot.topics.filter((topic) => !current.has(topic.id))
        changed.forEach((topic) => current.set(topic.id, topic))
        return {
          applied: {
            topics: Array.from(current.values()).sort((left, right) => left.id.localeCompare(right.id)),
            changed: changed.map((topic) => topic.id),
            deleted: [],
          },
          result: undefined,
        }
      })

      // Phase 3 — remove the source only if it has not changed since the
      // snapshot; otherwise leave everything in place for a converging retry.
      yield* flock.withLock(
        Effect.gen(function* () {
          if (!(yield* fs.existsSafe(source))) return
          const current = yield* store.readSnapshot(oldID)
          if (current.revision !== snapshot.revision) yield* new SourceChangedError({ project_id: oldID })
          yield* fs.remove(source, { recursive: true })
        }),
        `memory-project:${oldID}`,
        home.locks,
      )
    })

    const migrateHome: Interface["migrateHome"] = (oldID, newID) => {
      if (oldID === newID) return Effect.void
      const pair = [oldID, newID].sort().join("|")
      // The memory-identity:<oldID> fence is held by the retirement seam
      // (ProjectIdentityMigration.migrate), which wraps this call together with
      // the reference/row retirement so the fence covers the whole retirement.
      // Here we only serialize opposite-direction migrations via the pair lock.
      // Lock order (outermost→innermost): memory-identity (held by caller) →
      // memory-migrate (pair) → memory-project (inside migrateHomeUnsafe).
      return flock
        .withLock(migrateHomeUnsafe(oldID, newID), `memory-migrate:${pair}`, home.locks)
        .pipe(Effect.asVoid, Effect.withSpan("MemoryIdentityMigration.migrateHome"))
    }

    return Service.of({ migrateHome })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(MemoryHome.defaultLayer),
  Layer.provide(MemoryStore.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, EffectFlock.node, MemoryHome.node, MemoryStore.node])
