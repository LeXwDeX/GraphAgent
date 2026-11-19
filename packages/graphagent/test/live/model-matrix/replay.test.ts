// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The replay tier of the model matrix (Issue #1474). Every scenario runs through the real session runtime, the
 * real HTTP API and the real tools; only the model is scripted. So what a tool returns to a model, which is
 * what the scenarios' `trap` and `contract` check, is tested without a model and without a credential, and the
 * scenarios themselves are proven playable before anyone spends a live call on them.
 *
 * The hand-written cases in `cases/` are replayed the same way: the recorded reply is the whole script, only the
 * request is sent (the case's session is not imported and no case hook is installed), and the first call must
 * end in the state the case expects, or, for a recorded text, there must be no call.
 *
 * One host serves all scenarios and cases, `CONCURRENCY` at a time. No model, network or user configuration is
 * involved: the host starts from an allow-listed environment and a configuration made here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pool, seedHome, startHost, stopAllHosts, type Host } from "../delegation-timing/harness"
import { startScriptServer, type ScriptServer } from "../lib/script-server"
import { caseName, caseScenario, parseCaseFile } from "./case-file"
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
import { CONCURRENCY, TURN_TIMEOUT_MS, type Scenario, type ScriptFamily } from "./types"

const CASES_DIR = path.join(import.meta.dir, "cases")

/** The hand-written cases, each as the scenario that replays it, or the reason the file is not a case. */
const CASES: ReadonlyArray<{ readonly name: string; readonly scenario?: Scenario; readonly error?: string }> =
  readdirSync(CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = caseName(file)
      try {
        const parsed = parseCaseFile(JSON.parse(readFileSync(path.join(CASES_DIR, file), "utf8")))
        return parsed.ok ? { name, scenario: caseScenario(name, parsed.value) } : { name, error: parsed.error }
      } catch (error) {
        return { name, error: error instanceof Error ? error.message : "unreadable" }
      }
    })

const results = new Map<string, RunResult>()
let root = ""
let script: ScriptServer | undefined
let host: Host | undefined
let ctx: MatrixContext | undefined

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
  const replay: MatrixContext = {
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
  ctx = replay
  const runs = [
    ...SCENARIOS.flatMap((scenario) => familiesOf(scenario).map((family) => ({ scenario, family }))),
    ...CASES.flatMap(({ scenario }): Array<{ scenario: Scenario; family: ScriptFamily }> =>
      scenario ? [{ scenario, family: "default" }] : [],
    ),
  ]
  await pool(runs, CONCURRENCY, async ({ scenario, family }) => {
    results.set(caseKey(scenario.id, family), await runScenario(replay, scenario, family))
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

describe("replay of the cases", () => {
  for (const item of CASES) {
    test(item.name, () => {
      if (!item.scenario) throw new Error(`${item.name}.json is not a case file: ${item.error}`)
      const result = results.get(caseKey(item.scenario.id, "default"))
      if (!result) throw new Error(`${item.name} did not run`)
      if (result.status === "error") throw new Error(`run error: ${result.failures.join("; ")}`)
      expect(result.failures).toEqual([])
    })
  }
})

describe("a live compaction run", () => {
  test("is answered by the script for its setup turns only, and the summary comes from the model under test", async () => {
    const scenario = SCENARIOS.find((item) => item.id === "compaction.todo")
    if (!ctx || !scenario) throw new Error("the replay host did not start")
    // The script server stands in for the model under test here too. A live run registers the setup replies and
    // nothing more, so it has no summary to give and says `done`; the summary the replay run registered under the
    // same key before is gone, which is what the facts it lacks show.
    const result = await runScenario({ ...ctx, mode: "live", model: REPLAY_MODELS.apply_patch }, scenario, "default")
    expect(result.status).toBe("fail")
    expect(result.view?.summary).toBe("done")
    expect(result.failures).toEqual([
      'summary: missing "add retry to the uploader"',
      'summary: missing "write the migration notes"',
    ])
  })
})
