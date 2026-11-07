export * as MemoryConfig from "./config"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Git } from "@/git"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { MemoryFile } from "./file"
import { MemoryPaths } from "./paths"
import { MemorySchema } from "./schema"

export type Loaded = {
  readonly config: MemorySchema.Config
  readonly path: string
  readonly level: "project" | "global"
}

export interface Interface {
  readonly load: (projectDir: string) => Effect.Effect<Loaded | undefined, FSUtil.Error | EffectFlock.LockError>
  readonly loadGlobal: () => Effect.Effect<Loaded | undefined, FSUtil.Error | EffectFlock.LockError>
  readonly writeProject: (
    projectDir: string,
    config: MemorySchema.Config,
    existingPath?: string,
  ) => Effect.Effect<void, FSUtil.Error | EffectFlock.LockError>
  readonly writeGlobal: (
    config: MemorySchema.Config,
    existingPath?: string,
  ) => Effect.Effect<boolean, FSUtil.Error | EffectFlock.LockError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const flock = yield* EffectFlock.Service

    const ensureProjectExclude = Effect.fnUntraced(function* (projectDir: string) {
      const result = yield* git.run(["rev-parse", "--git-path", "info/exclude"], { cwd: projectDir })
      if (result.exitCode !== 0) return
      const raw = result.text().trim()
      if (!raw) return
      const file = isAbsolute(raw) ? raw : resolve(projectDir, raw)
      const current = (yield* fs.readFileStringSafe(file)) ?? ""
      const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()))
      const missing = MemoryPaths.PROJECT_CONFIG_PATHS.filter((rule) => !lines.has(rule))
      if (missing.length === 0) return
      const prefix = current.length === 0 || current.endsWith("\n") ? current : current + "\n"
      yield* MemoryFile.atomicWrite(fs, file, prefix + missing.join("\n") + "\n")
    })

    const readFirst = Effect.fnUntraced(function* (paths: string[]) {
      for (const path of paths) {
        const text = yield* fs.readFileStringSafe(path)
        if (text !== undefined) return { path, text }
      }
      return undefined
    })

    const readConfig = Effect.fnUntraced(function* (found: { path: string; text: string }) {
      const decoded = decodeConfig(found.text)
      if (Option.isNone(decoded)) {
        yield* Effect.logWarning("memory config is invalid — ignoring", { path: found.path })
        return undefined
      }
      return decoded.value
    })

    const load = Effect.fn("MemoryConfig.load")(function* (projectDir: string) {
      const found = yield* readFirst(candidates(projectDir))
      if (!found) return undefined
      const config = yield* readConfig(found)
      if (!config) return undefined
      return {
        config,
        path: found.path,
        level: projectCandidates(projectDir).includes(found.path) ? ("project" as const) : ("global" as const),
      }
    })

    const loadGlobal = Effect.fn("MemoryConfig.loadGlobal")(function* () {
      const found = yield* readFirst(globalCandidates())
      if (!found) return undefined
      const config = yield* readConfig(found)
      return config ? { config, path: found.path, level: "global" as const } : undefined
    })

    const writeProject = Effect.fn("MemoryConfig.writeProject")(function* (
      projectDir: string,
      config: MemorySchema.Config,
      existingPath?: string,
    ) {
      yield* ensureProjectExclude(projectDir)
      // One Project = one shared policy file, written by several paths
      // (/memory on|off, admission promotion, normalization rewrites) from
      // multiple worktrees and processes. Serialize the writes on the target
      // file so atomicWrite's byte-atomicity is not undermined by
      // whole-document last-writer-wins.
      const target = existingPath ?? projectPath(projectDir)
      yield* flock.withLock(MemoryFile.atomicWrite(fs, target, serialize(config)), writeLockKey(target))
    })

    const writeGlobal = Effect.fn("MemoryConfig.writeGlobal")(function* (
      config: MemorySchema.Config,
      existingPath?: string,
    ) {
      if (existingPath && globalCandidates().includes(existingPath)) {
        yield* flock.withLock(MemoryFile.atomicWrite(fs, existingPath, serialize(config)), writeLockKey(existingPath))
        return true
      }
      const file = join(globalConfigDir(), "memory.jsonc")
      const found = yield* readFirst(globalCandidates())
      if (found) {
        const existing = yield* readConfig(found)
        if (existing) {
          yield* Effect.logWarning("global MEMORY config write declined — preserving existing valid config", {
            path: found.path,
            existingModel: existing.model,
            requestedModel: config.model,
          })
          return false
        }
        yield* flock.withLock(MemoryFile.atomicWrite(fs, found.path, serialize(config)), writeLockKey(found.path))
        return true
      }
      yield* fs.makeDirectory(dirname(file), { recursive: true })
      return yield* fs.writeFileString(file, serialize(config), { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      )
    })

    return Service.of({ load, loadGlobal, writeProject, writeGlobal })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Git.defaultLayer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))),
)

export const node = LayerNode.make(layer, [FSUtil.node, EffectFlock.node, Git.node])

/** Cross-process serialization key for writes to one MEMORY config file. */
export function writeLockKey(file: string) {
  return `memory-config:${file}`
}

export function projectPath(projectDir: string) {
  return join(projectDir, ".opencode", "memory.jsonc")
}

export function candidates(projectDir: string) {
  return [...projectCandidates(projectDir), ...globalCandidates()]
}

export function globalConfigDir() {
  return Flag.GRAPHAGENT_CONFIG_DIR ?? Global.Path.config
}

export function projectCandidates(projectDir: string) {
  return [join(projectDir, ".opencode", "memory.jsonc"), join(projectDir, ".opencode", "memory.json")]
}

function globalCandidates() {
  return [join(globalConfigDir(), "memory.jsonc"), join(globalConfigDir(), "memory.json")]
}

function serialize(config: MemorySchema.Config) {
  return JSON.stringify(config, null, 2) + "\n"
}

export function decodeConfig(text: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return Option.none<MemorySchema.Config>()
  // Legacy files may still carry the removed topic_limit_floor knob — Schema
  // Struct decoding tolerates the extra property, so such files stay valid
  // and the dead value is simply dropped on the next write.
  return Schema.decodeUnknownOption(MemorySchema.Config)(value ?? {})
}
