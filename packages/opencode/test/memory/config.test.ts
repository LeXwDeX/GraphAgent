import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decodeConfig, MemoryConfig } from "@/memory/config"
import { HOME_ROOT_ERROR } from "@/project/project-root"
import { MemorySchema, updateConfig } from "@/memory/schema"

// memory-config-fidelity: topic_limit_floor was a dead knob — no runtime
// consumer read it, and readConfig silently rewrote any floor ≠ limit file to
// floor := limit on every load, overwriting explicit user values. The field
// must be gone: legacy files carrying it still decode (extra property is
// tolerated), and decoded/updated configs never contain it.

const valid = {
  schema_version: 1,
  enabled: true,
  model: "p/m",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1200 },
} satisfies MemorySchema.Config

describe("MemoryConfig decode/update — topic_limit_floor removed", () => {
  test("legacy file with a divergent floor still decodes (field ignored)", () => {
    const decoded = decodeConfig(JSON.stringify({ ...valid, topic_limit_floor: 30 }))
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      expect(Object.keys(decoded.value)).not.toContain("topic_limit_floor")
    }
  })

  test("decoded config never carries the field", () => {
    const decoded = decodeConfig(JSON.stringify(valid))
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      expect(Object.keys(decoded.value)).not.toContain("topic_limit_floor")
    }
  })

  test("updateConfig output never carries the field", () => {
    const decoded = decodeConfig(JSON.stringify(valid))
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      const next = updateConfig(decoded.value, { enabled: false })
      expect(Object.keys(next)).not.toContain("topic_limit_floor")
    }
  })

  test("schema bounds for the live knobs are preserved", () => {
    expect(decodeConfig(JSON.stringify({ ...valid, topic_limit: 9 }))._tag).toBe("None")
    expect(decodeConfig(JSON.stringify({ ...valid, turn_interval: 0 }))._tag).toBe("None")
    expect(decodeConfig(JSON.stringify({ ...valid, injection: { max_topics: 4, max_tokens: 1200 } }))._tag).toBe("None")
    expect(MemorySchema.MIN_TOPIC_LIMIT).toBe(10)
  })
})

// `$HOME` never becomes a project root: `~/.agents` is the user-level shared
// directory, so a project directory that resolves to $HOME must not read
// `<home>/.agents/settings.local.json` as project memory policy.
describe("MemoryConfig.load — $HOME is not a project layer", () => {
  test("a root that resolves to $HOME falls back to the global config", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mem-home-"))
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-global-"))
    const previousHome = process.env.GRAPHAGENT_TEST_HOME
    const previousConfig = process.env.GRAPHAGENT_CONFIG_DIR
    process.env.GRAPHAGENT_TEST_HOME = home
    process.env.GRAPHAGENT_CONFIG_DIR = configDir
    try {
      await fs.mkdir(path.join(home, ".agents"), { recursive: true })
      await fs.writeFile(
        path.join(home, ".agents", "settings.local.json"),
        JSON.stringify({ memory: { ...valid, model: "p/home-project" } }),
      )
      await fs.writeFile(path.join(configDir, "memory.jsonc"), JSON.stringify({ ...valid, model: "p/global" }))

      const loaded = await Effect.runPromise(
        Effect.gen(function* () {
          const config = yield* MemoryConfig.Service
          return yield* config.load(home)
        }).pipe(Effect.provide(MemoryConfig.defaultLayer)),
      )
      expect(loaded?.level).toBe("global")
      expect(loaded?.config.model).toBe("p/global")
    } finally {
      if (previousHome === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = previousHome
      if (previousConfig === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
      else process.env.GRAPHAGENT_CONFIG_DIR = previousConfig
      await Promise.all([
        fs.rm(home, { recursive: true, force: true }),
        fs.rm(configDir, { recursive: true, force: true }),
      ])
    }
  }, 15000)

  test("writeProject refuses to write project memory into $HOME", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mem-home-write-"))
    const previousHome = process.env.GRAPHAGENT_TEST_HOME
    process.env.GRAPHAGENT_TEST_HOME = home
    try {
      await fs.mkdir(path.join(home, ".agents"), { recursive: true })
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const config = yield* MemoryConfig.Service
          return yield* config.writeProject(home, valid)
        }).pipe(Effect.provide(MemoryConfig.defaultLayer)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(HOME_ROOT_ERROR)
      // The guard runs before any filesystem mutation.
      await expect(fs.access(path.join(home, ".agents", "settings.local.json"))).rejects.toThrow()
    } finally {
      if (previousHome === undefined) delete process.env.GRAPHAGENT_TEST_HOME
      else process.env.GRAPHAGENT_TEST_HOME = previousHome
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 15000)
})
