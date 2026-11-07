export * as RemoteLkg from "./remote-lkg"

import { Global } from "@graphagent/core/global"
import { DateTime, Effect, Option, Schema } from "effect"
import { chmod, rename, rm } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

export type Role = "well-known" | "remote-config"

export type UnavailableReason =
  | "read-failed"
  | "empty-file"
  | "invalid-envelope"
  | "unsupported-version"
  | "invalid-written-at"
  | "empty-body"

export type ReadResult =
  | { readonly status: "missing"; readonly digest: string }
  | { readonly status: "unavailable"; readonly digest: string; readonly reason: UnavailableReason }
  | {
      readonly status: "available"
      readonly digest: string
      readonly writtenAt: string
      readonly ageSeconds: number
      readonly body: string
    }

export interface ReadInput {
  readonly url: string
  readonly role: Role
}

export interface WriteInput extends ReadInput {
  readonly body: string
}

type Rename = (source: string, target: string) => Promise<void>
type WriteFailure = "write" | "rename" | "chmod"

export function digest(url: string) {
  const normalized = new URL(url)
  normalized.hash = ""
  return new Bun.CryptoHasher("sha256").update(normalized.href).digest("hex")
}

export function read(input: ReadInput): Effect.Effect<ReadResult> {
  const key = digest(input.url)
  const target = cacheFile(key)
  return Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(target).exists()))) return { status: "missing", digest: key }
    const content = yield* Effect.tryPromise({
      try: () => Bun.file(target).text(),
      catch: () => "read-failed" as const,
    }).pipe(Effect.catch((reason) => unavailable(input.role, key, reason)))
    if (typeof content !== "string") return content
    if (!content.length) return yield* unavailable(input.role, key, "empty-file")

    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(content)
    if (Option.isNone(parsed) || !isRecord(parsed.value)) {
      return yield* unavailable(input.role, key, "invalid-envelope")
    }
    if (parsed.value.version !== 1) {
      return yield* unavailable(
        input.role,
        key,
        typeof parsed.value.version === "number" ? "unsupported-version" : "invalid-envelope",
      )
    }
    if (typeof parsed.value.writtenAt !== "string") {
      return yield* unavailable(input.role, key, "invalid-envelope")
    }
    const writtenAt = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(parsed.value.writtenAt)
    if (Option.isNone(writtenAt)) return yield* unavailable(input.role, key, "invalid-written-at")
    if (typeof parsed.value.body !== "string") return yield* unavailable(input.role, key, "invalid-envelope")
    if (!parsed.value.body.length) return yield* unavailable(input.role, key, "empty-body")

    const result: ReadResult = {
      status: "available",
      digest: key,
      writtenAt: parsed.value.writtenAt,
      ageSeconds: Math.max(0, Math.floor((Date.now() - DateTime.toEpochMillis(writtenAt.value)) / 1000)),
      body: parsed.value.body,
    }
    return result
  })
}

export function write(input: WriteInput, move: Rename = rename): Effect.Effect<boolean> {
  const key = digest(input.url)
  const target = cacheFile(key)
  const temporary = path.join(path.dirname(target), `.${key}.${process.pid}.${randomUUID()}.tmp`)
  const update = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        Bun.write(temporary, JSON.stringify({ version: 1, writtenAt: new Date().toISOString(), body: input.body }), {
          mode: 0o600,
          createPath: true,
        }),
      catch: () => "write" as const,
    })
    yield* Effect.tryPromise({
      try: () => move(temporary, target),
      catch: () => "rename" as const,
    })
    yield* Effect.tryPromise({
      try: () => chmod(target, 0o600),
      catch: () => "chmod" as const,
    })
    return true
  })
  return update.pipe(
    Effect.catch((reason: WriteFailure) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("failed to update remote config LKG", {
          digest: key,
          role: input.role,
          reason,
        })
        yield* Effect.promise(() => rm(temporary, { force: true }).catch(() => undefined))
        return false
      }),
    ),
  )
}

function cacheFile(key: string) {
  return path.join(Global.Path.cache, "remote-config-lkg", `${key}.json`)
}

function unavailable(role: Role, key: string, reason: UnavailableReason): Effect.Effect<ReadResult> {
  return Effect.logWarning("remote config LKG unavailable", { digest: key, role, reason }).pipe(
    Effect.as({ status: "unavailable", digest: key, reason } as const),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
