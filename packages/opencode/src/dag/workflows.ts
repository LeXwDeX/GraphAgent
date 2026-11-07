// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Workflow library — reusable start specs discovered by name.
 *
 * Named workflows let a spec live as a durable project asset instead of a
 * throwaway file the agent must rewrite per run. `workflow(spec_path: "x")`
 * resolves through this module; a path-shaped `spec_path` bypasses it and keeps
 * the original session-relative behavior.
 *
 * Lookup order (first match wins):
 * - project: `.opencode/workflows/<name>.yaml` / `.yml`
 * - global:  `<config dir>/workflows/<name>.yaml` / `.yml`
 * - builtin:  templates compiled into the binary from opencode-dag-config
 *   (the release pipeline injects the snapshot via DAG_TEMPLATES_DIR, so
 *   air-gapped installs still ship the curated templates)
 *
 * Mirrors config.ts: same two-level scope, same GRAPHAGENT_CONFIG_DIR redirect,
 * read lazily so edits apply on the next call and startup stays untouched.
 */

export * as DagWorkflows from "./workflows"

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@/util/record"

// Injected by the build (build.ts define), mirrors GRAPHAGENT_MODELS_DEV.
declare const GRAPHAGENT_DAG_TEMPLATES: Record<string, string> | undefined

const DIRECTORY = "workflows"
const EXTENSIONS = [".yaml", ".yml"]

export type Scope = "project" | "global" | "builtin"

export interface Entry {
  readonly name: string
  readonly scope: Scope
  /** Filesystem path for project/global; synthetic `builtin://name` for builtin. */
  readonly path: string
  /** Inline content for builtin entries (no backing file on disk). */
  readonly content?: string
  /** Workflow title from the spec, when the file declares one. */
  readonly title?: string
  /** Intended outcome from config.objective, used to select before reading. */
  readonly objective?: string
  /** Node count, for a one-glance sense of the graph's size. */
  readonly nodes?: number
  /** Block count when the saved spec uses the high-level interface. */
  readonly blocks?: number
}

/** Builtin templates compiled into the binary from opencode-dag-config. */
export function builtinTemplates(): Record<string, string> {
  // The build replaces the identifier via define; bare source/test runs have
  // no global binding, so guard instead of throwing a ReferenceError.
  if (typeof GRAPHAGENT_DAG_TEMPLATES === "undefined") return {}
  return GRAPHAGENT_DAG_TEMPLATES
}

const BUILTIN_PREFIX = "builtin://"

/** A name has no path separators and no YAML extension — those mean a path. */
export function isName(value: string) {
  if (!value) return false
  if (value.includes("/") || value.includes("\\")) return false
  if (EXTENSIONS.includes(path.extname(value).toLowerCase())) return false
  // Control characters are never valid in a filename, and a NUL makes the fs
  // calls in resolve() reject — which surfaces as a raw TypeError instead of
  // the actionable "not found" message. Let the path branch reject it.
  if (/[\u0000-\u001f]/.test(value)) return false
  // Leave `.` and `..` to the path branch; they are directories, not names.
  return !value.startsWith(".")
}

/**
 * Resolve a workflow name. Returns undefined when no scope holds it, so
 * callers can report the searched locations instead of a bare ENOENT.
 */
export function resolve(name: string, projectDir: string): Effect.Effect<Entry | undefined> {
  return Effect.promise(async () => {
    for (const scope of scopes(projectDir)) {
      for (const extension of EXTENSIONS) {
        const file = path.join(scope.dir, `${name}${extension}`)
        if (!(await Bun.file(file).exists())) continue
        return { name, scope: scope.scope, path: file, ...(await describe(file)) }
      }
    }
    const content = builtinTemplates()[name]
    if (content === undefined) return undefined
    return builtinEntry(name, content)
  })
}

/** Every directory a named workflow may live in, in resolution order. */
export function searchPaths(projectDir: string) {
  return scopes(projectDir).map((scope) => scope.dir)
}

/**
 * List available workflows. A project entry shadows a global one with the same
 * name, and either shadows a builtin one — matching resolve()'s precedence so
 * the listing never advertises a file that resolve() would not pick.
 */
export function list(projectDir: string): Effect.Effect<Entry[]> {
  return Effect.promise(async () => {
    const seen = new Map<string, Entry>()
    for (const scope of scopes(projectDir)) {
      const entries = await fs.readdir(scope.dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const extension = path.extname(entry.name).toLowerCase()
        if (!EXTENSIONS.includes(extension)) continue
        const name = path.basename(entry.name, extension)
        if (seen.has(name)) continue
        const file = path.join(scope.dir, entry.name)
        seen.set(name, { name, scope: scope.scope, path: file, ...(await describe(file)) })
      }
    }
    for (const [name, content] of Object.entries(builtinTemplates())) {
      if (seen.has(name)) continue
      seen.set(name, await builtinEntry(name, content))
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
}

/** Whether a path is the synthetic builtin marker. */
export function isBuiltinPath(filepath: string) {
  return filepath.startsWith(BUILTIN_PREFIX)
}

/** The name encoded in a synthetic `builtin://name` path. */
export function builtinName(filepath: string) {
  return filepath.slice(BUILTIN_PREFIX.length)
}

async function builtinEntry(name: string, content: string): Promise<Entry> {
  return { name, scope: "builtin", path: `${BUILTIN_PREFIX}${name}`, content, ...(await parseMeta(content)) }
}

// Resolution order, project first. The global directory applies the same
// GRAPHAGENT_CONFIG_DIR redirect the Global service applies in make(), so managed
// setups pointing the config dir elsewhere are honored here too.
function scopes(projectDir: string) {
  return [
    { scope: "project" as const, dir: path.join(projectDir, ".opencode", DIRECTORY) },
    { scope: "global" as const, dir: path.join(Flag.GRAPHAGENT_CONFIG_DIR ?? Global.Path.config, DIRECTORY) },
  ]
}

/** Best-effort listing metadata from a file-backed spec. */
async function describe(
  file: string,
): Promise<{ title?: string; objective?: string; nodes?: number; blocks?: number }> {
  const text = await Bun.file(file)
    .text()
    .catch(() => undefined)
  return text === undefined ? {} : parseMeta(text)
}

/** Parse bounded selection metadata from spec content (shared with builtins).
 * A malformed spec still lists — hiding it would make a typo look like a
 * missing file; the start path reports the real parse error. */
async function parseMeta(
  text: string,
): Promise<{ title?: string; objective?: string; nodes?: number; blocks?: number }> {
  const parsed = await Promise.resolve(text)
    .then((value) => Bun.YAML.parse(value))
    .catch(() => undefined)
  if (!isRecord(parsed)) return {}
  const config = isRecord(parsed["config"]) ? parsed["config"] : undefined
  const rawTitle = typeof parsed["title"] === "string" ? parsed["title"] : undefined
  const rawObjective = config && typeof config["objective"] === "string" ? config["objective"] : undefined
  const title = rawTitle ? preview(rawTitle, 160) : undefined
  const objective = rawObjective ? preview(rawObjective, 240) : undefined
  const nodes = config && Array.isArray(config["nodes"]) ? config["nodes"].length : undefined
  const blocks = config && Array.isArray(config["blocks"]) ? config["blocks"].length : undefined
  return {
    ...(title ? { title } : {}),
    ...(objective ? { objective } : {}),
    ...(nodes === undefined ? {} : { nodes }),
    ...(blocks === undefined ? {} : { blocks }),
  }
}

function preview(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, " ").trim()
  const codepoints = [...normalized]
  if (codepoints.length <= limit) return normalized
  return `${codepoints.slice(0, limit - 1).join("")}…`
}
