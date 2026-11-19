// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The replay tier of the model matrix (Issue #1474). Every scenario runs through the real session runtime, the
 * real HTTP API and the real tools; only the model is scripted. So what a tool returns to a model, which is
 * what the scenarios' `trap` and `contract` check, is tested without a model and without a credential, and the
 * scenarios themselves are proven playable before anyone spends a live call on them.
 *
 * One host serves all scenarios, `CONCURRENCY` at a time. No model, network or user configuration is involved:
 * the host starts from an allow-listed environment and a configuration made here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pool, seedHome, startHost, stopAllHosts, type Host } from "../delegation-timing/harness"
import { startScriptServer, type ScriptServer } from "../lib/script-server"
import { matrixHostConfig, matrixHostEnv, replayOrigin } from "./host-config"
import { scriptFailures } from "./judge"
import {
  caseKey,
  familiesOf,
  REPLAY_MODELS,
  runScenario,
  scrubber,
  scriptOf,
  type MatrixContext,
  type RunResult,
} from "./runner"
import { SCENARIOS } from "./scenarios"
import { CONCURRENCY, TURN_TIMEOUT_MS } from "./types"

const results = new Map<string, RunResult>()
let root = ""
let script: ScriptServer | undefined
let host: Host | undefined

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gm-")))
  const home = path.join(root, "home")
  const work = path.join(root, "w")
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(work, { recursive: true })])
  await seedHome(home)
  script = startScriptServer()
  const config = matrixHostConfig({
    origin: replayOrigin(script.baseURL),
    model: REPLAY_MODELS.default,
    scriptURL: script.baseURL,
    home,
  })
  host = await startHost({ env: matrixHostEnv({ home, config, passthrough: {} }), cwd: home })
  const ctx: MatrixContext = {
    mode: "replay",
    host,
    script,
    home,
    work,
    model: REPLAY_MODELS.default,
    timeoutMs: TURN_TIMEOUT_MS,
    redact: scrubber(
      [
        [work, "<work>"],
        [home, "<home>"],
      ],
      (value) => value,
    ),
  }
  const runs = SCENARIOS.flatMap((scenario) => familiesOf(scenario).map((family) => ({ scenario, family })))
  await pool(runs, CONCURRENCY, async ({ scenario, family }) => {
    results.set(caseKey(scenario.id, family), await runScenario(ctx, scenario, family))
  })
}, 600_000)

afterAll(async () => {
  await stopAllHosts()
  script?.stop()
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe("replay of the scenarios", () => {
  for (const scenario of SCENARIOS) {
    for (const family of familiesOf(scenario)) {
      test(`${scenario.id} [${family}]`, () => {
        const result = results.get(caseKey(scenario.id, family))
        if (!result) throw new Error(`${scenario.id} [${family}] did not run`)
        if (result.status === "error") throw new Error(`run error: ${result.failures.join("; ")}`)
        // The judge: what the run achieved.
        expect(result.failures).toEqual([])
        // The trap and the contract: what the tools said on the way.
        const broken = scriptFailures(scenario.id, family, scriptOf(scenario, family), result.view?.calls ?? [])
        if (broken.length > 0) throw new Error(broken.join("\n"))
      })
    }
  }
})
