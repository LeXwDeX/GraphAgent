// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DAG defaults config — `dag.jsonc` beside the opencode config.
 *
 * Two-tier default working models plus a thinking-depth variant for DAG child
 * sessions. Everything else inherits the main opencode configuration.
 *
 * Lookup order (first existing file wins, project overrides global):
 * - project: `.opencode/dag.jsonc` / `.opencode/dag.json`
 * - global:  `<config dir>/dag.jsonc` / `<config dir>/dag.json`
 *
 * When neither exists, a commented default `dag.jsonc` is seeded into the
 * global opencode config directory (same generation pattern as the main
 * config's loadGlobal) — but only when the caller opts in via `autoSeed`;
 * the spawn-scheduling read path never writes. Files are read lazily at
 * spawn-scheduling time — like
 * templates/resolve.ts, nothing is loaded at startup, and edits take effect on
 * the next scheduling round.
 */

export * as DagConfig from "./config"

import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isReviewWorker } from "./review-lifecycle"

export const Info = Schema.Struct({
  model: Schema.optional(
    Schema.Struct({
      advanced: Schema.optional(Schema.String),
      standard: Schema.optional(Schema.String),
    }),
  ),
  thinking_depth: Schema.optional(Schema.Literals(["low", "medium", "high", "max"])),
})
export type Info = typeof Info.Type

const DEFAULT_CONTENT = `{
  // DAG workflow defaults — applies to every DAG child session.
  // Model resolution per node: persisted legacy node model
  //   → this file's tier → worker agent model → parent session model.
  // Format: "provider/model", e.g. "anthropic/claude-sonnet-4-5".
  "model": {
    // Advanced tier — critical nodes: required: true and review/arbiter workers.
    // "advanced": "",
    // Standard tier — every other worker node. With only one tier configured,
    // it serves as the unified default for all nodes.
    // "standard": ""
  },
  // Reasoning variant for DAG child sessions: "low" | "medium" | "high" | "max".
  // Applied only when the resolved model defines a variant with this name;
  // otherwise it is a no-op.
  // "thinking_depth": "medium"
}
`

export function load(projectDir: string, options: { autoSeed?: boolean } = {}): Effect.Effect<Info> {
  return Effect.gen(function* () {
    const found = yield* Effect.promise(() => readFirst(candidates(projectDir)))
    if (!found) {
      // Seeding writes to the user's global config dir — opt-in so read paths
      // (spawn scheduling) stay side-effect free. EEXIST is the benign
      // seed race; anything else (EACCES/EROFS/…) is logged, never thrown.
      if (options.autoSeed) {
        const seedError = yield* Effect.promise(() => seedGlobalDefault())
        if (seedError) {
          yield* Effect.logWarning("failed to seed global dag.jsonc", {
            dir: globalConfigDir(),
            code: seedError.code ?? String(seedError),
          })
        }
      }
      return {}
    }
    const decoded = Schema.decodeUnknownOption(Info)(parseJsonc(found.text, [], { allowTrailingComma: true }) ?? {})
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("dag config is invalid — ignoring", { path: found.path })
      return {}
    }
    return decoded.value
  })
}

/**
 * Resolve the configured default model for a node. Critical nodes
 * (required: true or review workers) take the advanced tier; everything else
 * takes standard. A single configured tier acts as the unified default.
 * Fallback runs on the parsed refs: an empty or malformed tier (e.g. the
 * seeded `"advanced": ""` uncommented) counts as unconfigured.
 */
export function tierModel(info: Info, node: { required: boolean; workerType: string }) {
  const critical = node.required || isReviewWorker(node.workerType)
  const advanced = parseModelRef(info.model?.advanced)
  const standard = parseModelRef(info.model?.standard)
  return critical ? (advanced ?? standard) : (standard ?? advanced)
}

function candidates(projectDir: string) {
  const globalDir = globalConfigDir()
  return [
    path.join(projectDir, ".opencode", "dag.jsonc"),
    path.join(projectDir, ".opencode", "dag.json"),
    path.join(globalDir, "dag.jsonc"),
    path.join(globalDir, "dag.json"),
  ]
}

// Same redirect the Global service applies in make(), so tests and managed
// setups that point GRAPHAGENT_CONFIG_DIR elsewhere are honored here too.
function globalConfigDir() {
  return Flag.GRAPHAGENT_CONFIG_DIR ?? Global.Path.config
}

async function readFirst(paths: string[]) {
  for (const file of paths) {
    try {
      return { path: file, text: await fs.readFile(file, "utf-8") }
    } catch {
      continue
    }
  }
  return undefined
}

async function seedGlobalDefault(): Promise<NodeJS.ErrnoException | undefined> {
  const file = path.join(globalConfigDir(), "dag.jsonc")
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    // wx: never clobber a file that appeared between the read and the seed.
    await fs.writeFile(file, DEFAULT_CONTENT, { flag: "wx" })
    return undefined
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    // EEXIST is the expected outcome of the read-then-seed race.
    if (error.code === "EEXIST") return undefined
    return error
  }
}

function parseModelRef(ref: string | undefined) {
  if (!ref) return undefined
  const slash = ref.indexOf("/")
  if (slash < 0) return undefined
  // Whitespace-only components (e.g. " / ") count as unconfigured.
  const providerID = ref.slice(0, slash).trim()
  const modelID = ref.slice(slash + 1).trim()
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}
