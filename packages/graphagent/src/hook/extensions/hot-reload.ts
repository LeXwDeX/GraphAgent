// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Hooks config hot reload — not in upstream
 *
 * Watches the directories that hold the global (`~/.config/graphagent/hooks.json`,
 * overridable through `GRAPHAGENT_CONFIG_DIR`) and the project's
 * `<root>/.agents/hooks.json` plus `<root>/.agents/hooks.local.json` files and
 * triggers a reload when one of them changes.
 *
 * Why directories and not files: editors commonly write a temp file and rename
 * it over the target, which invalidates a file-level watch. Watching the parent
 * directory survives that pattern. Events are filtered to `hooks.json` /
 * `hooks.local.json` and confirmed with an `ino:size:mtime:ctime` signature, so
 * rename churn and duplicate events do not reload an unchanged chain.
 *
 * Scope: global + project (committed and local). There is no worktree layer —
 * a linked worktree is itself a project root. `.claude/` directories are never
 * read.
 *
 * Missing directories: the watcher attaches to the nearest existing ancestor
 * and upgrades to the target directory as soon as it appears (Issue §9's
 * "wait for creation" path).
 *
 * Debounce: 150ms after the last matching event. Reloads stay serialized (a
 * slow ConfigChange hook must not let an older candidate commit after a newer
 * one) and `close()` aborts the reload in flight.
 *
 * Fallback: `fs.watch` is unreliable on WSL2 DrvFs mounts (`/mnt/*`) and some
 * network filesystems. When the watch cannot be established (throw or error
 * event) or the directory is a known unreliable mount, detection degrades to a
 * 30s `stat` signature check. That is a safety net, not the main path.
 */

import { statSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { Global } from "@graphagent/core/global"
import { hasProjectLayer } from "@/project/project-root"
import * as Log from "@/util/log"
import type { Settings } from "../types"

const log = Log.create({ service: "hook.extensions.hot-reload" })

/** Debounce after the last matching fs event before the chain is re-read. */
const DEBOUNCE_MS = 150

/** Safety net when `fs.watch` is unavailable or unreliable (Issue §9). */
const FALLBACK_INTERVAL_MS = 30_000

/**
 * hooks.json files watched for changes: global + the project's committed and
 * local files under `<root>/.agents/`. `.claude/` is never read. Global is
 * included so editing `~/.config/graphagent/hooks.json` takes effect without a
 * restart (previously startup-only).
 */
function watchedFiles(root: string, globalConfigDir?: string): string[] {
  const files: string[] = []
  if (globalConfigDir) files.push(path.join(globalConfigDir, "hooks.json"))
  // `$HOME/.agents` is the user-level shared directory, not a project layer.
  if (!hasProjectLayer(root, Global.Path.home)) return files
  files.push(path.join(root, PROJECT_DIR, "hooks.json"))
  files.push(path.join(root, PROJECT_DIR, "hooks.local.json"))
  return files
}

export interface HotReloadHandle {
  /** Close every watcher and stop all reload activity. */
  close(): void
}

export type WatchFn = (
  dir: string,
  options: { persistent: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

const defaultWatch: WatchFn = (dir, options, listener) => watch(dir, options, listener)
let watchFn: WatchFn = defaultWatch
let fallbackIntervalMs = FALLBACK_INTERVAL_MS

/**
 * @internal Test-only: replace `fs.watch` to exercise the stat fallback. Pass
 * `undefined` to restore the real implementation.
 */
export function __setWatchImplForTest(impl: WatchFn | undefined): void {
  watchFn = impl ?? defaultWatch
}

/**
 * @internal Test-only: shorten the fallback interval so the degraded path can
 * be observed without waiting 30 seconds. Pass `undefined` to restore it.
 */
export function __setFallbackIntervalForTest(ms: number | undefined): void {
  fallbackIntervalMs = ms ?? FALLBACK_INTERVAL_MS
}

/**
 * Count total hooks in a settings object (for logging).
 */
function countHooks(settings: Settings): number {
  if (!settings.hooks) return 0
  let count = 0
  for (const matchers of Object.values(settings.hooks)) {
    if (!matchers) continue
    for (const m of matchers) {
      count += m.hooks.length
    }
  }
  return count
}

/**
 * Content identity of a file. `ino` catches atomic replace (temp file + rename),
 * `size` catches truncation, and the timestamps cover in-place edits. A missing
 * file is its own signature so creation and deletion both look like changes.
 */
function signature(file: string): string {
  try {
    const s = statSync(file)
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    return "missing"
  }
}

/** Deepest existing ancestor of `dir`, used to wait for a missing directory. */
function nearestExistingDir(dir: string): string {
  let current = path.resolve(dir)
  while (true) {
    try {
      if (statSync(current).isDirectory()) return current
    } catch {
      // Fall through to the parent.
    }
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/**
 * WSL2 DrvFs mounts do not deliver reliable inotify events, so watching them
 * would silently miss changes. Treat them as fallback-only.
 */
function unreliableFilesystem(dir: string): boolean {
  return process.platform === "linux" && /^\/mnt\/[a-zA-Z](\/|$)/.test(path.resolve(dir))
}

/**
 * Watch `hooks.json` (global + project committed/local) through their parent
 * directories. On a confirmed change, call the reload callback which should
 * re-run loadChain() and update the state. `onReload` mutates the cached state
 * object in place (same contract as the prior polling implementation).
 *
 * @param root - Project root (`ctx.root`); `<root>/.agents/hooks.json` and
 *   `<root>/.agents/hooks.local.json` are watched
 * @param reload - Effect that builds the candidate settings for the changed file. It may run the
 *   ConfigChange gate against the CURRENT settings first; resolving to `undefined` rejects the
 *   candidate and the current settings stay in force.
 * @param onReload - Atomic commit callback, invoked synchronously with an accepted candidate
 *   and changed file path. Never invoked after `close()`.
 * @param globalConfigDir - Global config dir; its hooks.json is also watched so
 *   global hooks edits hot-reload without a restart.
 */
export function watchSettings(
  root: string,
  reload: (changedFile: string) => Effect.Effect<Settings | undefined>,
  onReload: (newSettings: Settings, changedFile: string) => void,
  globalConfigDir?: string,
): HotReloadHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let debounceFile: string | undefined
  let closed = false
  // One reload at a time: a slow ConfigChange hook must not let an older candidate commit
  // after a newer one. close() interrupts the reload in flight.
  const controller = new AbortController()
  let running = false
  let pending: string | undefined

  const files = watchedFiles(root, globalConfigDir).map((file) => path.resolve(file))
  // Seed signatures before attaching watchers so pre-existing files do not fire.
  const signatures = new Map<string, string>(files.map((file) => [file, signature(file)]))

  // Directory → (basename → file) for event filtering. A single directory can
  // hold both project files; the global directory holds one.
  const targetsByDir = new Map<string, Map<string, string>>()
  for (const file of files) {
    const dir = path.dirname(file)
    const byName = targetsByDir.get(dir) ?? new Map<string, string>()
    byName.set(path.basename(file), file)
    targetsByDir.set(dir, byName)
  }
  const targetDirs = [...targetsByDir.keys()]

  const watchers = new Map<string, FSWatcher>()
  // Directories where fs.watch is known to be unavailable; the fallback stat
  // check covers every watched file, so per-directory bookkeeping is enough.
  const degraded = new Set<string>()
  let fallbackTimer: ReturnType<typeof setInterval> | null = null

  const fireReload = (changedFile: string) => {
    if (closed) return
    if (running) {
      pending = changedFile
      return
    }
    running = true
    log.info("hooks.json changed, reloading", { file: changedFile })
    // Fire-and-forget: reload errors are logged but never crash
    Effect.runPromise(
      Effect.suspend(() => reload(changedFile)),
      { signal: controller.signal },
    )
      .then((settings) => {
        if (closed) return
        if (!settings) {
          log.info("hooks reload rejected; keeping current hooks", { file: changedFile })
          return
        }
        log.info("hooks hot-reloaded", { file: changedFile, hookCount: countHooks(settings) })
        onReload(settings, changedFile)
      })
      .catch((err) => log.warn("hooks reload failed", { file: changedFile, error: String(err) }))
      .finally(() => {
        running = false
        const next = pending
        pending = undefined
        if (next !== undefined && !closed) fireReload(next)
      })
  }

  // Debounce the burst of events an editor save produces. The last changed
  // file wins; signature checks already dropped no-op events.
  const scheduleReload = (changedFile: string) => {
    if (closed) return
    debounceFile = changedFile
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (debounceFile !== undefined) fireReload(debounceFile)
    }, DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  /** Compare a file's content identity and queue a reload only when it moved. */
  const checkFile = (file: string) => {
    if (closed) return
    const prev = signatures.get(file) ?? "missing"
    const next = signature(file)
    if (next === prev) return
    signatures.set(file, next)
    scheduleReload(file)
  }

  const enableFallback = () => {
    if (fallbackTimer || closed) return
    log.warn("fs.watch unavailable for hooks.json; falling back to stat checks", {
      intervalMs: fallbackIntervalMs,
    })
    fallbackTimer = setInterval(() => {
      if (closed) return
      // Retry attaching watchers for directories that appeared later, then
      // validate every watched file by signature.
      for (const dir of targetDirs) ensureWatch(dir)
      for (const file of files) checkFile(file)
    }, fallbackIntervalMs)
    fallbackTimer.unref?.()
  }

  const ensureWatch = (dir: string) => {
    if (closed || watchers.has(dir)) return
    const existing = nearestExistingDir(dir)
    if (watchers.has(existing) || degraded.has(existing)) return
    if (unreliableFilesystem(existing)) {
      degraded.add(existing)
      enableFallback()
      return
    }
    let watcher: FSWatcher
    try {
      watcher = watchFn(existing, { persistent: false }, (_event, name) => {
        if (closed) return
        // A missing target directory may have just been created: upgrade to a
        // direct watch so later file events arrive.
        for (const target of targetDirs) if (!watchers.has(target)) ensureWatch(target)
        // Confirm the event actually changed one of the watched files. Only
        // `hooks.json` / `hooks.local.json` are in `targetsByDir`, which also
        // filters out temp-file churn from atomic saves.
        const byName = targetsByDir.get(existing)
        if (byName) {
          if (name === null) {
            for (const file of byName.values()) checkFile(file)
          } else {
            const file = byName.get(typeof name === "string" ? name : name.toString())
            if (file) checkFile(file)
          }
        }
        // Files under a directory that was upgraded on this event may have
        // been written before the new watcher attached; compare them now.
        for (const target of targetDirs) {
          if (target === existing || !watchers.has(target)) continue
          const upgraded = targetsByDir.get(target)
          if (upgraded) for (const file of upgraded.values()) checkFile(file)
        }
      })
    } catch (err) {
      log.warn("fs.watch failed; falling back to stat checks", { dir: existing, error: String(err) })
      degraded.add(existing)
      enableFallback()
      return
    }
    watcher.on("error", (err) => {
      watcher.close()
      watchers.delete(existing)
      degraded.add(existing)
      log.warn("fs.watch error; falling back to stat checks", { dir: existing, error: String(err) })
      enableFallback()
    })
    watcher.unref()
    watchers.set(existing, watcher)
    log.info("watching hooks.json directory", { dir: existing, target: dir })
  }

  for (const dir of targetDirs) ensureWatch(dir)
  log.info("watching hooks.json files", { files })

  return {
    close() {
      closed = true
      controller.abort()
      if (debounceTimer) clearTimeout(debounceTimer)
      if (fallbackTimer) clearInterval(fallbackTimer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      log.info("stopped watching hooks.json files")
    },
  }
}

/**
 * @internal Test-only: the hooks.json files watched for a project/worktree, so
 * tests can assert the watch set without waiting on the watcher.
 */
export { watchedFiles as __watchedFiles }
