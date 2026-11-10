// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * `trust.json` persistence for project trust (T1 PR2).
 *
 * The file lives next to `kv.json` in the XDG state directory, is written with
 * mode 0600 and is replaced atomically (same-directory temporary file plus
 * rename). A missing file is a normal empty record. A corrupt file or an
 * unknown version is also read as an empty record, with one warning, and is
 * left untouched until the next successful write.
 */
import path from "path"
import { Cause, Effect } from "effect"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { isRecord } from "@/util/record"

export const TRUST_FILE_NAME = "trust.json"
export const TRUST_VERSION = 1

export type TrustDecision = "trusted" | "declined"

export interface TrustRecord {
  fp: string
  decision: TrustDecision
  decidedAt: number
  command?: string
}

export interface TrustProjectRecord {
  root: string
  remote?: string
  entries: Record<string, TrustRecord>
}

export interface TrustFile {
  version: typeof TRUST_VERSION
  projects: Record<string, TrustProjectRecord>
}

/** The path of the shared trust file. The state directory is injectable so tests stay isolated. */
export function trustFilePath(stateDirectory: string = Global.Path.state) {
  return path.join(stateDirectory, TRUST_FILE_NAME)
}

export function emptyTrustFile(): TrustFile {
  return { version: TRUST_VERSION, projects: {} }
}

export interface Store {
  readonly file: string
  /** Never fails: unreadable or invalid content falls back to an empty record. */
  readonly read: Effect.Effect<TrustFile>
  /** Writes atomically; returns false (after logging) when the write fails. */
  readonly write: (data: TrustFile) => Effect.Effect<boolean>
}

export interface StoreInput {
  file: string
  fs: FSUtil.Interface
}

export function make(input: StoreInput): Store {
  const read = Effect.gen(function* () {
    const text = yield* input.fs.readFileStringSafe(input.file).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to read the project trust file; using an empty record", {
          file: input.file,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    )
    if (text === undefined) return emptyTrustFile()
    const decoded = decodeTrustFile(text)
    if (decoded) return decoded
    yield* Effect.logWarning("the project trust file is corrupt or has an unknown version; using an empty record", {
      file: input.file,
    })
    return emptyTrustFile()
  })

  const write = (data: TrustFile) =>
    Effect.gen(function* () {
      yield* input.fs.ensureDir(path.dirname(input.file))
      const temporary = `${input.file}.${process.pid}.${crypto.randomUUID()}.tmp`
      const cleanup = input.fs.existsSafe(temporary).pipe(
        Effect.flatMap((exists) => (exists ? input.fs.remove(temporary) : Effect.void)),
        Effect.ignore,
      )
      yield* input.fs
        .writeFileString(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
        .pipe(Effect.andThen(input.fs.rename(temporary, input.file)), Effect.ensuring(cleanup))
      yield* input.fs.chmod(input.file, 0o600)
      return true
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("failed to write the project trust file", {
          file: input.file,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    )

  return { file: input.file, read, write }
}

function decodeTrustFile(text: string): TrustFile | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.version !== TRUST_VERSION) return undefined
  if (!isRecord(value.projects)) return undefined

  const projects: Record<string, TrustProjectRecord> = {}
  for (const [id, candidate] of Object.entries(value.projects)) {
    const project = decodeProject(candidate)
    if (!project) return undefined
    projects[id] = project
  }
  return { version: TRUST_VERSION, projects }
}

function decodeProject(value: unknown): TrustProjectRecord | undefined {
  if (!isRecord(value) || typeof value.root !== "string") return undefined
  if (value.remote !== undefined && typeof value.remote !== "string") return undefined
  if (!isRecord(value.entries)) return undefined

  const entries: Record<string, TrustRecord> = {}
  for (const [id, candidate] of Object.entries(value.entries)) {
    const record = decodeRecord(candidate)
    if (!record) return undefined
    entries[id] = record
  }
  return {
    root: value.root,
    ...(typeof value.remote === "string" ? { remote: value.remote } : {}),
    entries,
  }
}

function decodeRecord(value: unknown): TrustRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.fp !== "string") return undefined
  if (value.decision !== "trusted" && value.decision !== "declined") return undefined
  if (typeof value.decidedAt !== "number" || !Number.isFinite(value.decidedAt)) return undefined
  if (value.command !== undefined && typeof value.command !== "string") return undefined
  return {
    fp: value.fp,
    decision: value.decision,
    decidedAt: value.decidedAt,
    ...(typeof value.command === "string" ? { command: value.command } : {}),
  }
}
