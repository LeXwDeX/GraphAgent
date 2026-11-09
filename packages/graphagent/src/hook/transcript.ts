import { isRecord } from "@/util/record"
import { InstanceRef } from "@/effect/instance-ref"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { HookLifecycle } from "./lifecycle"
import { NodeFileSystem } from "@effect/platform-node"
import { ByteSize, Effect, FileSystem, Option } from "effect"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Global } from "@graphagent/core/global"
import { Database } from "@graphagent/core/database/database"
import { MessageID, SessionID } from "@/session/schema"
import * as Log from "@/util/log"

const log = Log.create({ service: "hook.transcript" })

export interface Message {
  readonly info: {
    readonly id: string
    readonly sessionID: string
    readonly role: "user" | "assistant" | "system"
    readonly time: { readonly created: number; readonly completed?: number }
    readonly modelID?: string
    readonly providerID?: string
    readonly agent?: string
    readonly summary?: unknown
    readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
    readonly tokens?: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly parentID?: string
  }
  readonly parts: readonly unknown[]
}

/**
 * D1 PR3 test instrumentation. These counters exist so the scaling regressions
 * (materialization skipped, no full reads, bounded incremental writes) can be
 * asserted without reaching into engine internals. Not part of the public API.
 */
export const __transcriptStats = {
  materializeCalls: 0,
  messagesRead: 0,
  writes: 0,
  writtenBytes: 0,
  fullRewrites: 0,
  lastRewriteReason: undefined as string | undefined,
}

export function resetTranscriptStats() {
  __transcriptStats.materializeCalls = 0
  __transcriptStats.messagesRead = 0
  __transcriptStats.writes = 0
  __transcriptStats.writtenBytes = 0
  __transcriptStats.fullRewrites = 0
  __transcriptStats.lastRewriteReason = undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function content(parts: readonly unknown[]) {
  return parts.flatMap((value): unknown[] => {
    const part = record(value)
    if (!part) return []
    if (part.type === "text" && typeof part.text === "string" && !part.ignored)
      return [{ type: "text", text: part.text }]
    if (part.type === "tool") {
      const state = record(part.state)
      if (!state) return []
      const use = { type: "tool_use", id: part.callID, name: part.tool, input: state.input ?? {} }
      return [use]
    }
    return []
  })
}

/** V1 history is the only transcript source; callers pass the persisted rows they loaded. */
export const history = Effect.fn("HookTranscript.history")(function* (
  _sessionID: string,
  legacyHistory: readonly Message[] = [],
) {
  return legacyHistory
})

/** Ordering key shared with `MessageV2.page`/`after`: `(time_created, id)`. */
interface CursorKey {
  readonly id: string
  readonly time: number
}

/**
 * One session's persisted transcript state. `settledOffset` is the byte length
 * of the longest stable prefix in the file; `settled`/`settledParentUuid`/
 * `settledCount` describe the message that prefix ends at.
 */
interface TranscriptCursor {
  readonly file: string
  readonly directory: string
  readonly settledOffset: number
  readonly settled?: CursorKey
  readonly settledParentUuid: string | null
  readonly settledCount: number
}

const cursors = new Map<string, TranscriptCursor>()
// Safety valve for sessions that never emit SessionEnd (crashes, imports).
const CURSOR_LIMIT = 1024
const PAGE_SIZE = 200

/** Session end drops the in-memory cursor; the next materialization rebuilds once. */
export function clearCursor(sessionID: string) {
  cursors.delete(sessionID)
}

function remember(sessionID: string, cursor: TranscriptCursor) {
  cursors.delete(sessionID)
  if (cursors.size >= CURSOR_LIMIT) {
    const oldest = cursors.keys().next()
    if (!oldest.done) cursors.delete(oldest.value)
  }
  cursors.set(sessionID, cursor)
}

/** A message is stable when no later part update can change its JSONL line. */
function stableMessage(message: Message): boolean {
  if (message.info.role !== "assistant") return true
  if (message.info.time.completed === undefined) return false
  return message.parts.every((value) => {
    const part = record(value)
    if (!part || part.type !== "tool") return true
    const state = record(part.state)
    return !!state && (state.status === "completed" || state.status === "error")
  })
}

interface RenderedMessage {
  /** JSONL lines this message contributes (its own row plus an optional tool-results row). */
  readonly lines: readonly string[]
  /** Last uuid written for this message; the next message without `parentID` chains to it. */
  readonly lastUuid: string
}

function renderMessage(message: Message, sessionID: string, directory: string, parent: string | null): RenderedMessage {
  const row = {
    type: message.info.role,
    uuid: message.info.id,
    parentUuid: message.info.parentID ?? parent,
    sessionId: sessionID,
    cwd: directory,
    timestamp: new Date(message.info.time.created).toISOString(),
    message: { role: message.info.role, content: content(message.parts) },
  }
  const results = message.parts.flatMap((value) => {
    const part = record(value)
    const state = record(part?.state)
    if (!part || part.type !== "tool" || !state || (state.status !== "completed" && state.status !== "error")) return []
    return [
      {
        type: "tool_result",
        tool_use_id: part.callID,
        content: state.status === "error" ? state.error : state.output,
        is_error: state.status === "error",
      },
    ]
  })
  if (!results.length) return { lines: [JSON.stringify(row)], lastUuid: message.info.id }
  const resultID = `${message.info.id}:tool-results`
  const result = {
    ...row,
    type: "user",
    uuid: resultID,
    parentUuid: message.info.id,
    message: { role: "user", content: results },
  }
  return { lines: [JSON.stringify(row), JSON.stringify(result)], lastUuid: resultID }
}

function lineBytes(line: string) {
  return Buffer.byteLength(line, "utf8") + 1
}

function linesBytes(lines: readonly string[]) {
  return lines.reduce((total, line) => total + lineBytes(line), 0)
}

/**
 * Persisted messages in ascending order. `after` limits the read to the
 * unsettled tail; transcript materialization never loads the whole session
 * unless it is rebuilding the file from scratch.
 */
const loadMessages = (input: { sessionID: string; after?: string }) =>
  Effect.gen(function* () {
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (!database) return [] as readonly Message[]
    const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
    const items: Message[] = []
    let after = input.after
    while (true) {
      const page = yield* MessageV2.after({
        sessionID: SessionID.make(input.sessionID),
        limit: PAGE_SIZE,
        after,
      }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
      __transcriptStats.messagesRead += page.items.length
      items.push(...(page.items as readonly Message[]))
      if (!page.more || !page.cursor) break
      after = page.cursor
    }
    return [...(yield* history(input.sessionID, items))].filter((item) => item.info.sessionID === input.sessionID)
  })

const countThrough = (sessionID: string, at: CursorKey) =>
  Effect.gen(function* () {
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (!database) return undefined
    const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
    return yield* MessageV2.countThrough({
      sessionID: SessionID.make(sessionID),
      cursor: MessageV2.cursor.encode({ id: MessageID.make(at.id), time: at.time }),
    }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
  })

const encodeCursor = (at: CursorKey) =>
  Effect.gen(function* () {
    const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
    return MessageV2.cursor.encode({ id: MessageID.make(at.id), time: at.time })
  })

/** Materialize a stable, private JSONL snapshot before invoking an external hook. */
export const materialize = Effect.fn("HookTranscript.materialize")(function* (input: {
  readonly sessionID: string
  readonly directory: string
  readonly root?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const root = input.root ?? path.join(Global.Path.data, "hooks", "transcripts")
  const file = path.join(root, createHash("sha256").update(input.sessionID).digest("hex") + ".jsonl")
  const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))

  const rewrite = (reason: string) =>
    Effect.gen(function* () {
      const messages = yield* loadMessages({ sessionID: input.sessionID })
      let parent: string | null = null
      let settledOffset = 0
      let settledCount = 0
      let settled: CursorKey | undefined
      let settledParentUuid: string | null = null
      let prefixOpen = true
      const lines: string[] = []
      for (const message of messages) {
        const rendered = renderMessage(message, input.sessionID, input.directory, parent)
        if (prefixOpen && stableMessage(message)) {
          settledOffset += linesBytes(rendered.lines)
          settledCount++
          settled = { id: message.info.id, time: message.info.time.created }
          settledParentUuid = rendered.lastUuid
        } else prefixOpen = false
        lines.push(...rendered.lines)
        parent = rendered.lastUuid
      }
      const text = lines.length ? lines.join("\n") + "\n" : ""
      const temp = file + "." + randomUUID() + ".tmp"
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(temp, text, { mode: 0o600 })
        yield* fs.rename(temp, file)
      }).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)))
      remember(input.sessionID, {
        file,
        directory: input.directory,
        settledOffset,
        settled,
        settledParentUuid,
        settledCount,
      })
      __transcriptStats.writes++
      __transcriptStats.fullRewrites++
      __transcriptStats.writtenBytes += Buffer.byteLength(text, "utf8")
      __transcriptStats.lastRewriteReason = reason
      log.debug("transcript full rewrite", {
        sessionID: input.sessionID,
        reason,
        messages: messages.length,
        bytes: Buffer.byteLength(text, "utf8"),
      })
      return file
    })

  const update = Effect.gen(function* () {
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
    const known = cursors.get(input.sessionID)
    if (!known) return yield* rewrite("cold_start")
    if (known.file !== file) return yield* rewrite("root_changed")
    // Every row embeds `cwd`, so a working-directory change invalidates the file.
    if (known.directory !== input.directory) return yield* rewrite("directory_changed")
    const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!stat) return yield* rewrite("file_missing")
    if (Number(ByteSize.toBigInt(stat.size)) < known.settledOffset) return yield* rewrite("file_truncated")
    if (known.settled) {
      // A different count through the settled key means a revert or deletion
      // changed the prefix; a same-count modification is out of scope.
      const current = yield* countThrough(input.sessionID, known.settled)
      if (current !== undefined && current !== known.settledCount) return yield* rewrite("count_mismatch")
    }

    const tail = yield* loadMessages({
      sessionID: input.sessionID,
      after: known.settled ? yield* encodeCursor(known.settled) : undefined,
    })
    let parent = known.settledParentUuid
    let settledOffset = known.settledOffset
    let settledCount = known.settledCount
    let settled = known.settled
    let settledParentUuid = known.settledParentUuid
    let prefixOpen = true
    const lines: string[] = []
    for (const message of tail) {
      const rendered = renderMessage(message, input.sessionID, input.directory, parent)
      if (prefixOpen && stableMessage(message)) {
        settledOffset += linesBytes(rendered.lines)
        settledCount++
        settled = { id: message.info.id, time: message.info.time.created }
        settledParentUuid = rendered.lastUuid
      } else prefixOpen = false
      lines.push(...rendered.lines)
      parent = rendered.lastUuid
    }
    const text = lines.length ? lines.join("\n") + "\n" : ""
    const size = Number(ByteSize.toBigInt(stat.size))
    // The unstable tail is rewritten on every trigger; an empty tail only needs
    // the file truncated back to the stable prefix when a previous tail vanished.
    if (size > known.settledOffset || text.length > 0) {
      if (text.length > 0) {
        yield* fs.truncate(file, known.settledOffset)
        yield* fs.writeFileString(file, text, { flag: "a", mode: 0o600 })
      } else {
        yield* fs.truncate(file, known.settledOffset)
      }
      __transcriptStats.writes++
      __transcriptStats.writtenBytes += Buffer.byteLength(text, "utf8")
    }
    remember(input.sessionID, {
      file,
      directory: input.directory,
      settledOffset,
      settled,
      settledParentUuid,
      settledCount,
    })
    return file
  })

  __transcriptStats.materializeCalls++
  return lifecycle ? yield* lifecycle.serializeTranscript(input.sessionID, update) : yield* update
}, Effect.provide(NodeFileSystem.layer))

/**
 * `session` exports (SessionStart/Setup) last until the session ends. `directory`
 * exports (CwdChanged/FileChanged) are an overlay that the next CwdChanged clears.
 */
export type EnvironmentLifetime = "session" | "directory"

export const environmentFile = Effect.fn("HookTranscript.environmentFile")(function* (
  sessionID: string,
  rootOverride?: string,
  lifetime: EnvironmentLifetime = "session",
) {
  const fs = yield* FileSystem.FileSystem
  const root = rootOverride ?? path.join(Global.Path.data, "hooks", "environment")
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
  const file = path.join(
    root,
    createHash("sha256").update(sessionID).digest("hex") + (lifetime === "directory" ? ".directory.sh" : ".sh"),
  )
  if (!(yield* fs.exists(file))) yield* fs.writeFileString(file, "", { mode: 0o600 })
  return file
}, Effect.provide(NodeFileSystem.layer))

export const environment = Effect.fn("HookTranscript.environment")(function* (
  sessionID: string,
  rootOverride?: string,
  base: NodeJS.ProcessEnv = process.env,
) {
  const files = [
    yield* environmentFile(sessionID, rootOverride, "session"),
    yield* environmentFile(sessionID, rootOverride, "directory"),
  ]
  const fileSystem = yield* FileSystem.FileSystem
  const texts = yield* Effect.forEach(files, (file) => fileSystem.readFileString(file))
  const directory = (yield* InstanceRef)?.directory ?? process.cwd()
  const signature = createHash("sha256")
    .update(directory)
    .update("\0")
    .update(JSON.stringify(texts))
    .update("\0")
    .update(JSON.stringify(Object.entries(base).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
  const load = Effect.tryPromise({
    try: (signal) =>
      promisify(execFile)(
        process.platform === "win32" ? "bash.exe" : "/bin/bash",
        [
          "-c",
          '/usr/bin/env -0; printf "\\0"; set -a; source "$1" >/dev/null; source "$2" >/dev/null; /usr/bin/env -0',
          "hook-environment",
          ...files,
        ],
        { cwd: directory, env: base, signal, timeout: 5000, maxBuffer: 1024 * 1024 },
      ).then(({ stdout }) => {
        const [before, after] = stdout.split("\0\0")
        if (after === undefined) return {}
        const parse = (value: string) =>
          Object.fromEntries(
            value
              .split("\0")
              .filter(Boolean)
              .map((entry) => {
                const at = entry.indexOf("=")
                return [entry.slice(0, at), entry.slice(at + 1)]
              }),
          )
        const baseline = parse(before ?? "")
        const exported = parse(after)
        const delta: Record<string, string | undefined> = {}
        for (const key of new Set([...Object.keys(baseline), ...Object.keys(exported)])) {
          if (key === "_" || key === "SHLVL") continue
          if (baseline[key] !== exported[key]) delta[key] = exported[key]
        }
        return delta
      }),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed<Record<string, string | undefined>>({})))
  const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
  return lifecycle ? yield* lifecycle.environment(sessionID, signature, load) : yield* load
}, Effect.provide(NodeFileSystem.layer))

/** Apply only exports/unsets from the session file; preserve unrelated plugin overrides. */
export function applyEnvironment(
  base: NodeJS.ProcessEnv,
  changes: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const result = { ...base }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  return result
}

/** Session end clears every layer (`all`); a working-directory change clears only the `directory` overlay. */
export const clearEnvironment = Effect.fn("HookTranscript.clearEnvironment")(function* (
  sessionID: string,
  lifetime: EnvironmentLifetime | "all" = "all",
  rootOverride?: string,
) {
  const fs = yield* FileSystem.FileSystem
  for (const layer of lifetime === "all" ? (["session", "directory"] as const) : ([lifetime] as const)) {
    const file = yield* environmentFile(sessionID, rootOverride, layer)
    yield* fs.writeFileString(file, "", { mode: 0o600 })
  }
}, Effect.provide(NodeFileSystem.layer))

/**
 * CC's `scratchpad_dir`: a per-session directory hooks (and the Bash tool) may
 * use for temporary files. Keyed by a hash of the session id so two sessions
 * never share a directory and the path leaks no session identity. Created
 * lazily by `SettingsHook.trigger` the first time a hook actually runs; `0o700`
 * because hooks receive the path and may write secrets into it.
 *
 * Returns `undefined` when the directory cannot be created — an unavailable
 * temp dir is exactly the case where CC omits the field, and a scratchpad is
 * an affordance, never a reason to fail a hook.
 */
export const scratchpadDir = Effect.fn("HookTranscript.scratchpadDir")(function* (
  sessionID: string,
  rootOverride?: string,
) {
  if (!sessionID) return undefined
  const fs = yield* FileSystem.FileSystem
  const root = rootOverride ?? path.join(Global.Path.tmp, "hooks", "scratchpad")
  const dir = path.join(root, createHash("sha256").update(sessionID).digest("hex"))
  const created = yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
  return created ? dir : undefined
}, Effect.provide(NodeFileSystem.layer))

/** Session end drops its scratchpad; missing directory is success. */
export const clearScratchpad = Effect.fn("HookTranscript.clearScratchpad")(function* (
  sessionID: string,
  rootOverride?: string,
) {
  if (!sessionID) return
  const fs = yield* FileSystem.FileSystem
  const root = rootOverride ?? path.join(Global.Path.tmp, "hooks", "scratchpad")
  yield* fs
    .remove(path.join(root, createHash("sha256").update(sessionID).digest("hex")), { recursive: true, force: true })
    .pipe(Effect.ignore)
}, Effect.provide(NodeFileSystem.layer))

export * as HookTranscript from "./transcript"
