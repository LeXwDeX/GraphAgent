// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG prompt-template resolver.
 *
 * Resolves a node's `prompt_template` declaration into a final prompt string:
 * - `id` reference → reads the `.md` file from project (`.agents/dag-prompts/`)
 *   or global (`<config dir>/dag-prompts/`) directory
 * - `inline` → used directly as the template source (no filesystem round-trip)
 *
 * Both paths go through `{{var}}` interpolation and `sanitize()`.
 *
 * The template library is NOT loaded at startup. Files are read lazily at
 * resolve time — if no node references a template, zero files are read.
 */

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { Global } from "@graphagent/core/global"
import { Flag } from "@graphagent/core/flag/flag"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { sanitizeInput } from "./sanitize"

export interface TemplateRef {
  id?: string
  inline?: string
  input?: Record<string, unknown>
}

const INTERPOLATION_RE = /{{\s*([^{}]+?)\s*}}/g

/** Placeholder keys appearing in a template source, deduplicated, first-seen
 * order. Matches exactly what `interpolate` tries to resolve — the single
 * source of truth for template syntax, shared with acceptance-time binding
 * validation. */
export function placeholderKeys(template: string): string[] {
  return [...new Set([...template.matchAll(INTERPOLATION_RE)].map((match) => match[1]))]
}

/** A template id must be a single path segment (no separators, no parent refs)
 * so it cannot escape the dag-prompts directory via path traversal. */
function isSafeTemplateId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && id !== "." && id !== ".."
}

/**
 * Resolve a template reference into a final prompt string.
 *
 * @param ref         The prompt_template declaration from the node config
 * @param projectDir  The project root (for `.agents/dag-prompts/` lookup)
 */
export function resolveTemplate(ref: TemplateRef, projectDir: string): Effect.Effect<string, Error> {
  return renderTemplate(ref, projectDir).pipe(Effect.map((result) => result.text))
}

/** Read a template asset by id without interpolation — validation needs the
 * raw source to check placeholder bindings before any node spawn. */
export function templateSourceById(id: string, projectDir: string): Effect.Effect<string, Error> {
  return readById(id, projectDir)
}

export function renderTemplate(
  ref: TemplateRef,
  projectDir: string,
  dynamicInput: Record<string, unknown> = {},
) {
  return Effect.gen(function* () {
    const input = sanitizeInput({ ...dynamicInput, ...ref.input })
    const raw = yield* readTemplateSource(ref, projectDir)
    const interpolatedDynamicKeys = placeholderKeys(raw).filter((key) =>
      Object.hasOwn(dynamicInput, key)
      && !Object.hasOwn(ref.input ?? {}, key)
      && input[key] !== null
      && input[key] !== undefined
      // Context can omit a value only when interpolation delivered it intact.
      // In particular, review evidence may be rewritten by this sanitizer.
      && (input[key] === dynamicInput[key] || JSON.stringify(input[key]) === JSON.stringify(dynamicInput[key])),
    )
    return { ...interpolate(raw, input), interpolatedDynamicKeys }
  })
}

function readTemplateSource(ref: TemplateRef, projectDir: string): Effect.Effect<string, Error> {
  if (ref.inline !== undefined) {
    // Inline content IS the template source — a temp-file write/read/delete
    // round-trip adds spawn-path I/O and failure surface for no benefit.
    return Effect.succeed(ref.inline)
  }
  if (ref.id) {
    return readById(ref.id, projectDir)
  }
  return Effect.fail(new Error("prompt_template must have either 'id' or 'inline'"))
}

function readById(id: string, projectDir: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    // Reject path traversal: a template id must be a single path segment so it
    // cannot escape the dag-prompts directory. "\" is rejected for Windows,
    // where it is a path separator.
    if (!isSafeTemplateId(id)) {
      return yield* Effect.fail(new Error(`Invalid template id: ${id}`))
    }
    const projectPath = path.join(projectDir, PROJECT_DIR, "dag-prompts", `${id}.md`)
    // Same GRAPHAGENT_CONFIG_DIR redirect the Global service applies (siblings:
    // dag/workflows.ts, dag/config.ts) so redirected setups resolve their
    // globally installed prompts.
    const globalPath = path.join(Flag.GRAPHAGENT_CONFIG_DIR ?? Global.Path.config, "dag-prompts", `${id}.md`)

    // Try project first (overrides global), then global. A missing asset is a
    // typed failure, not a defect: the spawn path fails the node through
    // Effect.catch, which never sees the defect channel.
    return yield* Effect.tryPromise({
      try: () => fs.readFile(projectPath, "utf-8").catch(() => fs.readFile(globalPath, "utf-8")),
      catch: () => new Error(`Template not found: ${id} (checked project and global dirs)`),
    })
  })
}

function interpolate(template: string, input: Record<string, unknown>) {
  const unresolvedPlaceholders: string[] = []
  const text = template.replace(INTERPOLATION_RE, (match, key: string) => {
    const value = input[key]
    if (value !== null && value !== undefined) {
      if (typeof value === "object") return JSON.stringify(value, null, 2)
      if (typeof value === "symbol") return value.description ?? ""
      if (typeof value === "function") return value.name
      return value.toString()
    }
    unresolvedPlaceholders.push(key)
    return match
  })
  return { text, unresolvedPlaceholders }
}
