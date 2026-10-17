import { isRecord } from "@/util/record"
import { InstanceRef } from "@/effect/instance-ref"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { HookLifecycle } from "./lifecycle"
import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, FileSystem, Option, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { eq, asc } from "drizzle-orm"
import { Global } from "@opencode-ai/core/global"

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

/** V1 and native V2 use different message tables. Prefer supplied V1 history; never merge both projections. */
export const history = Effect.fn("HookTranscript.history")(function* (
  sessionID: string,
  legacyHistory: readonly Message[] = [],
) {
  if (legacyHistory.length) return legacyHistory
  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  if (!database) return legacyHistory
  const rows = yield* database.db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make(sessionID)))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const result: Message[] = []
  for (const row of rows) {
    const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
      ...row.data,
      id: row.id,
      type: row.type,
    }).pipe(Effect.orDie)
    const base = { id: message.id, sessionID, time: { created: DateTime.toEpochMillis(message.time.created) } }
    if (message.type === "assistant") {
      result.push({
        info: {
          ...base,
          role: "assistant",
          time: {
            ...base.time,
            ...(message.time.completed ? { completed: DateTime.toEpochMillis(message.time.completed) } : {}),
          },
          modelID: message.model.id,
          providerID: message.model.providerID,
          agent: message.agent,
          tokens: message.tokens,
        },
        parts: message.content.map((part) =>
          part.type === "tool"
            ? {
                type: "tool",
                callID: part.id,
                tool: part.name,
                state: {
                  ...part.state,
                  ...(part.state.status === "completed"
                    ? {
                        output: part.state.content.some((item) => item.type === "text")
                          ? part.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
                          : JSON.stringify({ content: part.state.content, structured: part.state.structured }),
                      }
                    : {}),
                  ...(part.state.status === "error" ? { error: part.state.error.message } : {}),
                },
              }
            : part,
        ),
      })
    } else if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
      result.push({
        info: { ...base, role: message.type === "system" ? "system" : "user" },
        parts: [{ type: "text", text: message.text }],
      })
    } else if (message.type === "compaction") {
      result.push({
        info: { ...base, role: "system" },
        parts: [{ type: "compaction" }, { type: "text", text: message.summary }],
      })
    }
  }
  return result
})

/** Materialize a stable, private JSONL snapshot before invoking an external hook. */
export const materialize = Effect.fn("HookTranscript.materialize")(function* (input: {
  readonly sessionID: string
  readonly directory: string
  readonly messages: readonly Message[]
  readonly root?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const root = input.root ?? path.join(Global.Path.data, "hooks", "transcripts")
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
  const file = path.join(root, createHash("sha256").update(input.sessionID).digest("hex") + ".jsonl")
  const temp = file + "." + randomUUID() + ".tmp"
  let parent: string | null = null
  const messages = yield* history(input.sessionID, input.messages)
  const rows = messages
    .filter((item) => item.info.sessionID === input.sessionID)
    .flatMap((item) => {
      const row = {
        type: item.info.role,
        uuid: item.info.id,
        parentUuid: item.info.parentID ?? parent,
        sessionId: input.sessionID,
        cwd: input.directory,
        timestamp: new Date(item.info.time.created).toISOString(),
        message: { role: item.info.role, content: content(item.parts) },
      }
      parent = item.info.id
      const results = item.parts.flatMap((value) => {
        const part = record(value)
        const state = record(part?.state)
        if (!part || part.type !== "tool" || !state || (state.status !== "completed" && state.status !== "error"))
          return []
        return [
          {
            type: "tool_result",
            tool_use_id: part.callID,
            content: state.status === "error" ? state.error : state.output,
            is_error: state.status === "error",
          },
        ]
      })
      if (!results.length) return [JSON.stringify(row)]
      const resultID = `${item.info.id}:tool-results`
      const result = {
        ...row,
        type: "user",
        uuid: resultID,
        parentUuid: item.info.id,
        message: { role: "user", content: results },
      }
      parent = resultID
      return [JSON.stringify(row), JSON.stringify(result)]
    })
  const write = Effect.gen(function* () {
    yield* fs.writeFileString(temp, rows.length ? rows.join("\n") + "\n" : "", { mode: 0o600 })
    yield* fs.rename(temp, file)
    return file
  }).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)))
  const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
  return lifecycle ? yield* lifecycle.serializeTranscript(input.sessionID, write) : yield* write
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
