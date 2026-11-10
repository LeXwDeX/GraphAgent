// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Logger } from "effect"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { emptyTrustFile, make, TRUST_VERSION, trustFilePath, type TrustFile } from "@/project/trust/store"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.defaultLayer)

const stateDir = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "trust-store-"))),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
)

function collector() {
  const logs: string[] = []
  const logger = Logger.make((options) => logs.push(String(options.message)))
  return { logs, logger }
}

const readFile = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const readDir = (directory: string) => Effect.promise(() => fs.readdir(directory))

function sample(): TrustFile {
  const data = emptyTrustFile()
  data.projects["project-a"] = {
    root: "/work/project-a",
    remote: "git@example.com:project-a.git",
    entries: {
      "hooks.json|hook|Stop||1": {
        fp: "a".repeat(64),
        decision: "trusted",
        decidedAt: 1_730_000_000_000,
        command: "bun run .agents/check.ts",
      },
    },
  }
  return data
}

describe("trust.json path", () => {
  it.live("uses trust.json next to kv.json in the XDG state directory", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      expect(trustFilePath(directory)).toBe(path.join(directory, "trust.json"))
      expect(trustFilePath()).toBe(path.join(Global.Path.state, "trust.json"))
    }),
  )
})

describe("trust.json store", () => {
  it.live("round-trips a record", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const store = make({ file: trustFilePath(directory), fs: yield* FSUtil.Service })
      const data = sample()

      expect(yield* store.write(data)).toBe(true)
      expect(yield* store.read).toEqual(data)
    }),
  )

  it.live("writes 0600 into a missing state directory without leaving temp files", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const target = path.join(directory, "nested", "state", "trust.json")
      const store = make({ file: target, fs: yield* FSUtil.Service })

      expect(yield* store.write(sample())).toBe(true)

      const info = yield* Effect.promise(() => fs.stat(target))
      expect(info.mode & 0o777).toBe(0o600)
      expect(yield* readDir(path.dirname(target))).toEqual(["trust.json"])
    }),
  )

  it.live("reads a missing file as an empty record without logging", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const store = make({ file: trustFilePath(directory), fs: yield* FSUtil.Service })
      const { logs, logger } = collector()

      expect(yield* store.read.pipe(Effect.withLogger(logger))).toEqual(emptyTrustFile())
      expect(logs).toEqual([])
    }),
  )

  it.live("reads corrupt content as an empty record, logs once and preserves the file", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const file = trustFilePath(directory)
      const original = "{ this is not json"
      yield* Effect.promise(() => fs.writeFile(file, original))

      const store = make({ file, fs: yield* FSUtil.Service })
      const { logs, logger } = collector()
      expect(yield* store.read.pipe(Effect.withLogger(logger))).toEqual(emptyTrustFile())

      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain("corrupt or has an unknown version")
      expect(yield* readFile(file)).toBe(original)
      expect(yield* readDir(directory)).toEqual(["trust.json"])
    }),
  )

  it.live("reads an unknown version as an empty record and preserves the file", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const file = trustFilePath(directory)
      const original = JSON.stringify({ version: TRUST_VERSION + 1, projects: {} })
      yield* Effect.promise(() => fs.writeFile(file, original))

      const store = make({ file, fs: yield* FSUtil.Service })
      const { logs, logger } = collector()
      expect(yield* store.read.pipe(Effect.withLogger(logger))).toEqual(emptyTrustFile())

      expect(logs).toHaveLength(1)
      expect(yield* readFile(file)).toBe(original)
    }),
  )

  it.live("replaces a corrupt file only on the next successful write", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const file = trustFilePath(directory)
      yield* Effect.promise(() => fs.writeFile(file, "not json"))

      const store = make({ file, fs: yield* FSUtil.Service })
      expect(yield* store.read).toEqual(emptyTrustFile())
      expect(yield* readFile(file)).toBe("not json")

      expect(yield* store.write(sample())).toBe(true)
      expect(yield* store.read).toEqual(sample())
    }),
  )

  it.live("reads an unreadable path as an empty record and logs", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const file = path.join(directory, "trust.json")
      yield* Effect.promise(() => fs.mkdir(file))

      const store = make({ file, fs: yield* FSUtil.Service })
      const { logs, logger } = collector()
      expect(yield* store.read.pipe(Effect.withLogger(logger))).toEqual(emptyTrustFile())
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain("failed to read the project trust file")
    }),
  )

  it.live("returns false and logs when the write cannot create the state directory", () =>
    Effect.gen(function* () {
      const directory = yield* stateDir
      const blocker = path.join(directory, "blocked")
      yield* Effect.promise(() => fs.writeFile(blocker, "not a directory"))

      const store = make({ file: path.join(blocker, "trust.json"), fs: yield* FSUtil.Service })
      const { logs, logger } = collector()

      expect(yield* store.write(sample()).pipe(Effect.withLogger(logger))).toBe(false)
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain("failed to write the project trust file")
      expect(yield* readFile(blocker)).toBe("not a directory")
    }),
  )
})
