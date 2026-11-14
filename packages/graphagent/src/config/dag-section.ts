// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-directory DAG settings — the runtime reader for `dag.model` tiers and
 * `thinking_depth`.
 *
 * Resolution is rooted like every other DAG asset (see `dag/paths.ts`): the
 * project layer is `<root>/.agents/settings.json` (then `settings.local.json`),
 * the user layer is `<config dir>/graphagent.json` / `.jsonc`. Project values
 * override user values field by field, and GRAPHAGENT_DISABLE_PROJECT_CONFIG
 * skips the project layer exactly as the main loader does. Text is expanded
 * with the same `ConfigVariable` substitution before decoding, so `{env:}`
 * tokens read the same here as they do through `Config.get()`. Reads are lazy
 * and side-effect free: nothing is seeded, and a missing or invalid file is
 * skipped (the latter with a warning).
 *
 * Boundary: only the user config directory's plain files are read here. The
 * other global layers — managed configuration, GRAPHAGENT_CONFIG,
 * GRAPHAGENT_CONFIG_CONTENT, and remote well-known config — are merged by
 * `Config.loadInstanceState`. GRAPHAGENT_CONFIG_DIR (and the test override)
 * still apply because they relocate `Global.Path.config` itself. The DAG
 * engine reads this section per execution directory, where a process-wide
 * configuration snapshot would not fit. `Config.dagSection` re-exports this
 * function for callers that already depend on the Config namespace.
 */

export * as DagSection from "./dag-section"

import { Effect, Option, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { mergeDeep } from "remeda"
import { CONFIG_BASENAME } from "@graphagent/core/brand"
import { ConfigVariable } from "@graphagent/core/config/variable"
import { Flag } from "@graphagent/core/flag/flag"
import { Global } from "@graphagent/core/global"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { ConfigPaths } from "@/config/paths"
import { DagPaths } from "@/dag/paths"
import { isRecord } from "@/util/record"

export type Dag = typeof ConfigV1.Dag.Type

/**
 * DAG settings for `directory`, with project values overriding user values.
 * Never writes; an unreadable or invalid layer contributes nothing.
 */
export const dagSection = Effect.fn("DagSection.dagSection")(function* (directory: string) {
  const user = yield* mergeFiles(userFiles())
  // The main loader treats this flag as "the project layer does not exist";
  // the per-directory DAG section obeys the same boundary.
  if (Flag.GRAPHAGENT_DISABLE_PROJECT_CONFIG) return user
  const root = DagPaths.projectLayer(directory)
  if (!root) return user
  const project = yield* mergeFiles(ConfigPaths.projectSettingsFiles(root))
  return mergeDeep(user, project) as Dag
})

/** Derived from Global.Path.config, so GRAPHAGENT_CONFIG_DIR and the test
 * override apply exactly as they do for the main config loader. */
function userFiles() {
  return [`${CONFIG_BASENAME}.json`, `${CONFIG_BASENAME}.jsonc`].map((file) => path.join(Global.Path.config, file))
}

const mergeFiles = Effect.fnUntraced(function* (files: string[]) {
  let merged: Dag = {}
  for (const file of files) {
    const next = yield* readSection(file)
    if (next) merged = mergeDeep(merged, next) as Dag
  }
  return merged
})

const readSection = Effect.fnUntraced(function* (file: string) {
  const text = yield* Effect.promise(() => fs.readFile(file, "utf-8").catch(() => undefined))
  if (text === undefined) return undefined
  // Same expansion as the main loader, so `Config.get()` and the DAG readers
  // never disagree about a substituted value. A broken `{file:}` reference is
  // an invalid layer: skip it with a warning like a schema failure.
  const expanded = yield* Effect.promise(() =>
    ConfigVariable.substitute({ text, type: "path", path: file }).catch(() => undefined),
  )
  if (expanded === undefined) {
    yield* Effect.logWarning("DAG settings are invalid — ignoring", { path: file })
    return undefined
  }
  const parsed = parseJsonc(expanded, [], { allowTrailingComma: true })
  if (!isRecord(parsed) || !Object.hasOwn(parsed, "dag")) return undefined
  const decoded = Schema.decodeUnknownOption(ConfigV1.Dag)(parsed.dag)
  if (Option.isNone(decoded)) {
    yield* Effect.logWarning("DAG settings are invalid — ignoring", { path: file })
    return undefined
  }
  return decoded.value
})