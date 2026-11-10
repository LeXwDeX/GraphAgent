// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Project trust service (T1 PR2).
 *
 * Enumerates the executable entries of the project layer (`<root>/.agents/`),
 * fingerprints them, and compares the result with `trust.json` in the user's
 * XDG state directory. It does not gate any loader here: PR3 wires
 * `check(id, fp)` into hooks, MCP, command templates, formatter and LSP.
 *
 * `$HOME` carries no project layer, so the service reports no entries and
 * writes no project record there.
 */
import path from "path"
import { readFileSync, realpathSync, statSync } from "fs"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { ProjectTrust as ProjectTrustEvent } from "@graphagent/schema/project-trust"
import { Context, Effect, Layer, Semaphore } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import type { InstanceContext } from "@/project/instance-context"
import { hasProjectLayer } from "@/project/project-root"
import { classifyEntryChanges, type EntryClassification } from "./location"
import { enumerateProjectEntries, LOCAL_PROJECT_FILES, type ProjectLayerFile } from "./entries"
import { fingerprint, type FingerprintFileSystem } from "./fingerprint"
import { projectIdentity, type ProjectIdentity } from "./identity"
import { assessRisk } from "./risk"
import type { TrustDecisionInput, TrustEntryView, TrustState } from "./schema"
import { make as makeStore, trustFilePath, type TrustFile, type TrustProjectRecord, type TrustRecord } from "./store"
import type { TrustEntry } from "./types"

/** Files read directly from the project layer, before the globbed sources. */
const DIRECT_FILES = ["hooks.json", "hooks.local.json", "mcp.json", "settings.json", "settings.local.json"] as const

/** Sources scanned under the project layer. */
const GLOB_PATTERNS = ["skills/**/SKILL.md", "agents/*.md", "commands/*.md"] as const

/**
 * Synchronous filesystem adapter for the pure fingerprint function. Referenced
 * scripts are small project files; reading them synchronously keeps the
 * fingerprint call pure and avoids an Effect conversion per token.
 */
const nodeFiles: FingerprintFileSystem = {
  realpath: (candidate) => {
    try {
      return realpathSync(candidate)
    } catch {
      return undefined
    }
  },
  isFile: (resolved) => {
    try {
      return statSync(resolved).isFile()
    } catch {
      return false
    }
  },
  read: (resolved) => {
    try {
      return readFileSync(resolved)
    } catch {
      return undefined
    }
  },
}

export interface ImportedTrustEntry {
  id: string
  fp: string
  command?: string
}

export interface Interface {
  /** Enumerate the project layer and merge the recorded decisions. */
  readonly list: () => Effect.Effect<TrustEntryView[]>
  /** Read-only lookup for load points (PR3): a missing or stale record is `pending`. */
  readonly check: (id: string, fp: string) => Effect.Effect<TrustState>
  /** Apply user decisions; unknown ids are ignored. Publishes `project.trust.updated` when a record was written. */
  readonly decide: (decisions: readonly TrustDecisionInput[]) => Effect.Effect<void>
  /** Record entries written by `/import-claude` (D2) as trusted with their post-write fingerprints. */
  readonly trustImported: (entries: readonly ImportedTrustEntry[]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/ProjectTrust") {}

export interface Options {
  /** State directory holding `trust.json`; defaults to the global XDG state directory. */
  readonly stateDirectory?: string
}

interface Current {
  readonly ctx: InstanceContext
  readonly identity: ProjectIdentity
  readonly realRoot: string
}

interface Snapshot {
  readonly data: TrustFile
  readonly project: TrustProjectRecord
  readonly entries: EntryClassification[]
  readonly removed: string[]
}

const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service
    const store = makeStore({ file: trustFilePath(options.stateDirectory), fs })
    // `decide` and `trustImported` are read-modify-write cycles; serialize them
    // so concurrent decisions cannot drop each other.
    const lock = Semaphore.makeUnsafe(1)

    const resolve = Effect.fn("ProjectTrust.resolve")(function* () {
      const ctx = yield* InstanceState.context
      if (!hasProjectLayer(ctx.root, Global.Path.home)) return undefined
      const realRoot = yield* fs.realPath(ctx.root).pipe(Effect.catch(() => Effect.succeed(ctx.root)))
      const remote = yield* git.run(["config", "--get", "remote.origin.url"], { cwd: ctx.root }).pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) return undefined
          const url = result.text().trim()
          return url.length > 0 ? url : undefined
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      return { ctx, realRoot, identity: projectIdentity({ root: ctx.root, realRoot, remote }) } satisfies Current
    })

    const readLayer = Effect.fn("ProjectTrust.readLayer")(function* (current: Current) {
      const directory = path.join(current.ctx.root, PROJECT_DIR)
      if (!(yield* fs.isDir(directory))) return [] as ProjectLayerFile[]

      const names = new Set<string>()
      for (const name of DIRECT_FILES) {
        if (yield* fs.isFile(path.join(directory, name))) names.add(name)
      }
      for (const pattern of GLOB_PATTERNS) {
        const matches = yield* fs
          .glob(pattern, { cwd: directory, absolute: false, include: "file", dot: true, symlink: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const match of matches) {
          const file = match.replaceAll("\\", "/").replace(/^\.\//, "")
          if (file) names.add(file)
        }
      }

      const files: ProjectLayerFile[] = []
      for (const file of [...names].toSorted()) {
        const text = yield* fs
          .readFileStringSafe(path.join(directory, ...file.split("/")))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (text !== undefined) files.push({ file, text })
      }
      return files
    })

    const trackedLocalFiles = Effect.fn("ProjectTrust.trackedLocalFiles")(function* (
      current: Current,
      files: readonly ProjectLayerFile[],
    ) {
      const tracked = new Set<string>()
      for (const file of files) {
        if (!LOCAL_PROJECT_FILES.includes(file.file)) continue
        const result = yield* git.run(["ls-files", "--error-unmatch", "--", `${PROJECT_DIR}/${file.file}`], {
          cwd: current.ctx.root,
        })
        if (result.exitCode === 0) tracked.add(file.file)
      }
      return tracked
    })

    const projectRecord = (current: Current): TrustProjectRecord => ({
      root: current.identity.root,
      ...(current.identity.remote === undefined ? {} : { remote: current.identity.remote }),
      entries: {},
    })

    const snapshot = Effect.fn("ProjectTrust.snapshot")(function* (current: Current) {
      const data = yield* store.read
      const project = data.projects[current.identity.id] ?? projectRecord(current)
      const files = yield* readLayer(current)
      const tracked = yield* trackedLocalFiles(current, files)
      const enumeration = enumerateProjectEntries({ files, isTracked: (file) => tracked.has(file) })
      const fingerprinted = enumeration.entries.map((entry) => ({
        entry,
        fingerprint: fingerprint(entry, { root: current.ctx.root, realRoot: current.realRoot, files: nodeFiles }),
      }))
      const previous = Object.entries(project.entries).map(([id, record]) => ({ id, fp: record.fp }))
      const classified = classifyEntryChanges(previous, fingerprinted)
      return { data, project, entries: classified.entries, removed: classified.removed } satisfies Snapshot
    })

    const view = (item: EntryClassification, project: TrustProjectRecord): TrustEntryView => {
      const record = project.entries[item.entry.id]
      const state: TrustState = record !== undefined && record.fp === item.fingerprint ? record.decision : "pending"
      const previous =
        item.change === "modified" && record?.command !== undefined && record.command !== item.entry.display.text
          ? record.command
          : undefined
      return {
        id: item.entry.id,
        category: item.entry.category,
        fp: item.fingerprint,
        state,
        ...(item.change === undefined ? {} : { change: item.change }),
        ...(previous === undefined ? {} : { previous }),
        source: item.entry.source,
        when: whenFor(item.entry),
        command: item.entry.display.text,
        risks: assessRisk(item.entry),
      }
    }

    const list = Effect.fn("ProjectTrust.list")(function* () {
      const current = yield* resolve()
      if (!current) return []
      const value = yield* snapshot(current)
      return value.entries.map((item) => view(item, value.project))
    })

    const check = Effect.fn("ProjectTrust.check")(function* (id: string, fp: string) {
      const current = yield* resolve()
      if (!current) return "pending" as const
      const data = yield* store.read
      const record = data.projects[current.identity.id]?.entries[id]
      if (record === undefined || record.fp !== fp) return "pending" as const
      return record.decision
    })

    const decide = Effect.fn("ProjectTrust.decide")(function* (decisions: readonly TrustDecisionInput[]) {
      const current = yield* resolve()
      if (!current) return
      const outcome = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const value = yield* snapshot(current)
          const known = new Map(value.entries.map((item) => [item.entry.id, item]))
          const applied = decisions.filter((decision) => known.has(decision.id))
          if (applied.length === 0) return undefined

          // Records of entries that no longer exist are cleared on every write.
          const entries: Record<string, TrustRecord> = {}
          for (const id of known.keys()) {
            const record = value.project.entries[id]
            if (record) entries[id] = record
          }
          for (const decision of applied) {
            if (decision.state === "revoked") {
              delete entries[decision.id]
              continue
            }
            const item = known.get(decision.id)
            if (!item) continue
            entries[decision.id] = {
              fp: item.fingerprint,
              decision: decision.state,
              decidedAt: Date.now(),
              command: item.entry.display.text,
            }
          }

          const next: TrustFile = {
            version: value.data.version,
            projects: { ...value.data.projects, [current.identity.id]: { ...value.project, entries } },
          }
          if (!(yield* store.write(next))) return undefined
          return {
            projectID: current.identity.id,
            entries: applied.map((decision) => decision.id),
            removed: value.removed,
          }
        }),
      )
      if (outcome) yield* events.publish(ProjectTrustEvent.Event.Updated, outcome)
    })

    const trustImported = Effect.fn("ProjectTrust.trustImported")(function* (imported: readonly ImportedTrustEntry[]) {
      const current = yield* resolve()
      if (!current || imported.length === 0) return
      const outcome = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const data = yield* store.read
          const project = data.projects[current.identity.id] ?? projectRecord(current)
          const entries = { ...project.entries }
          for (const item of imported) {
            entries[item.id] = {
              fp: item.fp,
              decision: "trusted",
              decidedAt: Date.now(),
              ...(item.command === undefined ? {} : { command: item.command }),
            }
          }
          const next: TrustFile = {
            version: data.version,
            projects: { ...data.projects, [current.identity.id]: { ...project, entries } },
          }
          if (!(yield* store.write(next))) return undefined
          return { projectID: current.identity.id, entries: imported.map((item) => item.id), removed: [] as string[] }
        }),
      )
      if (outcome) yield* events.publish(ProjectTrustEvent.Event.Updated, outcome)
    })

    return Service.of({ list, check, decide, trustImported })
  })

export const makeLayer = (options: Options = {}) => Layer.effect(Service, make(options))

export const layer = makeLayer()

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, Git.node, EventV2Bridge.node])

function whenFor(entry: TrustEntry): string {
  switch (entry.category) {
    case "mcp":
      return "mcp.start"
    case "command-shell":
      return "command.shell"
    case "formatter":
      return "formatter.run"
    case "lsp":
      return "lsp.start"
    default:
      // Hook-derived categories show the hook event that triggers them.
      return entry.label
  }
}

export * as ProjectTrust from "./service"
