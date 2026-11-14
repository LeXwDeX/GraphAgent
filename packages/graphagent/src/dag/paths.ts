// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG asset paths — one resolver for configuration, workflow specs and prompt
 * templates.
 *
 * The project scope is rooted at the nearest directory at or above the given
 * directory that carries a `.agents/` marker, bounded by the git toplevel of a
 * linked worktree and never resolving to `$HOME` (B5 / #1038,
 * `project/project-root.ts`). Workflow assets live under
 * `<root>/.agents/workflows/`, with prompt templates in its `prompts/`
 * subdirectory. The user scope is the XDG config directory
 * (`Global.Path.config`, which already honors GRAPHAGENT_CONFIG_DIR and the
 * test override), matching how the main config resolves.
 *
 * Resolution is synchronous: git toplevel lookup and the marker walk are a
 * bounded number of cheap syscalls, and callers on the spawn-scheduling hot
 * path cache the result per scheduling round.
 */

export * as DagPaths from "./paths"

import { execFileSync } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { Global } from "@graphagent/core/global"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { hasProjectLayer, resolveProjectRoot } from "@/project/project-root"

const WORKFLOWS = "workflows"
const PROMPTS = "prompts"

/** Resolve the project root for a directory: git toplevel when available,
 * `.agents/` marker walk otherwise, never `$HOME`. */
export function projectRoot(directory: string): string {
  // git reports real paths; canonicalize first so a symlinked temp directory
  // (macOS /var vs /private/var) still compares inside its own toplevel.
  const start = canonical(directory)
  return resolveProjectRoot(start, {
    home: Global.Path.home,
    toplevel: gitToplevel(start),
    isDirectory: (candidate) => {
      try {
        return statSync(candidate).isDirectory()
      } catch {
        return false
      }
    },
  })
}

/** The project root when one exists, or undefined when resolution lands on
 * `$HOME` (which never carries a project layer). Callers use this to skip the
 * project scope entirely instead of reading `~/.agents`. */
export function projectLayer(directory: string): string | undefined {
  const root = projectRoot(directory)
  return hasProjectLayer(root, Global.Path.home) ? root : undefined
}

/** `<root>/.agents/workflows` — the project's saved workflow library. */
export function projectWorkflows(root: string): string {
  return path.join(root, PROJECT_DIR, WORKFLOWS)
}

/** `<root>/.agents/workflows/prompts` — the project's prompt template assets. */
export function projectPrompts(root: string): string {
  return path.join(projectWorkflows(root), PROMPTS)
}

/** `<config dir>/workflows` — the user-level saved workflow library. */
export function globalWorkflows(): string {
  return path.join(Global.Path.config, WORKFLOWS)
}

/** `<config dir>/workflows/prompts` — the user-level prompt template assets. */
export function globalPrompts(): string {
  return path.join(globalWorkflows(), PROMPTS)
}

function canonical(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return path.resolve(directory)
  }
}

/** The working tree's toplevel, or undefined outside a git repository. A
 * linked worktree reports its own toplevel, so project resolution stops there
 * instead of climbing into the main checkout. */
function gitToplevel(directory: string): string | undefined {
  try {
    const text = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return text || undefined
  } catch {
    return undefined
  }
}