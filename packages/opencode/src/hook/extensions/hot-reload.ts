/**
 * [FORK:hook-ext] Hooks config hot reload — not in upstream
 *
 * Polls the global (`~/.config/opencode/hooks.json`), project, and (when
 * distinct) worktree `.opencode/hooks.json` files for mtime changes and
 * triggers a reload when a modification is detected.
 *
 * Scope: global + project + worktree. `.claude/` directories are never read.
 *
 * Strategy: interval polling (mtime check every POLL_INTERVAL_MS), not fs.watch.
 * Rationale: inotify events are unreliable on WSL2 DrvFs mounts (`/mnt/*`) and
 * network filesystems; polling one small file per interval is cheap and
 * deterministic (D5).
 *
 * Debounce: 500ms + min 1s between reloads (kept from the prior fs.watch
 * implementation — prevents reload storms on rapid saves).
 *
 * The watchSettings signature + HotReloadHandle return type are unchanged from
 * the prior fs.watch version; only the internal detection mechanism switched to
 * polling.
 */

import { statSync } from "fs"
import path from "path"
import { Effect } from "effect"
import * as Log from "@/util/log"
import type { Settings } from "../settings"
import { hasWorktreeLayer } from "../workspace-trust"

const log = Log.create({ service: "hook.extensions.hot-reload" })

/** Polling interval (mtime check). Hardcoded constant for now (D5/Q1). */
const POLL_INTERVAL_MS = 2000

/**
 * hooks.json files polled for changes: global + project + worktree. `.claude/`
 * is never read. Global is included so editing `~/.config/opencode/hooks.json`
 * takes effect without a restart (previously startup-only).
 */
function watchedFiles(projectDir: string, worktree: string | undefined, opencodeGlobalConfig?: string): string[] {
  const files: string[] = []
  if (opencodeGlobalConfig) files.push(path.join(opencodeGlobalConfig, "hooks.json"))
  files.push(path.join(projectDir, ".opencode", "hooks.json"))
  // A non-VCS project reports the drive/filesystem root as its worktree, which
  // is not a workspace-owned layer: polling `/.opencode/hooks.json` would watch
  // a file shared by every session on the machine.
  if (hasWorktreeLayer(projectDir, worktree)) {
    files.push(path.join(worktree, ".opencode", "hooks.json"))
  }
  return files
}

export interface HotReloadHandle {
  /** Stop polling all files */
  close(): void
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

/** Current mtimeMs of a file, or 0 when it does not exist (treated as unchanged). */
function mtimeOrZero(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Poll `hooks.json` (global + project + worktree) for mtime changes. On a
 * change, call the reload callback which should re-run loadChain() and update
 * the state. `onReload` mutates the cached state object in place (same contract
 * as the prior fs.watch implementation).
 *
 * @param projectDir - Project root directory
 * @param worktree - Optional git worktree root; its .opencode/hooks.json is polled too
 * @param reload - Effect that builds the candidate settings for the changed file. It may run the
 *   ConfigChange gate against the CURRENT settings first; resolving to `undefined` rejects the
 *   candidate and the current settings stay in force.
 * @param onReload - Atomic commit callback, invoked synchronously with an accepted candidate
 *   and changed file path. Never invoked after `close()`.
 * @param opencodeGlobalConfig - OpenCode global config dir; its hooks.json is
 *   also polled so global hooks edits hot-reload without a restart.
 */
export function watchSettings(
  projectDir: string,
  worktree: string | undefined,
  reload: (changedFile: string) => Effect.Effect<Settings | undefined>,
  onReload: (newSettings: Settings, changedFile: string) => void,
  opencodeGlobalConfig?: string,
): HotReloadHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastReload = 0
  let closed = false
  // One reload at a time: a slow ConfigChange hook must not let an older candidate commit
  // after a newer one. close() interrupts the reload in flight.
  const controller = new AbortController()
  let running = false
  let pending: string | undefined

  const files = watchedFiles(projectDir, worktree, opencodeGlobalConfig)
  // Seed mtime snapshots so a pre-existing file does not fire on the first poll.
  const mtimes = new Map<string, number>(files.map((f) => [f, mtimeOrZero(f)]))
  log.info("polling hooks.json files", { files })

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

  // Debounce: 500ms. Min 1s between reloads. On min-interval block, reschedule
  // (not drop) so rapid successive saves are not permanently lost.
  const scheduleReload = (changedFile: string) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    const tryReload = () => {
      const now = Date.now()
      if (now - lastReload < 1000) {
        debounceTimer = setTimeout(tryReload, 1000 - (now - lastReload))
        return
      }
      lastReload = now
      fireReload(changedFile)
    }
    debounceTimer = setTimeout(tryReload, 500)
  }

  const check = () => {
    if (closed) return
    // Detect any mtime change (increase, decrease, or deletion → 0) and trigger
    // a reload. reload() re-reads the whole chain (loadChain handles missing
    // files) and is idempotent, so treating any change uniformly is safe —
    // including cp -p / touch -t restoring an older timestamp.
    let changedFile: string | undefined
    for (const f of files) {
      const m = mtimeOrZero(f)
      const prev = mtimes.get(f) ?? 0
      if (m !== prev) {
        mtimes.set(f, m)
        changedFile = f
      }
    }
    if (changedFile) scheduleReload(changedFile)
  }

  const interval = setInterval(check, POLL_INTERVAL_MS)
  // Don't keep the process alive just for polling (mirrors fs.watch persistent:false).
  if (typeof interval === "object" && "unref" in interval && typeof interval.unref === "function") {
    interval.unref()
  }

  return {
    close() {
      closed = true
      controller.abort()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(interval)
      log.info("stopped polling hooks.json files")
    },
  }
}

/**
 * @internal Test-only: the hooks.json files polled for a project/worktree, so
 * tests can assert the polling set without waiting on the poll interval.
 */
export { watchedFiles as __watchedFiles }
