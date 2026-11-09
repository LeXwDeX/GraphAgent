// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as MemoryConfig from "./config"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { EffectFlock } from "@graphagent/core/util/effect-flock"
import { Flag } from "@graphagent/core/flag/flag"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { Git } from "@/git"
import { ConfigPaths } from "@/config/paths"
import { assertProjectRootWritable, hasProjectLayer, resolveProjectRoot } from "@/project/project-root"
import { ensureLocalExcludes } from "@/project/git-exclude"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { MemoryFile } from "./file"
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
  ) => Effect.Effect<void, FSUtil.Error | EffectFlock.LockError>
  readonly writeGlobal: (
    config: MemorySchema.Config,
    existingPath?: string,
  ) => Effect.Effect<boolean, FSUtil.Error | EffectFlock.LockError>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/MemoryConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const flock = yield* EffectFlock.Service

    const projectRoot = Effect.fnUntraced(function* (directory: string) {
      const result = yield* git.run(["rev-parse", "--show-toplevel"], { cwd: directory })
      const toplevel = result.exitCode === 0 ? result.text().trim() || undefined : undefined
      return {
        root: resolveProjectRoot(directory, {
          home: Global.Path.home,
          toplevel,
          isDirectory: (candidate) => {
            try {
              return statSync(candidate).isDirectory()
            } catch {
              return false
            }
          },
        }),
        toplevel,
      }
    })

    const ensureProjectExclude = Effect.fnUntraced(function* (root: string, _toplevel: string | undefined) {
      yield* Effect.promise(() => ensureLocalExcludes({ root }))
    })

    const readFirst = Effect.fnUntraced(function* (paths: string[]) {
      for (const path of paths) {
        const text = yield* fs.readFileStringSafe(path)
        if (text !== undefined) return { path, text }
      }
      return undefined
    })

    const readGlobal = Effect.fnUntraced(function* (found: { path: string; text: string }) {
      const decoded = decodeConfig(found.text)
      if (Option.isNone(decoded)) {
        yield* Effect.logWarning("memory config is invalid — ignoring", { path: found.path })
        return undefined
      }
      return decoded.value
    })

    const loadGlobal = Effect.fn("MemoryConfig.loadGlobal")(function* () {
      const found = yield* readFirst(globalCandidates())
      if (!found) return undefined
      const config = yield* readGlobal(found)
      return config ? { config, path: found.path, level: "global" as const } : undefined
    })

    const load = Effect.fn("MemoryConfig.load")(function* (projectDir: string) {
      const root = (yield* projectRoot(projectDir)).root
      // `$HOME/.agents` is the user-level shared directory, not a project
      // layer: a root that resolves to $HOME must not read project memory
      // from `~/.agents/settings.local.json`.
      if (!hasProjectLayer(root, Global.Path.home)) return yield* loadGlobal()
      const file = localSettingsPath(root)
      const text = yield* fs.readFileStringSafe(file)
      if (text !== undefined) {
        const decoded = decodeSection(text)
        // A malformed document or an invalid `memory` section never falls
        // through to the global fallback: the project explicitly owns policy
        // here, so failing closed keeps a broken edit from silently changing
        // which configuration is in effect.
        if (Option.isNone(decoded)) {
          yield* Effect.logWarning("memory config is invalid — ignoring", { path: file })
          return undefined
        }
        if (decoded.value !== undefined) return { config: decoded.value, path: file, level: "project" as const }
      }
      // The local settings file may exist for other reasons (hooks,
      // permissions) or not exist at all; in both cases the global Memory
      // configuration remains the fallback.
      return yield* loadGlobal()
    })

    const writeProject = Effect.fn("MemoryConfig.writeProject")(function* (
      projectDir: string,
      config: MemorySchema.Config,
    ) {
      const location = yield* projectRoot(projectDir)
      assertProjectRootWritable(location.root, Global.Path.home)
      yield* ensureProjectExclude(location.root, location.toplevel)
      const target = localSettingsPath(location.root)
      // One Project = one shared local settings file, written by several paths
      // (/memory on|off and permission updates) from multiple worktrees and
      // processes. `settings.local.json` is edited in place, so serialize the
      // read-modify-write on the same file key HookPermissions.update uses.
      yield* flock.withLock(
        Effect.gen(function* () {
          const existing = (yield* fs.readFileStringSafe(target)) ?? "{}\n"
          yield* MemoryFile.atomicWrite(fs, target, patchMemorySection(existing, config))
        }),
        writeLockKey(target),
      )
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
        const existing = yield* readGlobal(found)
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

/** Cross-process serialization key for writes to one settings file. Shared
 * with HookPermissions.update so both editors of `settings.local.json`
 * serialize their read-modify-write. */
export function writeLockKey(file: string) {
  return file
}

/** `<root>/.agents/settings.local.json` — the only project memory location. */
export function localSettingsPath(root: string) {
  return ConfigPaths.projectLocalSettingsFile(root)
}

export function globalConfigDir() {
  return Flag.GRAPHAGENT_CONFIG_DIR ?? Global.Path.config
}

function globalCandidates() {
  return [join(globalConfigDir(), "memory.jsonc"), join(globalConfigDir(), "memory.json")]
}

function serialize(config: MemorySchema.Config) {
  return JSON.stringify(config, null, 2) + "\n"
}

function patchMemorySection(input: string, config: MemorySchema.Config) {
  const source = input.trim() ? input : "{}\n"
  const edits = modify(source, ["memory"], JSON.parse(JSON.stringify(config)), {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  })
  const next = applyEdits(source, edits)
  return next.endsWith("\n") ? next : next + "\n"
}

function pathJoinRelative(from: string, to: string) {
  return relative(from, to).split("\\").join("/")
}

/** Decode a global memory.json(c) document. */
export function decodeConfig(text: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return Option.none<MemorySchema.Config>()
  // Legacy files may still carry the removed topic_limit_floor knob — Schema
  // Struct decoding tolerates the extra property, so such files stay valid
  // and the dead value is simply dropped on the next write.
  return Schema.decodeUnknownOption(MemorySchema.Config)(value ?? {})
}

/**
 * Decode the `memory` section of a project `settings.local.json`. A valid
 * document without the section is `Some(undefined)`; malformed JSONC or an
 * invalid section is `None` so callers keep the previous state.
 */
export function decodeSection(text: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return Option.none<MemorySchema.Config | undefined>()
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "memory"))
    return Option.some(undefined)
  const decoded = Schema.decodeUnknownOption(MemorySchema.Config)((value as Record<string, unknown>).memory)
  return Option.isNone(decoded) ? Option.none<MemorySchema.Config | undefined>() : Option.some(decoded.value)
}
