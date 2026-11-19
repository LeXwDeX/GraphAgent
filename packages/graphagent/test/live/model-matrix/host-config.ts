// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The host configuration of the model matrix (Issue #1474). It builds on the delegation-timing host: the same
 * allow-listed environment, temporary home and external-directory denial for the file tools. On top of it the
 * matrix adds the scripted provider the replay tier talks to, makes the model under test the small model (it
 * writes the titles and the compaction summaries), and fixes the compaction settings so a summary is always cut
 * from the whole history.
 *
 * Unlike the delegation-timing host it installs no PreToolUse hook (`seedHome` without an audit file): every
 * tool call runs, the shell included, because the matrix is about what the tools answer. A live model's shell
 * command therefore runs unconfined in the temporary workspace; only the file tools are held to it. The case
 * replay (`case-run.ts`) is the exception: it builds a home of its own whose hook stops every tool call.
 */

import { hostConfig, hostEnv, type ModelRef, type OriginConfig } from "../delegation-timing/harness"
import { STEPS } from "./types"

type ModelPick = Pick<ModelRef, "providerID" | "modelID">

/** The scripted provider: two model IDs, so the replay tier can be run as an edit/write model and an apply_patch one. */
export function scriptProvider(scriptURL: string): Record<string, unknown> {
  const model = (id: string) => ({
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: "2025-01-01",
    limit: { context: 100_000, output: 10_000 },
    cost: { input: 0, output: 0 },
    options: {},
  })
  return {
    name: "Scripted replay",
    id: "script",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    // `gpt-` in the id puts the model on the apply_patch edit tools; the plain one gets edit and write.
    models: { scripted: model("scripted"), "gpt-scripted": model("gpt-scripted") },
    options: { apiKey: "script-key", baseURL: scriptURL },
  }
}

/** The origin of a replay run: the scripted provider alone, no developer configuration. */
export function replayOrigin(scriptURL: string): OriginConfig {
  return { providers: { script: scriptProvider(scriptURL) } }
}

export function matrixHostConfig(input: {
  readonly origin: OriginConfig
  readonly model: ModelPick
  readonly scriptURL: string
  readonly home: string
}): Record<string, unknown> {
  const base = hostConfig({
    origin: input.origin,
    model: input.model,
    stubURL: input.scriptURL,
    stepCap: STEPS,
    home: input.home,
  })
  const providers = typeof base.provider === "object" && base.provider !== null ? base.provider : {}
  return {
    ...base,
    provider: { ...providers, script: scriptProvider(input.scriptURL) },
    small_model: `${input.model.providerID}/${input.model.modelID}`,
    // `small` writes the summary with the small model, and 0 tail turns puts the whole history into it.
    compaction: { auto: false, tail_turns: 0, mode: "small" },
  }
}

/**
 * The environment of a matrix host: the delegation-timing allow-list, and the settings that say where ripgrep
 * is. `glob` and `grep` need it, and without these a host that finds no `rg` on `PATH` downloads one.
 */
export function matrixHostEnv(input: {
  readonly home: string
  readonly config: Record<string, unknown>
  readonly passthrough: Readonly<Record<string, string>>
}): Record<string, string> {
  const env = hostEnv(input)
  for (const name of ["GRAPHAGENT_RUNTIME_ASSET_CACHE", "GRAPHAGENT_RUNTIME_ASSETS_DIR"]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}
