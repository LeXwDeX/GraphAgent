// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Session file state (Issue #1452). What the model holds of a file is a cache,
 * not the source of truth: parallel child agents, a long permission wait or a
 * formatter run from `bash` can all leave the disk different from what the
 * session last saw. This service remembers, per session and per file, the disk
 * state after the last successful `read` or write (sha256 of the bytes, size,
 * mtime, and which tool recorded it), so the write tools can check it at the
 * write point instead of relying on prompt text.
 *
 * Entries are keyed by session: a child session starts with an empty record
 * and compaction never clears one. The state is per instance and is cleaned on
 * instance disposal or session deletion.
 *
 * `hash` is the sha256 of the file bytes; files larger than `MAX_HASHED_BYTES`
 * are not hashed and carry only size and mtime.
 */
import { createHash } from "node:crypto"
import * as path from "node:path"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { FSUtil } from "@graphagent/core/fs-util"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Context, Effect, Layer, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "./schema"

export type Source = "read" | "write" | "edit" | "apply_patch"

export interface Entry {
  /** sha256 hex of the file bytes; absent for files larger than `MAX_HASHED_BYTES`. */
  readonly hash?: string
  readonly mtimeMs: number
  readonly size: number
  readonly source: Source
}

/** Files above this size are recorded by size and mtime only. */
export const MAX_HASHED_BYTES = 10 * 1024 * 1024

type State = Map<SessionID, Map<string, Entry>>

/** Disk state without the recording tool. */
type Snapshot = Omit<Entry, "source">

/** Canonical map key: the same file reached by a relative, absolute or linked path maps to one entry. */
export function keyOf(filePath: string): string {
  try {
    return FSUtil.resolve(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

export interface Interface {
  /** The last recorded state of a file in this session, or undefined when none. */
  readonly get: (sessionID: SessionID, filePath: string) => Effect.Effect<Entry | undefined>
  /**
   * Record the file's current disk state. Never fails: a path that is not a
   * regular file, or that cannot be read, is left unrecorded.
   */
  readonly record: (sessionID: SessionID, filePath: string, source: Source) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionFileState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const fs = yield* FSUtil.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("FileState.state")(function* () {
        const sessions: State = new Map()
        // The subscription lives with the per-directory state, so an event is
        // handled in that directory's instance context. Disposal unsubscribes
        // and clears every stored entry.
        yield* Effect.acquireRelease(
          events.listen((event) => {
            if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
            const data = event.data
            if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
            if (typeof data.sessionID !== "string") return Effect.void
            sessions.delete(SessionID.make(data.sessionID))
            return Effect.void
          }),
          (unsubscribe) => unsubscribe,
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.clear()))
        return sessions
      }),
    )

    // Current disk state, or undefined when the path is not a readable regular
    // file. The size matches the hashed bytes, so a write that lands between
    // the stat and the read cannot pair one size with another content.
    const snapshot = Effect.fnUntraced(
      function* (filePath: string) {
        const info = yield* fs.stat(filePath)
        if (info.type !== "File") return undefined
        const mtimeMs = Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0
        const size = Number(info.size)
        if (size > MAX_HASHED_BYTES) return { mtimeMs, size } satisfies Snapshot
        const bytes = yield* fs.readFile(filePath)
        return {
          hash: createHash("sha256").update(bytes).digest("hex"),
          mtimeMs,
          size: bytes.byteLength,
        } satisfies Snapshot
      },
      Effect.catch(() => Effect.succeed(undefined)),
    )

    const get: Interface["get"] = Effect.fn("FileState.get")(function* (sessionID, filePath) {
      const sessions = yield* InstanceState.get(state)
      return sessions.get(sessionID)?.get(keyOf(filePath))
    })

    const record: Interface["record"] = Effect.fn("FileState.record")(function* (sessionID, filePath, source) {
      const current = yield* snapshot(filePath)
      if (!current) return
      const sessions = yield* InstanceState.get(state)
      let files = sessions.get(sessionID)
      if (!files) {
        files = new Map()
        sessions.set(sessionID, files)
      }
      files.set(keyOf(filePath), { ...current, source })
    })

    return Service.of({ get, record })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, FSUtil.node])

export * as FileState from "./file-state"
