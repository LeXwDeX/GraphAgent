// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, afterAll, beforeAll } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { ProjectV2 } from "@graphagent/core/project"
import { Database } from "@graphagent/core/database/database"
import { FSUtil } from "@graphagent/core/fs-util"
import { Git } from "@/git"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { EffectFlock } from "@graphagent/core/util/effect-flock"
import { Memory } from "@/memory/memory"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryLock } from "@/memory/lock"
import { MemoryStore } from "@/memory/store"
import { MemoryModel } from "@/memory/model"
import { ProviderTest } from "../fake/provider"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// bun test runs all files in one process, sequentially, sharing one
// XDG_CONFIG_HOME — a test file that runs before this one can leave an
// enabled global memory.jsonc whose model this file's fake provider does not
// know, turning the post-heal statusReason into a model-unavailable blocker.
// Pin a private config dir per file so the global file can never be
// contaminated by earlier files.
const pinnedConfigDir = path.join(os.tmpdir(), `opencode-memory-selfheal-${process.pid}`)
const previousConfigDir = process.env.GRAPHAGENT_CONFIG_DIR
beforeAll(() => {
  fs.mkdirSync(pinnedConfigDir, { recursive: true })
  process.env.GRAPHAGENT_CONFIG_DIR = pinnedConfigDir
})
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = previousConfigDir
})

// #415: the /init stamp is written by a Command.Event.Executed listener that can
// lose the race with the command itself, leaving time_initialized NULL forever.
// The activation gate must self-heal: a project that already has the /init
// artifact (non-empty AGENTS.md) passes without re-running /init, and a project
// without it still reports the blocker — now with the DB row state attached.

const emptyConfigLayer = Layer.mock(Config.Service, {
  get: () => Effect.succeed({}),
})

const base = Layer.mergeAll(
  emptyConfigLayer,
  ProviderTest.fake().layer,
  Project.defaultLayer,
  Database.defaultLayer,
  Git.defaultLayer,
  FSUtil.defaultLayer,
  EffectFlock.defaultLayer,
  MemoryConfig.defaultLayer,
  MemoryHome.defaultLayer,
  MemoryIdentityFence.defaultLayer,
  MemoryLock.defaultLayer,
  MemoryStore.defaultLayer,
  Layer.mock(MemoryModel.Service, {
    generate: () => Effect.die(new Error("model calls are not expected in self-heal tests")),
  }),
)

// provideMerge builds `base` once, provides it to Memory.layer AND re-exposes its
// services (Project/MemoryConfig/MemoryStore/...) to the test body.
const layer = Layer.mergeAll(Memory.layer.pipe(Layer.provideMerge(base)), CrossSpawnSpawner.defaultLayer)

const it = testEffect(layer)

describe("memory /init stamp self-heal", () => {
  for (const configured of ["missing", "disabled", "unavailable-model"]) {
    it.live(
      `first enable completes after self-healing with ${configured} project config`,
      () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped({ git: true })
          yield* provideInstance(dir)(
            Effect.gen(function* () {
              const project = yield* Project.Service
              const memory = yield* Memory.Service
              const config = yield* MemoryConfig.Service
              const { project: info } = yield* project.fromDirectory(dir)
              fs.writeFileSync(path.join(info.worktree, "AGENTS.md"), "# project guide\n")
              if (configured !== "missing") {
                yield* config.writeProject(info.worktree, {
                  schema_version: 1,
                  enabled: configured === "unavailable-model",
                  model: configured === "unavailable-model" ? "missing/model" : "openai/gpt-5.2",
                  topic_limit: 10,
                  turn_interval: 5,
                  injection: { max_topics: 3, max_tokens: 1_200 },
                })
              }

              expect(yield* memory.setEnabled(true)).toBe("Memory on")
              expect((yield* project.get(info.id))?.time.initialized).toBeDefined()
              expect((yield* config.load(info.worktree))?.config.enabled).toBe(true)
              expect((yield* config.load(info.worktree))?.config.model).toBe("openai/gpt-5.2")
              expect(yield* memory.status()).toBe("Memory on")
            }),
          ).pipe(Effect.provide(testInstanceStoreLayer))
        }),
      { timeout: 30_000 },
    )
  }

  it.live(
    "statusReason stamps the project when AGENTS.md already exists",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).not.toBe(ProjectV2.ID.global)
            // The artifact /init produces: a non-empty AGENTS.md in the worktree.
            fs.writeFileSync(path.join(info.worktree, "AGENTS.md"), "# project guide\n")

            // Gate self-heals instead of reporting the blocker...
            expect(yield* memory.statusReason()).toBeUndefined()
            // ...and the stamp actually landed in the DB row.
            const stamped = yield* project.get(info.id)
            expect(stamped?.time.initialized).toBeDefined()
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "statusReason keeps blocking without AGENTS.md and reports the DB state",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).not.toBe(ProjectV2.ID.global)

            const reason = yield* memory.statusReason()
            expect(reason).toContain("/init")
            expect(yield* memory.setEnabled(true)).toContain("/init")
            expect(yield* memory.setEnabled(false)).toBe("Memory remains off")
            expect((yield* project.get(info.id))?.time.initialized).toBeUndefined()
            // #415 diagnostics: the blocker carries the actual row state so a
            // stale identity (worktree pointing at a deleted clone) is visible.
            expect(reason).toContain("time_initialized")
            expect(reason).toContain(info.worktree)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})
