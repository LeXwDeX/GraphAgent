// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #1452 — the session file state remembers what the disk held after the last
 * read or write of each file, per session, so the write tools can check it at
 * the write point.
 */
import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ProjectID } from "@graphagent/schema/project-id"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess } from "@/session/engine-process"
import { FileState } from "@/session/file-state"
import { SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FileState.defaultLayer, EventV2Bridge.defaultLayer))

const sessionA = SessionID.make("ses_file_state_a")
const sessionB = SessionID.make("ses_file_state_b")

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const put = (file: string, content: string | Uint8Array) => Effect.promise(() => fs.writeFile(file, content))

describe("FileState", () => {
  describe("record", () => {
    it.instance("stores the sha256 of the file bytes, the size, and the recording tool", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const file = path.join(test.directory, "a.txt")
        yield* put(file, "hello\n")

        yield* state.record(sessionA, file, "read")

        const entry = yield* state.get(sessionA, file)
        expect(entry?.hash).toBe(sha256("hello\n"))
        expect(entry?.size).toBe(6)
        expect(entry?.source).toBe("read")
        expect(entry?.mtimeMs).toBeGreaterThan(0)
      }),
    )

    it.instance("hashes the raw bytes, so a BOM counts", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const file = path.join(test.directory, "bom.cs")
        const bytes = Buffer.from("﻿using System;\n", "utf8")
        yield* put(file, bytes)

        yield* state.record(sessionA, file, "write")

        const entry = yield* state.get(sessionA, file)
        expect(entry?.hash).toBe(sha256(bytes))
        expect(entry?.size).toBe(bytes.byteLength)
      }),
    )

    it.instance("a later record replaces the entry", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const file = path.join(test.directory, "a.txt")
        yield* put(file, "one")
        yield* state.record(sessionA, file, "read")

        yield* put(file, "two!")
        yield* state.record(sessionA, file, "edit")

        const entry = yield* state.get(sessionA, file)
        expect(entry?.hash).toBe(sha256("two!"))
        expect(entry?.source).toBe("edit")
      }),
    )

    it.instance("a relative and an absolute path are one entry", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const file = path.join(test.directory, "a.txt")
        yield* put(file, "same file")
        const relative = path.relative(process.cwd(), file)

        yield* state.record(sessionA, relative, "read")

        expect((yield* state.get(sessionA, file))?.hash).toBe(sha256("same file"))
        expect((yield* state.get(sessionA, relative))?.hash).toBe(sha256("same file"))
        expect((yield* state.get(sessionA, path.join(test.directory, ".", "a.txt")))?.hash).toBe(sha256("same file"))
      }),
    )

    it.instance("a symlink and its target are one entry", () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const file = path.join(test.directory, "target.txt")
        const link = path.join(test.directory, "link.txt")
        yield* put(file, "through the link")
        yield* Effect.promise(() => fs.symlink(file, link))

        yield* state.record(sessionA, link, "read")

        expect((yield* state.get(sessionA, file))?.hash).toBe(sha256("through the link"))
      }),
    )

    it.instance("leaves a directory and a missing file unrecorded without failing", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const directory = path.join(test.directory, "dir")
        yield* Effect.promise(() => fs.mkdir(directory))
        const missing = path.join(test.directory, "missing.txt")

        yield* state.record(sessionA, directory, "read")
        yield* state.record(sessionA, missing, "write")

        expect(yield* state.get(sessionA, directory)).toBeUndefined()
        expect(yield* state.get(sessionA, missing)).toBeUndefined()
      }),
    )

    it.instance("keeps size and mtime but no hash above the hash limit", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const big = path.join(test.directory, "big.bin")
        const size = FileState.MAX_HASHED_BYTES + 1
        yield* put(big, Buffer.alloc(size, 97))
        const exact = path.join(test.directory, "exact.bin")
        yield* put(exact, Buffer.alloc(FileState.MAX_HASHED_BYTES, 97))

        yield* state.record(sessionA, big, "read")
        yield* state.record(sessionA, exact, "read")

        const over = yield* state.get(sessionA, big)
        expect(over?.hash).toBeUndefined()
        expect(over?.size).toBe(size)
        expect(over?.mtimeMs).toBeGreaterThan(0)
        expect((yield* state.get(sessionA, exact))?.hash).toBeString()
      }),
    )
  })

  describe("sessions", () => {
    it.instance("do not share entries", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const file = path.join(test.directory, "a.txt")
        yield* put(file, "mine")

        yield* state.record(sessionA, file, "read")

        expect(yield* state.get(sessionA, file)).toBeDefined()
        expect(yield* state.get(sessionB, file)).toBeUndefined()
      }),
    )

    it.instance("lose their entries when the session is deleted, and only theirs", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = yield* FileState.Service
        const events = yield* EventV2Bridge.Service
        const file = path.join(test.directory, "a.txt")
        yield* put(file, "kept for B")
        yield* state.record(sessionA, file, "read")
        yield* state.record(sessionB, file, "read")

        // Same payload the real session removal publishes.
        yield* events.publish(SessionV1.Event.Deleted, {
          sessionID: sessionA,
          info: {
            id: sessionA,
            slug: "file-state",
            projectID: ProjectID.make("project-1"),
            directory: test.directory,
            role: "root",
            title: "deleted",
            version: "test",
            time: { created: 1, updated: 1 },
          },
        })

        yield* pollWithTimeout(
          Effect.gen(function* () {
            return (yield* state.get(sessionA, file)) === undefined ? true : undefined
          }),
          "entries of the deleted session were not cleared",
        )
        expect((yield* state.get(sessionB, file))?.hash).toBe(sha256("kept for B"))
      }),
    )
  })
})

describe("FileState.verify", () => {
  it.instance("is unread without a record, also for another session's record", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")

      expect(yield* state.verify(sessionA, file)).toBe("unread")
      yield* state.record(sessionB, file, "read")
      expect(yield* state.verify(sessionA, file)).toBe("unread")
      expect(yield* state.verify(sessionB, file)).toBe("same")
    }),
  )

  it.instance("is same while the content is untouched, and changed once it differs", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")
      yield* state.record(sessionA, file, "read")
      expect(yield* state.verify(sessionA, file)).toBe("same")

      yield* put(file, "Content")

      expect(yield* state.verify(sessionA, file)).toBe("changed")
    }),
  )

  it.instance("judges a file of the same size and a different content as changed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "aaaa")
      yield* state.record(sessionA, file, "read")
      const before = yield* Effect.promise(() => fs.stat(file))

      yield* put(file, "aaab")
      yield* Effect.promise(() => fs.utimes(file, before.atime, before.mtime))

      expect(yield* state.verify(sessionA, file)).toBe("changed")
    }),
  )

  it.instance("lets the hash decide, so a new mtime over the same bytes is still same", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")
      yield* state.record(sessionA, file, "read")

      const later = new Date(Date.now() + 120_000)
      yield* Effect.promise(() => fs.utimes(file, later, later))

      expect(yield* state.verify(sessionA, file)).toBe("same")
    }),
  )

  it.instance("is changed when the file is gone or became a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")
      yield* state.record(sessionA, file, "read")

      yield* Effect.promise(() => fs.rm(file))
      expect(yield* state.verify(sessionA, file)).toBe("changed")

      yield* Effect.promise(() => fs.mkdir(file))
      expect(yield* state.verify(sessionA, file)).toBe("changed")
    }),
  )

  it.instance("compares size and mtime above the hash limit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "big.bin")
      const size = FileState.MAX_HASHED_BYTES + 1
      yield* put(file, Buffer.alloc(size, 97))
      yield* state.record(sessionA, file, "read")
      expect(yield* state.verify(sessionA, file)).toBe("same")

      // Same size, same mtime: the bytes cannot be told apart without a hash.
      const before = yield* Effect.promise(() => fs.stat(file))
      yield* put(file, Buffer.alloc(size, 98))
      yield* Effect.promise(() => fs.utimes(file, before.atime, before.mtime))
      expect(yield* state.verify(sessionA, file)).toBe("same")

      // A new mtime, or a new size, is a change.
      const later = new Date(before.mtimeMs + 120_000)
      yield* Effect.promise(() => fs.utimes(file, later, later))
      expect(yield* state.verify(sessionA, file)).toBe("changed")
      yield* Effect.promise(() => fs.utimes(file, before.atime, before.mtime))
      yield* put(file, Buffer.alloc(size + 1, 97))
      yield* Effect.promise(() => fs.utimes(file, before.atime, before.mtime))
      expect(yield* state.verify(sessionA, file)).toBe("changed")
    }),
  )

  it.instance("compares size and mtime when the file crossed the hash limit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "grows.bin")
      yield* put(file, "small")
      yield* state.record(sessionA, file, "read")

      yield* put(file, Buffer.alloc(FileState.MAX_HASHED_BYTES + 1, 97))

      expect(yield* state.verify(sessionA, file)).toBe("changed")
    }),
  )
})

describe("FileState.requireRead", () => {
  it.instance("passes for a file the session read that still matches", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")
      yield* state.record(sessionA, file, "read")

      yield* state.requireRead(sessionA, file)
    }),
  )

  it.instance("fails for an unread file with the not-read message", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")

      const error = yield* state.requireRead(sessionA, file).pipe(Effect.flip)

      expect(error.message).toBe(`${file} already exists and was not read in this session. Read it first, then retry.`)
    }),
  )

  it.instance("fails for a changed file with the changed message", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")
      yield* state.record(sessionA, file, "read")
      yield* put(file, "different")

      const error = yield* state.requireRead(sessionA, file).pipe(Effect.flip)

      expect(error.message).toBe(`${file} changed after it was last read in this session. Read it again, then retry.`)
    }),
  )

  it.instance("fails for a directory before looking at records", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const directory = path.join(test.directory, "dir")
      yield* Effect.promise(() => fs.mkdir(directory))

      const error = yield* state.requireRead(sessionA, directory).pipe(Effect.flip)

      expect(error.message).toBe(`Path is a directory, not a file: ${directory}`)
    }),
  )

  it.instance("words the size refusal with the limit and the shell alternative", () =>
    Effect.sync(() => {
      expect(FileState.tooLargeMessage("/p/big.txt")).toBe(
        "/p/big.txt is larger than 10 MiB; edit and write do not load files this large. Use a shell command (sed, awk, python).",
      )
      expect(FileState.MAX_EDITABLE_BYTES).toBe(10 * 1024 * 1024)
    }),
  )
})

describe("FileState.requireSame", () => {
  it.instance("passes while the disk matches the record", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      yield* put(file, "content")
      yield* state.record(sessionA, file, "read")

      yield* state.requireSame(sessionA, file)
    }),
  )

  it.instance("fails with the permission-wait message once the file changed, is gone, or was never recorded", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const state = yield* FileState.Service
      const file = path.join(test.directory, "a.txt")
      const expected = `${file} changed while this call waited for permission. Read it again, then retry.`
      yield* put(file, "content")

      expect((yield* state.requireSame(sessionA, file).pipe(Effect.flip)).message).toBe(expected)

      yield* state.record(sessionA, file, "read")
      yield* put(file, "different")
      expect((yield* state.requireSame(sessionA, file).pipe(Effect.flip)).message).toBe(expected)

      yield* Effect.promise(() => fs.rm(file))
      expect((yield* state.requireSame(sessionA, file).pipe(Effect.flip)).message).toBe(expected)
    }),
  )

  it.instance("words the receipt note around the path the receipt shows", () =>
    Effect.sync(() => {
      expect(FileState.changedOutsideNote("src/a.ts")).toBe(
        "Note: this file changed outside this session after your last read: src/a.ts. Your change was applied to its current content.",
      )
    }),
  )
})

describe("FileState.withLocks", () => {
  const lockFile = (name: string) => path.join(process.cwd(), `.file-state-lock-${name}`)
  const relative = (name: string) => `./.file-state-lock-${name}`

  // Runs two guarded sections and reports the order their steps happened in.
  const interleaving = (first: ReadonlyArray<string>, second: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const log: string[] = []
      const section = (name: string) =>
        Effect.gen(function* () {
          log.push(`${name}:start`)
          yield* Effect.sleep("30 millis")
          log.push(`${name}:end`)
        })
      yield* Effect.all([FileState.withLocks(first)(section("a")), FileState.withLocks(second)(section("b"))], {
        concurrency: "unbounded",
      })
      return log
    })

  it.live("serializes sections that name the same path, relative or absolute", () =>
    Effect.gen(function* () {
      const log = yield* interleaving([relative("same")], [lockFile("same")])

      // Whichever section got the lock first finished before the other started.
      expect(log).toHaveLength(4)
      expect(log[1]).toBe(log[0]?.replace(":start", ":end"))
      expect(log[3]).toBe(log[2]?.replace(":start", ":end"))
      expect(new Set(log.filter((entry) => entry.endsWith(":start")))).toEqual(new Set(["a:start", "b:start"]))
    }),
  )

  it.live("lets sections on different paths run together", () =>
    Effect.gen(function* () {
      const log = yield* interleaving([lockFile("one")], [lockFile("two")])

      expect(log.slice(0, 2).sort()).toEqual(["a:start", "b:start"])
    }),
  )

  it.live("does not deadlock when two sections name the same two paths in opposite orders", () =>
    Effect.gen(function* () {
      const one = lockFile("order-one")
      const two = lockFile("order-two")
      const runs = Effect.all(
        Array.from({ length: 20 }, (_, i) =>
          FileState.withLocks(i % 2 === 0 ? [one, two] : [two, one])(Effect.sleep("2 millis")),
        ),
        { concurrency: "unbounded" },
      )

      const done = yield* runs.pipe(Effect.timeoutOption("5 seconds"))

      expect(Option.isSome(done)).toBe(true)
    }),
  )

  it.live("takes a path named twice once", () =>
    Effect.gen(function* () {
      const file = lockFile("twice")

      const done = yield* FileState.withLocks([file, relative("twice"), file])(Effect.succeed("ran")).pipe(
        Effect.timeoutOption("2 seconds"),
      )

      expect(done).toEqual(Option.some("ran"))
    }),
  )

  it.live("holds the lock until the section ends, and releases every lock afterwards", () =>
    Effect.gen(function* () {
      const file = lockFile("release")
      const entered = yield* Deferred.make<void>()
      const leave = yield* Deferred.make<void>()
      const holder = yield* FileState.withLocks([file])(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(leave))),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      expect(yield* EngineProcess.fileLocks.size).toBe(1)

      const waiter = yield* FileState.withLocks([file])(Effect.succeed("got it")).pipe(Effect.forkScoped)
      expect(Option.isNone(yield* Fiber.await(waiter).pipe(Effect.timeoutOption("100 millis")))).toBe(true)

      yield* Deferred.succeed(leave, undefined)
      yield* Fiber.join(holder)
      expect(yield* Fiber.join(waiter)).toBe("got it")
      expect(yield* EngineProcess.fileLocks.size).toBe(0)
    }),
  )

  it.live("releases the lock when the section fails or is interrupted", () =>
    Effect.gen(function* () {
      const file = lockFile("failure")

      yield* FileState.withLocks([file])(Effect.fail(new Error("boom"))).pipe(Effect.flip)
      const entered = yield* Deferred.make<void>()
      const stuck = yield* FileState.withLocks([file])(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(stuck)

      expect(yield* EngineProcess.fileLocks.size).toBe(0)
    }),
  )
})
