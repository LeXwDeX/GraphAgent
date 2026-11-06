import { expect } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Schema } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { readdir, stat } from "fs/promises"
import path from "path"

import { RemoteLkg } from "@/config/remote-lkg"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const file = (url: string) => path.join(Global.Path.cache, "remote-config-lkg", `${RemoteLkg.digest(url)}.json`)

const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  writtenAt: Schema.String,
  body: Schema.String,
})

it.live(
  "normalizes equivalent URLs to one stable credential-free digest",
  Effect.sync(() => {
    const first = RemoteLkg.digest(
      "HTTPS://LKG-Key.Example.COM:443/path/config?QUERY_CREDENTIAL_MARKER=1#IGNORED_FRAGMENT_MARKER",
    )
    const second = RemoteLkg.digest("https://lkg-key.example.com/path/config?QUERY_CREDENTIAL_MARKER=1")

    expect(first).toBe("5eb35456bf3eca724774dbab344826a95d8531c2c37aba3520a3dbeb3055f4b2")
    expect(second).toBe(first)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain("QUERY_CREDENTIAL_MARKER")
    expect(RemoteLkg.digest("https://lkg-key.example.com/path/config?different=1")).not.toBe(first)
  }),
)

it.live(
  "writes the exact pre-expansion body in a minimal private envelope",
  Effect.gen(function* () {
    const url = "https://lkg-envelope.example.com/config?QUERY_ENVELOPE_SECRET_MARKER=1"
    const body = JSON.stringify({
      username: "{env:TEST_TOKEN}",
      marker: "RAW_REMOTE_BODY_MARKER",
    })
    const expandedSecret = "EXPANDED_ENV_SECRET_MARKER"
    const headerSecret = "AUTHORIZATION_HEADER_SECRET_MARKER"

    expect(yield* RemoteLkg.write({ url, role: "remote-config", body })).toBe(true)

    const content = yield* Effect.promise(() => Bun.file(file(url)).text())
    const unknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(content)
    if (typeof unknown !== "object" || unknown === null || Array.isArray(unknown)) {
      throw new Error("LKG envelope is not an object")
    }
    const envelope = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(content)
    expect(envelope.version).toBe(1)
    expect(envelope.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(envelope.body).toBe(body)
    expect(Object.keys(unknown).sort()).toEqual(["body", "version", "writtenAt"])
    expect(content).not.toContain(expandedSecret)
    expect(content).not.toContain(headerSecret)
    expect(path.basename(file(url))).not.toContain("QUERY_ENVELOPE_SECRET_MARKER")

    if (process.platform !== "win32") {
      expect((yield* Effect.promise(() => stat(file(url)))).mode & 0o777).toBe(0o600)
    }
    const digest = RemoteLkg.digest(url)
    expect(
      (yield* Effect.promise(() => readdir(path.dirname(file(url))))).filter((name) => name.includes(digest)),
    ).toEqual([`${digest}.json`])
  }),
)

it.live(
  "publishes one complete envelope under concurrent writes",
  Effect.gen(function* () {
    const url = "https://lkg-concurrent.example.com/config.json"
    const bodies = ["CONCURRENT_BODY_ALPHA", "CONCURRENT_BODY_BETA"]

    yield* Effect.all(
      bodies.map((body) => RemoteLkg.write({ url, role: "remote-config", body })),
      { concurrency: "unbounded" },
    )

    const result = yield* RemoteLkg.read({ url, role: "remote-config" })
    expect(result.status).toBe("available")
    if (result.status !== "available") return
    expect(bodies).toContain(result.body)
    const content = yield* Effect.promise(() => Bun.file(file(url)).text())
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(content).body).toBe(result.body)
  }),
)

it.live(
  "uses a same-directory rename and preserves the old LKG when rename fails",
  Effect.gen(function* () {
    const url = "https://lkg-rename.example.com/config?RENAME_QUERY_SECRET_MARKER=1"
    const calls: { source?: string; target?: string } = {}
    expect(yield* RemoteLkg.write({ url, role: "remote-config", body: "OLD_LKG_BODY" })).toBe(true)

    const updated = yield* RemoteLkg.write(
      { url, role: "remote-config", body: "NEW_LKG_BODY_SECRET_MARKER" },
      async (source, target) => {
        calls.source = source
        calls.target = target
        throw new Error("RENAME_ERROR_SECRET_MARKER")
      },
    )

    expect(updated).toBe(false)
    const source = calls.source
    const target = calls.target
    if (!source || !target) throw new Error("rename was not attempted")
    expect(path.dirname(source)).toBe(path.dirname(target))
    expect(target).toBe(file(url))
    expect(yield* Effect.promise(() => Bun.file(source).exists())).toBe(false)
    const result = yield* RemoteLkg.read({ url, role: "remote-config" })
    expect(result.status).toBe("available")
    if (result.status === "available") expect(result.body).toBe("OLD_LKG_BODY")

    const logs = JSON.stringify(yield* logLines)
    expect(logs).toContain("failed to update remote config LKG")
    expect(logs).not.toContain("RENAME_QUERY_SECRET_MARKER")
    expect(logs).not.toContain("NEW_LKG_BODY_SECRET_MARKER")
    expect(logs).not.toContain("RENAME_ERROR_SECRET_MARKER")
  }),
)

it.live(
  "classifies empty and damaged cache records without logging their content",
  Effect.gen(function* () {
    const cases: { name: string; content: string; reason: RemoteLkg.UnavailableReason }[] = [
      { name: "empty-file", content: "", reason: "empty-file" },
      { name: "invalid-envelope", content: "{CORRUPT_ENVELOPE_SECRET_MARKER", reason: "invalid-envelope" },
      {
        name: "unsupported-version",
        content: JSON.stringify({ version: 2, writtenAt: "2026-08-09T00:00:00.000Z", body: "body" }),
        reason: "unsupported-version",
      },
      {
        name: "invalid-written-at",
        content: JSON.stringify({ version: 1, writtenAt: "not-a-date", body: "body" }),
        reason: "invalid-written-at",
      },
      {
        name: "empty-body",
        content: JSON.stringify({ version: 1, writtenAt: "2026-08-09T00:00:00.000Z", body: "" }),
        reason: "empty-body",
      },
    ]

    yield* Effect.forEach(
      cases,
      (scenario) =>
        Effect.gen(function* () {
          const url = `https://lkg-unavailable-${scenario.name}.example.com/config.json`
          yield* Effect.promise(() => Bun.write(file(url), scenario.content, { mode: 0o600 }))
          const result = yield* RemoteLkg.read({ url, role: "remote-config" })
          expect(result.status).toBe("unavailable")
          if (result.status === "unavailable") expect(result.reason).toBe(scenario.reason)
        }),
      { discard: true },
    )

    const logs = JSON.stringify(yield* logLines)
    expect(logs).toContain("remote config LKG unavailable")
    expect(logs).not.toContain("CORRUPT_ENVELOPE_SECRET_MARKER")
  }),
)

it.live(
  "returns a very old valid record without applying TTL",
  Effect.gen(function* () {
    const url = "https://lkg-no-ttl.example.com/config.json"
    yield* Effect.promise(() =>
      Bun.write(
        file(url),
        JSON.stringify({ version: 1, writtenAt: "2000-01-01T00:00:00.000Z", body: "VERY_OLD_VALID_BODY" }),
        { mode: 0o600 },
      ),
    )

    const result = yield* RemoteLkg.read({ url, role: "remote-config" })
    expect(result.status).toBe("available")
    if (result.status !== "available") return
    expect(result.body).toBe("VERY_OLD_VALID_BODY")
    expect(result.writtenAt).toBe("2000-01-01T00:00:00.000Z")
    expect(result.ageSeconds).toBeGreaterThan(20 * 365 * 24 * 60 * 60)
  }),
)
