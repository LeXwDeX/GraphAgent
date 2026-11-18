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
 *
 * Overwriting an existing file (`write`, and `apply_patch` Add File and Move
 * onto an existing target) requires a record whose content still matches the
 * disk (`requireRead`); creating a new file needs none. `edit` and `apply_patch`
 * Update do not require a read: they work on the content they read themselves.
 *
 * `edit`, `write` and `apply_patch` share one in-process lock per path
 * (`withLocks`). A call asks for permission outside the lock, then takes it for
 * the write section only: it checks again that the disk still holds what the
 * call planned against, writes, formats, records and publishes. A permission
 * wait therefore never blocks another writer, and what a call changed is
 * checked at the point where it is written. There is no cross-process lock and
 * no file watching: another process can still change a file between two reads.
 *
 * What a call planned against is its own `Baseline`, taken from the bytes it
 * read before it asks. The session's record cannot play that part: another
 * call of the same session may replace the file and the record while the
 * question is open, and a check against the new record would then pass for a
 * call that still holds the old content and the old approval diff. For the same
 * reason a read records only the version it consumed (`record` with `expected`).
 */
import { createHash } from "node:crypto"
import * as path from "node:path"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { FSUtil } from "@graphagent/core/fs-util"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Context, Effect, Layer, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess } from "./engine-process"
import { SessionID } from "./schema"

export type Source = "read" | "write" | "edit" | "apply_patch"

/**
 * One version of a file as a call saw it: the sha256 of its bytes (absent above
 * `MAX_HASHED_BYTES`), its size, and its mtime when it came from the disk.
 */
export interface Baseline {
  /** sha256 hex of the file bytes; absent for files larger than `MAX_HASHED_BYTES`. */
  readonly hash?: string
  readonly mtimeMs?: number
  readonly size: number
}

export interface Entry extends Baseline {
  readonly mtimeMs: number
  readonly source: Source
}

/** Files above this size are recorded by size and mtime only. */
export const MAX_HASHED_BYTES = 10 * 1024 * 1024

/** `edit` and `write` load the whole file, so they refuse an existing file above this size. */
export const MAX_EDITABLE_BYTES = 10 * 1024 * 1024

const MAX_EDITABLE_LABEL = `${MAX_EDITABLE_BYTES / (1024 * 1024)} MiB`

export const directoryMessage = (filePath: string) => `Path is a directory, not a file: ${filePath}`

/** An existing file the session has no record of. */
export const notReadMessage = (filePath: string) =>
  `${filePath} already exists and was not read in this session. Read it first, then retry.`

/** An existing file whose content differs from the session's last record of it. */
export const changedSinceReadMessage = (filePath: string) =>
  `${filePath} changed after it was last read in this session. Read it again, then retry.`

/** The file differs from what the call planned against: it changed while the call waited for permission. */
export const changedWhileAskingMessage = (filePath: string) =>
  `${filePath} changed while this call waited for permission. Read it again, then retry.`

/**
 * Receipt line of an `edit` or `apply_patch` that wrote onto content the
 * session had not seen: the disk no longer matched the last record of the file.
 * `relativePath` is the path the receipt already shows for the file.
 */
export const changedOutsideNote = (relativePath: string) =>
  `Note: this file changed outside this session after your last read: ${relativePath}. Your change was applied to its current content.`

export const tooLargeMessage = (filePath: string) =>
  `${filePath} is larger than ${MAX_EDITABLE_LABEL}; edit and write do not load files this large. Use a shell command (sed, awk, python).`

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

/**
 * Hold the lock of every given path while `effect` runs. Locks are taken in
 * ascending key order, so two calls that name the same paths in another order
 * cannot wait on each other. The lock is not reentrant: `effect` must not take
 * a lock on one of these paths again. Keys are resolved when the effect starts.
 */
export const withLocks =
  (paths: readonly string[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const keys = [...new Set(paths.map(keyOf))].sort()
      return keys.reduceRight((inner, key) => EngineProcess.fileLocks.withLock(key)(inner), effect)
    })

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** The baseline of bytes a call has read itself. */
export function baselineOf(bytes: Uint8Array): Baseline {
  return { hash: sha256(bytes), size: bytes.byteLength }
}

/** Same version: hashes decide when both sides have one, else size and mtime. */
function sameVersion(a: Baseline, b: Baseline): boolean {
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

export interface Interface {
  /** The last recorded state of a file in this session, or undefined when none. */
  readonly get: (sessionID: SessionID, filePath: string) => Effect.Effect<Entry | undefined>
  /**
   * Record the file's current disk state. Never fails: a path that is not a
   * regular file, or that cannot be read, is left unrecorded. With `expected`
   * the file is recorded only when it still is that version, so a read records
   * the version it consumed and not one that replaced it afterwards.
   */
  readonly record: (sessionID: SessionID, filePath: string, source: Source, expected?: Baseline) => Effect.Effect<void>
  /**
   * Compare the disk with the session's record: "unread" without a record,
   * "changed" when the file is gone, is not a regular file or no longer
   * matches, "same" otherwise. Hashes decide when both sides have one; larger
   * files compare size and mtime.
   */
  readonly verify: (sessionID: SessionID, filePath: string) => Effect.Effect<"unread" | "changed" | "same">
  /**
   * Fail unless the file is a regular file the session has read and that still
   * matches that record. `observed` is the caller's own reading of the file; it
   * is checked against the record instead of reading the disk again, so the
   * check and the caller's plan are about the same bytes.
   */
  readonly requireRead: (sessionID: SessionID, filePath: string, observed?: Baseline) => Effect.Effect<void, Error>
  /** Fail with `changedWhileAskingMessage` unless the disk still matches the session's record. */
  readonly requireSame: (sessionID: SessionID, filePath: string) => Effect.Effect<void, Error>
  /** The file as it is now, to keep as a call's own baseline; undefined when it is not a readable regular file. */
  readonly baseline: (filePath: string) => Effect.Effect<Baseline | undefined>
  /** Fail with `changedWhileAskingMessage` unless the file still is the version `baseline` describes. */
  readonly requireBaseline: (filePath: string, baseline: Baseline) => Effect.Effect<void, Error>
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
        return { hash: sha256(bytes), mtimeMs, size: bytes.byteLength } satisfies Snapshot
      },
      Effect.catch(() => Effect.succeed(undefined)),
    )

    const get: Interface["get"] = Effect.fn("FileState.get")(function* (sessionID, filePath) {
      const sessions = yield* InstanceState.get(state)
      return sessions.get(sessionID)?.get(keyOf(filePath))
    })

    const record: Interface["record"] = Effect.fn("FileState.record")(
      function* (sessionID, filePath, source, expected) {
        const current = yield* snapshot(filePath)
        if (!current) return
        if (expected && !sameVersion(expected, current)) return
        const sessions = yield* InstanceState.get(state)
        let files = sessions.get(sessionID)
        if (!files) {
          files = new Map()
          sessions.set(sessionID, files)
        }
        files.set(keyOf(filePath), { ...current, source })
      },
    )

    const verify: Interface["verify"] = Effect.fn("FileState.verify")(function* (sessionID, filePath) {
      const sessions = yield* InstanceState.get(state)
      const entry = sessions.get(sessionID)?.get(keyOf(filePath))
      if (!entry) return "unread"
      const current = yield* snapshot(filePath)
      if (!current) return "changed"
      return sameVersion(entry, current) ? "same" : "changed"
    })

    const requireRead: Interface["requireRead"] = Effect.fn("FileState.requireRead")(
      function* (sessionID, filePath, observed) {
        const info = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (info?.type === "Directory") yield* Effect.fail(new Error(directoryMessage(filePath)))
        const entry = yield* get(sessionID, filePath)
        if (!entry) {
          yield* Effect.fail(new Error(notReadMessage(filePath)))
        } else {
          const current = observed ?? (yield* snapshot(filePath))
          if (!current || !sameVersion(entry, current)) {
            yield* Effect.fail(new Error(changedSinceReadMessage(filePath)))
          }
        }
      },
    )

    const requireSame: Interface["requireSame"] = Effect.fn("FileState.requireSame")(function* (sessionID, filePath) {
      if ((yield* verify(sessionID, filePath)) !== "same") {
        yield* Effect.fail(new Error(changedWhileAskingMessage(filePath)))
      }
    })

    const baseline: Interface["baseline"] = Effect.fn("FileState.baseline")(function* (filePath) {
      return yield* snapshot(filePath)
    })

    const requireBaseline: Interface["requireBaseline"] = Effect.fn("FileState.requireBaseline")(
      function* (filePath, expected) {
        const current = yield* snapshot(filePath)
        if (!current || !sameVersion(expected, current)) {
          yield* Effect.fail(new Error(changedWhileAskingMessage(filePath)))
        }
      },
    )

    return Service.of({ get, record, verify, requireRead, requireSame, baseline, requireBaseline })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, FSUtil.node])

export * as FileState from "./file-state"
