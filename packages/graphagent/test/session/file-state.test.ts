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
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
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
