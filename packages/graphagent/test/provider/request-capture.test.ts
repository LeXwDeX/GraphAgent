// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// GRAPHAGENT_DEBUG_REQUESTS=1 writes every request of the AI SDK path to the data directory (#1461). The writer is
// exercised against temp directories through its `dir` parameter, then end to end through a real Provider with the
// flag on, off, on but unable to write, and on with slow storage. The interleavings of writing and pruning are set up
// by hooking the file system calls, so they are deterministic. Only fake credentials appear here.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Stats } from "node:fs"
import fs from "node:fs/promises"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import path from "node:path"
import { streamText } from "ai"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { ModelV2 } from "@graphagent/core/model"
import { ModelsDev } from "@graphagent/core/models-dev"
import { ProviderV2 } from "@graphagent/core/provider"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderAdapters } from "@/provider/adapter/registry"
import { Provider } from "@/provider/provider"
import { RequestCapture } from "@/provider/request-capture"
import * as Log from "@/util/log"
import { disposeAllInstances, provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

afterEach(async () => {
  await disposeAllInstances()
})

const DAY = 24 * 60 * 60 * 1000
const URL_OK = "https://api.example.test/v1/chat/completions"
const SESSION = "ses_capture_unit"
const FAKE = "FAKE-SECRET-VALUE"

type Call = { input?: unknown; method?: string; headers?: HeadersInit; body?: unknown }

/** One request through `record`, defaulting to a JSON POST that carries the session header. */
function send(dir: string, call: Call = {}) {
  const headers = "headers" in call ? call.headers : { "X-Session-Id": SESSION }
  const body = "body" in call ? call.body : JSON.stringify({ model: "m", messages: [] })
  return RequestCapture.record(
    { input: call.input ?? URL_OK, init: { method: call.method ?? "POST", headers, body } },
    dir,
  )
}

const stepFile = (step: number) => `${String(step).padStart(4, "0")}.json`

/** The `node:fs/promises` calls the tests hook: the very object the code under test calls through, with one signature each. */
const hooked: {
  stat: (file: string) => Promise<Stats>
  readdir: (dir: string, options?: { withFileTypes?: false }) => Promise<string[]>
} = fs

async function readStep(dir: string, session: string, step: number) {
  return JSON.parse(await fs.readFile(path.join(dir, session, stepFile(step)), "utf8"))
}

/** Sets the mtime of a session directory and of every file in it to `days` days ago. */
async function age(dir: string, session: string, days: number) {
  const when = new Date(Date.now() - days * DAY)
  const sessionDir = path.join(dir, session)
  for (const name of await fs.readdir(sessionDir)) await fs.utimes(path.join(sessionDir, name), when, when)
  await fs.utimes(sessionDir, when, when)
}

/** A session directory with one empty step file per age in `days`. */
async function seedSession(dir: string, session: string, days: number[]) {
  const sessionDir = path.join(dir, session)
  await fs.mkdir(sessionDir, { recursive: true })
  for (const [index, daysOld] of days.entries()) {
    const file = path.join(sessionDir, stepFile(index + 1))
    const when = new Date(Date.now() - daysOld * DAY)
    await fs.writeFile(file, "{}")
    await fs.utimes(file, when, when)
  }
}

describe("RequestCapture.record", () => {
  test("writes one numbered file per request with the documented shape", async () => {
    await using tmp = await tmpdir()
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
    const headers = { "X-Session-Id": SESSION, "Content-Type": "application/json" }
    const before = Date.now()
    await send(tmp.path, { headers, body: JSON.stringify(body) })
    await send(tmp.path, { headers, body: JSON.stringify(body), method: "post" })

    expect((await fs.readdir(path.join(tmp.path, SESSION))).toSorted()).toEqual(["0001.json", "0002.json"])
    const first = await readStep(tmp.path, SESSION, 1)
    expect(Object.keys(first)).toEqual(["sessionID", "step", "time", "method", "url", "headers", "body"])
    expect(first).toMatchObject({
      sessionID: SESSION,
      step: 1,
      method: "POST",
      url: URL_OK,
      headers: { "x-session-id": SESSION, "content-type": "application/json" },
      body,
    })
    expect(Date.parse(first.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(first.time)).toBeLessThanOrEqual(Date.now())
    expect((await readStep(tmp.path, SESSION, 2)).step).toBe(2)
    expect((await readStep(tmp.path, SESSION, 2)).method).toBe("POST")
  })

  test("numbers the next step after the highest file in the directory", async () => {
    await using tmp = await tmpdir()
    await seedSession(tmp.path, SESSION, [0, 0, 0, 0, 0])
    await fs.rm(path.join(tmp.path, SESSION, stepFile(2)))
    await fs.writeFile(path.join(tmp.path, SESSION, "notes.txt"), "not a step")

    await send(tmp.path)

    expect(await RequestCapture.list(SESSION, tmp.path)).toEqual([1, 3, 4, 5, 6])
    expect((await readStep(tmp.path, SESSION, 6)).step).toBe(6)
  })

  test("stores a JSON object or array as data and any other body as the text sent", async () => {
    await using tmp = await tmpdir()
    const bodies = ['{"a":[1,2]}', "[1,2]", "plain text, not json", "42", "null", ""]
    for (const body of bodies) await send(tmp.path, { body })

    const stored = await Promise.all(
      bodies.map(async (_, index) => (await readStep(tmp.path, SESSION, index + 1)).body),
    )
    expect(stored).toEqual([{ a: [1, 2] }, [1, 2], "plain text, not json", "42", "null", ""])
  })

  test("takes headers from a Headers object, an array of pairs or a plain object, with lower-case names", async () => {
    await using tmp = await tmpdir()
    const pairs: [string, string][] = [
      ["X-Session-Id", SESSION],
      ["Accept", "text/event-stream"],
    ]
    await send(tmp.path, { headers: new Headers({ "X-Session-Id": SESSION, Accept: "text/event-stream" }) })
    await send(tmp.path, { headers: pairs })
    await send(tmp.path, { headers: { "X-Session-Id": SESSION, Accept: "text/event-stream" } })

    for (const step of [1, 2, 3]) {
      expect((await readStep(tmp.path, SESSION, step)).headers).toEqual({
        accept: "text/event-stream",
        "x-session-id": SESSION,
      })
    }
  })

  test("files a request without a usable x-session-id under _unattributed", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "captures")
    const unusable = [undefined, "", "../escape", "a/b", "has space", "ünï", "x".repeat(129)]
    for (const value of unusable) await send(dir, { headers: value === undefined ? {} : { "x-session-id": value } })
    await send(dir, { headers: { "x-session-id": "a".repeat(128) } })
    await send(dir, { headers: undefined })

    expect((await fs.readdir(dir)).sort()).toEqual(["_unattributed", "a".repeat(128)])
    expect(await RequestCapture.list("_unattributed", dir)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Nothing was written next to the capture directory by a path-shaped header.
    expect(await fs.readdir(tmp.path)).toEqual(["captures"])
  })

  test("writes [REDACTED] for every header whose name suggests a credential", async () => {
    await using tmp = await tmpdir()
    const secret = [
      "Authorization",
      "Proxy-Authorization",
      "x-api-key",
      "api-key",
      "X-Goog-Api-Key",
      "Cookie",
      "Set-Cookie",
      "x-auth-token",
      "x-amz-security-token",
      "x-amz-signature",
      "x-client-secret",
      "x-credential",
      "x-password",
    ]
    const plain = {
      "Content-Type": "application/json",
      "User-Agent": "graphagent/test",
      Accept: "text/event-stream",
      "x-parent-session-id": "ses_parent",
      "x-session-affinity": SESSION,
    }
    await send(tmp.path, {
      headers: { ...plain, "X-Session-Id": SESSION, ...Object.fromEntries(secret.map((name) => [name, FAKE])) },
    })

    const text = await fs.readFile(path.join(tmp.path, SESSION, stepFile(1)), "utf8")
    expect(text).not.toContain(FAKE)
    const headers = JSON.parse(text).headers
    for (const name of secret) expect(headers[name.toLowerCase()]).toBe("[REDACTED]")
    for (const [name, value] of Object.entries(plain)) expect(headers[name.toLowerCase()]).toBe(value)
    expect(headers["x-session-id"]).toBe(SESSION)
  })

  test("writes REDACTED for URL credentials and for query parameters whose name suggests a credential", async () => {
    await using tmp = await tmpdir()
    const raw =
      "https://user:FAKE-PASS@api.example.test/v1/models/m:streamGenerateContent?alt=sse&key=FAKE-KEY&Token=FAKE-TOKEN&x-goog-signature=FAKE-SIG&api-version=2024-10-21"
    await send(tmp.path, { input: raw })
    await send(tmp.path, { input: new URL(raw) })
    await send(tmp.path, { input: "https://only-user@api.example.test/v1/x" })
    await send(tmp.path, { input: "https://api.example.test/v1/models?api-version=2024-10-21&alt=sse" })

    const redacted =
      "https://REDACTED:REDACTED@api.example.test/v1/models/m:streamGenerateContent?alt=sse&key=REDACTED&Token=REDACTED&x-goog-signature=REDACTED&api-version=2024-10-21"
    expect((await readStep(tmp.path, SESSION, 1)).url).toBe(redacted)
    expect((await readStep(tmp.path, SESSION, 2)).url).toBe(redacted)
    expect((await readStep(tmp.path, SESSION, 3)).url).toBe("https://REDACTED@api.example.test/v1/x")
    // Nothing to hide: the URL is recorded exactly as sent.
    expect((await readStep(tmp.path, SESSION, 4)).url).toBe(
      "https://api.example.test/v1/models?api-version=2024-10-21&alt=sse",
    )
    const all = await Promise.all(
      [1, 2, 3, 4].map((step) => fs.readFile(path.join(tmp.path, SESSION, stepFile(step)), "utf8")),
    )
    for (const text of all)
      for (const secret of ["FAKE-PASS", "FAKE-KEY", "FAKE-TOKEN", "FAKE-SIG", "only-user"]) {
        expect(text).not.toContain(secret)
      }
  })

  test("records a URL it cannot parse as [unparseable url]", async () => {
    await using tmp = await tmpdir()
    await send(tmp.path, { input: "/relative/path?key=FAKE-KEY" })
    await send(tmp.path, { input: "not a url at all" })

    for (const step of [1, 2]) expect((await readStep(tmp.path, SESSION, step)).url).toBe("[unparseable url]")
    expect(await fs.readFile(path.join(tmp.path, SESSION, stepFile(1)), "utf8")).not.toContain("FAKE-KEY")
  })

  test("skips what it cannot record: an input that is not a string or URL, a body that is not a string", async () => {
    await using tmp = await tmpdir()
    const init = { method: "POST", headers: { "X-Session-Id": SESSION }, body: "{}" }
    await send(tmp.path, { input: new Request("https://api.example.test/v1/x") })
    await send(tmp.path, { input: { url: URL_OK } })
    await send(tmp.path, { input: 42 })
    await RequestCapture.record({ input: undefined, init }, tmp.path)
    await send(tmp.path, { body: undefined })
    await send(tmp.path, { body: new Uint8Array([123, 125]) })
    await send(tmp.path, { body: new URLSearchParams({ a: "b" }) })
    await RequestCapture.record({ input: URL_OK }, tmp.path)

    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("creates the session directory 0700 and each file 0600", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "captures")
    await send(dir)

    expect((await fs.stat(path.join(dir, SESSION))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(dir, SESSION, stepFile(1)))).mode & 0o777).toBe(0o600)
  })

  test("gives concurrent requests of one session distinct steps and loses none", async () => {
    await using tmp = await tmpdir()
    await Promise.all(Array.from({ length: 12 }, (_, index) => send(tmp.path, { body: JSON.stringify({ index }) })))

    expect(await RequestCapture.list(SESSION, tmp.path)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
    const seen = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => (await readStep(tmp.path, SESSION, index + 1)).body.index),
    )
    expect(seen.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })

  test("never throws: a directory that cannot be written is a logged warning", async () => {
    await using tmp = await tmpdir()
    const blocker = path.join(tmp.path, "blocker")
    await fs.writeFile(blocker, "a file where the capture directory should be")
    const entries: Log.Entry[] = []
    const restore = Log.setSink((entry) => entries.push(entry))
    try {
      expect(await send(path.join(blocker, "captures"))).toBeUndefined()
      await Log.flush()
    } finally {
      restore()
    }

    const warnings = entries.filter((entry) => entry.level === "warn")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.service).toBe("provider.request-capture")
    expect(warnings[0]?.message).not.toContain(FAKE)
  })

  test("leaves its arguments as they were", async () => {
    await using tmp = await tmpdir()
    const headers = new Headers({ Authorization: `Bearer ${FAKE}`, "X-Session-Id": SESSION })
    const init = { method: "POST", headers, body: JSON.stringify({ a: 1 }) }
    const before = { ...init }
    const input = new URL("https://user:pass@api.example.test/v1/x?key=FAKE-KEY")

    await RequestCapture.record({ input, init }, tmp.path)

    expect(init).toEqual(before)
    expect(init.headers).toBe(headers)
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE}`)
    expect(input.href).toBe("https://user:pass@api.example.test/v1/x?key=FAKE-KEY")
  })

  test("never prunes: a request scans no directory but its own session's, and old sessions are left to cleanup", async () => {
    await using tmp = await tmpdir()
    await send(tmp.path, { headers: { "x-session-id": "ses_old" } })
    await age(tmp.path, "ses_old", 8)
    const realReaddir = fs.readdir
    const scanned: string[] = []
    const spy = spyOn(hooked, "readdir").mockImplementation(async (dir, options) => {
      scanned.push(dir)
      return realReaddir(dir, options)
    })
    try {
      await send(tmp.path, { headers: { "x-session-id": "ses_new" } })
    } finally {
      spy.mockRestore()
    }

    expect(scanned).not.toContain(tmp.path)
    expect((await fs.readdir(tmp.path)).sort()).toEqual(["ses_new", "ses_old"])
  })

  test("recovers when pruning removes the session directory between the check and the write", async () => {
    await using tmp = await tmpdir()
    await send(tmp.path)
    const sessionDir = path.join(tmp.path, SESSION)
    const realWrite = fs.writeFile
    let removed = false
    const spy = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (!removed && typeof file === "string" && file.startsWith(sessionDir)) {
        removed = true
        // The pruning wins the race: the directory is gone when the request tries to write into it.
        await fs.rm(sessionDir, { recursive: true, force: true })
      }
      return realWrite(file, data, options)
    })
    const entries: Log.Entry[] = []
    const restore = Log.setSink((entry) => entries.push(entry))
    try {
      await send(tmp.path)
      await Log.flush()
    } finally {
      spy.mockRestore()
      restore()
    }

    expect(removed).toBe(true)
    expect(await RequestCapture.list(SESSION, tmp.path)).toEqual([1])
    expect(entries.filter((entry) => entry.level === "warn")).toHaveLength(0)
  })
})

describe("RequestCapture.list and read", () => {
  test("list returns the steps in ascending numeric order and ignores other files", async () => {
    await using tmp = await tmpdir()
    await seedSession(tmp.path, SESSION, [0, 0, 0])
    await fs.rename(path.join(tmp.path, SESSION, stepFile(2)), path.join(tmp.path, SESSION, "0010.json"))
    await fs.writeFile(path.join(tmp.path, SESSION, "readme.txt"), "x")
    await fs.writeFile(path.join(tmp.path, SESSION, "0004.json.tmp"), "x")

    expect(await RequestCapture.list(SESSION, tmp.path)).toEqual([1, 3, 10])
  })

  test("list is empty for an unknown session and for a session id that is not a plain name", async () => {
    await using tmp = await tmpdir()
    const outside = path.join(tmp.path, "outside")
    await seedSession(tmp.path, "outside", [0])
    const dir = path.join(tmp.path, "captures")
    await fs.mkdir(dir)

    expect(await RequestCapture.list("ses_missing", dir)).toEqual([])
    expect(await RequestCapture.list("../outside", dir)).toEqual([])
    expect(await RequestCapture.list("", dir)).toEqual([])
    expect(await RequestCapture.list(path.join("..", "outside"), dir)).toEqual([])
    expect(await fs.readdir(outside)).toEqual([stepFile(1)])
    expect(await RequestCapture.list("ses_missing", path.join(tmp.path, "no-such-dir"))).toEqual([])
  })

  test("read returns the recorded request, or undefined when it is missing, unreadable or out of the directory", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "captures")
    await send(dir, { body: JSON.stringify({ marker: 7 }) })
    await fs.writeFile(path.join(dir, SESSION, stepFile(2)), "{ torn")
    await seedSession(tmp.path, "outside", [0])
    await fs.writeFile(path.join(tmp.path, "outside", stepFile(1)), JSON.stringify({ secret: true }))

    expect(await RequestCapture.read(SESSION, 1, dir)).toMatchObject({
      sessionID: SESSION,
      step: 1,
      body: { marker: 7 },
    })
    expect(await RequestCapture.read(SESSION, 2, dir)).toBeUndefined()
    expect(await RequestCapture.read(SESSION, 3, dir)).toBeUndefined()
    expect(await RequestCapture.read("ses_missing", 1, dir)).toBeUndefined()
    expect(await RequestCapture.read("../outside", 1, dir)).toBeUndefined()
  })
})

describe("RequestCapture.cleanup", () => {
  test("removes session directories whose newest file is over 7 days old and keeps the rest", async () => {
    await using tmp = await tmpdir()
    await seedSession(tmp.path, "ses_8_days", [8])
    await seedSession(tmp.path, "ses_6_days", [6])
    await seedSession(tmp.path, "ses_mixed", [9, 8, 1])
    await seedSession(tmp.path, "ses_all_old", [30, 9, 8])
    await seedSession(tmp.path, "_unattributed", [8])
    await seedSession(tmp.path, "not a session!", [30])
    await fs.writeFile(path.join(tmp.path, "notes.txt"), "kept")
    const old = new Date(Date.now() - 30 * DAY)
    await fs.utimes(path.join(tmp.path, "notes.txt"), old, old)

    await RequestCapture.cleanup(Date.now(), tmp.path)

    expect((await fs.readdir(tmp.path)).sort()).toEqual(
      ["notes.txt", "not a session!", "ses_6_days", "ses_mixed"].sort(),
    )
  })

  test("measures age against the `now` it is given", async () => {
    await using tmp = await tmpdir()
    await seedSession(tmp.path, "ses_6_days", [6])

    await RequestCapture.cleanup(Date.now(), tmp.path)
    expect(await fs.readdir(tmp.path)).toEqual(["ses_6_days"])

    await RequestCapture.cleanup(Date.now() + 2 * DAY, tmp.path)
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("dates a session directory without files by the directory itself", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "ses_empty_new"))
    await fs.mkdir(path.join(tmp.path, "ses_empty_old"))
    const old = new Date(Date.now() - 8 * DAY)
    await fs.utimes(path.join(tmp.path, "ses_empty_old"), old, old)

    await RequestCapture.cleanup(Date.now(), tmp.path)

    expect(await fs.readdir(tmp.path)).toEqual(["ses_empty_new"])
  })

  test("a request written while a session is being pruned survives: only files seen to be old are deleted", async () => {
    await using tmp = await tmpdir()
    await seedSession(tmp.path, SESSION, [9, 9, 9])
    const sessionPrefix = path.join(tmp.path, SESSION) + path.sep
    const realStat = fs.stat
    let looked = 0
    const spy = spyOn(hooked, "stat").mockImplementation(async (file) => {
      const info = await realStat(file)
      // The pruning has now looked at all three old files and decided the session is idle; before it deletes
      // anything the session resumes and a new request is written.
      if (file.startsWith(sessionPrefix) && ++looked === 3) await send(tmp.path)
      return info
    })
    try {
      await RequestCapture.cleanup(Date.now(), tmp.path)
    } finally {
      spy.mockRestore()
    }

    expect(looked).toBeGreaterThanOrEqual(3)
    expect(await RequestCapture.list(SESSION, tmp.path)).toContain(4)
    expect(await readStep(tmp.path, SESSION, 4)).toMatchObject({ sessionID: SESSION, step: 4 })
  })

  test("ignores errors: a missing or unreadable directory is not a failure", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "a-file")
    await fs.writeFile(file, "x")

    expect(await RequestCapture.cleanup(Date.now(), path.join(tmp.path, "missing"))).toBeUndefined()
    expect(await RequestCapture.cleanup(Date.now(), file)).toBeUndefined()
  })
})

// ── through a real Provider ─────────────────────────────────────────────────

const providerLayer = (flags: Partial<RuntimeFlags.Info>) =>
  Provider.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(ProviderAdapters.defaultLayer),
    Layer.provide(ModelsDev.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
    Layer.provide(EventV2Bridge.defaultLayer),
  )

const capturing = testEffect(
  Layer.mergeAll(providerLayer({ debugRequests: true }), Env.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const silent = testEffect(
  Layer.mergeAll(providerLayer({ debugRequests: false }), Env.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

/** Answers every request with a one-word SSE stream and keeps the headers it received. */
async function replyingServer(): Promise<{ server: Server; url: string; received: IncomingHttpHeaders[] }> {
  const received: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    received.push(req.headers)
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}`, received }
}

const uniqueSession = (label: string) => `ses_capture_${label}_${Math.random().toString(36).slice(2, 10)}`

/** The `test` provider pointed at `url`, with `options` (a timeout, say) added to its provider options. */
const providerConfig = (url: string, options: Record<string, unknown>) => {
  const base = testProviderConfig(url)
  return {
    ...base,
    provider: { test: { ...base.provider.test, options: { ...base.provider.test.options, ...options } } },
  }
}

/** One `streamText` call through the real Provider and the `test` provider pointed at `url`, tagged with `sessionID`. */
const callProvider = (url: string, sessionID: string, options: Record<string, unknown> = {}) =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
        const result = streamText({
          model: yield* provider.getLanguage(model),
          headers: { "X-Session-Id": sessionID },
          messages: [{ role: "user", content: "hello capture" }],
        })
        return yield* Effect.promise(() => result.text)
      }),
    { config: providerConfig(url, options) },
  )

const sessionDirOf = (sessionID: string) => path.join(RequestCapture.DIR, sessionID)
const removeSession = (sessionID: string) =>
  Effect.promise(() => fs.rm(sessionDirOf(sessionID), { recursive: true, force: true }))

capturing.live(
  "with the flag on, a real provider call is written to the data directory with credentials redacted",
  () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => replyingServer()),
        (value) => Effect.sync(() => value.server.close()),
      )
      const sessionID = uniqueSession("on")
      yield* Effect.addFinalizer(() => removeSession(sessionID))

      expect(yield* callProvider(server.url, sessionID)).toBe("ok")

      expect(yield* Effect.promise(() => RequestCapture.list(sessionID))).toEqual([1])
      const file = yield* Effect.promise(() => fs.readFile(path.join(sessionDirOf(sessionID), stepFile(1)), "utf8"))
      const captured = JSON.parse(file)
      expect(captured).toMatchObject({
        sessionID,
        step: 1,
        method: "POST",
        url: `${server.url}/chat/completions`,
        headers: { authorization: "[REDACTED]", "x-session-id": sessionID },
        body: { model: "test-model", messages: [{ role: "user", content: "hello capture" }] },
      })
      expect(file).not.toContain("test-key")
      // The request itself still carried the real credential.
      expect(server.received).toHaveLength(1)
      expect(server.received[0]?.authorization).toBe("Bearer test-key")
    }),
)

silent.live("with the flag off, a real provider call writes nothing", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => replyingServer()),
      (value) => Effect.sync(() => value.server.close()),
    )
    const sessionID = uniqueSession("off")
    yield* Effect.addFinalizer(() => removeSession(sessionID))

    expect(yield* callProvider(server.url, sessionID)).toBe("ok")

    expect(server.received).toHaveLength(1)
    expect(yield* Effect.promise(() => RequestCapture.list(sessionID))).toEqual([])
    const exists = yield* Effect.promise(() =>
      fs.stat(sessionDirOf(sessionID)).then(
        () => true,
        () => false,
      ),
    )
    expect(exists).toBe(false)
  }),
)

capturing.live(
  "with the flag on but the data directory unwritable, the request is still sent and a warning is logged",
  () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => replyingServer()),
        (value) => Effect.sync(() => value.server.close()),
      )
      // A regular file where the capture directory belongs: no one can create a directory below it.
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await fs.mkdir(path.dirname(RequestCapture.DIR), { recursive: true })
          await fs.rm(RequestCapture.DIR, { recursive: true, force: true })
          await fs.writeFile(RequestCapture.DIR, "not a directory")
        }),
        () => Effect.promise(() => fs.rm(RequestCapture.DIR, { recursive: true, force: true })),
      )
      const entries: Log.Entry[] = []
      const restore = Log.setSink((entry) => entries.push(entry))
      yield* Effect.addFinalizer(() => Effect.sync(restore))

      expect(yield* callProvider(server.url, uniqueSession("blocked"))).toBe("ok")
      yield* Effect.promise(() => Log.flush())

      expect(server.received).toHaveLength(1)
      expect(
        entries.filter((entry) => entry.level === "warn" && entry.service === "provider.request-capture"),
      ).toHaveLength(1)
    }),
)

/** Every write below the capture directory takes `ms` longer, as on slow storage. */
const slowCaptureWrites = (ms: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const realWrite = fs.writeFile
      return spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        if (typeof file === "string" && file.startsWith(RequestCapture.DIR)) await Bun.sleep(ms)
        return realWrite(file, data, options)
      })
    }),
    (spy) => Effect.sync(() => spy.mockRestore()),
  )

for (const [name, options] of [
  ["response-header timeout", { headerTimeout: 300 }],
  ["overall timeout", { timeout: 500 }],
] as const) {
  capturing.live(`with the flag on, a capture slower than the ${name} does not spend it`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => replyingServer()),
        (value) => Effect.sync(() => value.server.close()),
      )
      const sessionID = uniqueSession("slow")
      yield* Effect.addFinalizer(() => removeSession(sessionID))
      yield* slowCaptureWrites(800)

      // The provider answers at once; with the capture inside the timers the request would go out already aborted.
      expect(yield* callProvider(server.url, sessionID, options)).toBe("ok")

      expect(server.received).toHaveLength(1)
      expect(yield* Effect.promise(() => RequestCapture.list(sessionID))).toEqual([1])
    }),
  )
}

const exists = (target: string) =>
  fs.stat(target).then(
    () => true,
    () => false,
  )

/** A session directory under the capture directory whose only file is 8 days old. */
async function seedIdleCapture(sessionID: string) {
  const dir = sessionDirOf(sessionID)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, stepFile(1))
  await fs.writeFile(file, "{}")
  const old = new Date(Date.now() - 8 * DAY)
  await fs.utimes(file, old, old)
  await fs.utimes(dir, old, old)
}

const bare = testEffect(Layer.mergeAll(Env.defaultLayer, CrossSpawnSpawner.defaultLayer))

bare.live("with the flag on, starting the provider prunes captures idle for over 7 days, in the background", () =>
  Effect.gen(function* () {
    const sessionID = uniqueSession("idle_on")
    yield* Effect.addFinalizer(() => removeSession(sessionID))
    yield* Effect.promise(() => seedIdleCapture(sessionID))

    yield* Layer.build(providerLayer({ debugRequests: true }))

    yield* pollWithTimeout(
      Effect.promise(() => exists(sessionDirOf(sessionID))).pipe(Effect.map((there) => (there ? undefined : true))),
      "the idle session was not pruned",
    )
  }),
)

bare.live("with the flag off, starting the provider leaves old captures alone", () =>
  Effect.gen(function* () {
    const sessionID = uniqueSession("idle_off")
    yield* Effect.addFinalizer(() => removeSession(sessionID))
    yield* Effect.promise(() => seedIdleCapture(sessionID))

    yield* Layer.build(providerLayer({ debugRequests: false }))
    yield* Effect.sleep("300 millis")

    expect(yield* Effect.promise(() => exists(sessionDirOf(sessionID)))).toBe(true)
  }),
)
