// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The live tier of the model consistency matrix (Issue #1474): runs the scenarios against the QWEN, GLM and
 * DeepSeek models of the developer's own configuration and writes a matrix of what each model managed.
 *
 * It is a script, not a test file: `bun test` never runs it, and it does not load the package's test preload,
 * which clears the credential variables a provider block may name with `{env:NAME}`. Run it by hand from
 * `packages/graphagent`; it is never part of CI:
 *
 *   GRAPHAGENT_LIVE_EVAL_CONFIG=<path to graphagent.json> bun run eval:models --model <provider/model> [options]
 *
 * Options:
 *
 * - `--model <provider/model>`  a configured QWEN, GLM or DeepSeek model; repeat for several (required)
 * - `--scenario <id>`           run only this scenario; repeat for several (default: all)
 * - `--case <file>`             replay a case file made by `eval:case` instead of the scenarios: the model is asked
 *                               the step the recorded session once asked another model, every tool call it makes
 *                               is stopped before it runs, and the first one is judged (see `case-run.ts`). It
 *                               cannot be combined with `--scenario`.
 * - `--out <dir>`               where `results.json`, `report.md` and `transcripts/` go (default: a new directory
 *                               in the OS temporary directory; one inside this repository is refused)
 * - `--baseline <results.json>` an earlier `results.json`; a cell that passed there and does not now is a regression
 *
 * Each cell runs `RUNS_PER_CELL` times and passes when at least `PASS_MIN` runs do. Token use is shown in the
 * report and never capped; the run asks for no confirmation and only prints the counts it is about to run.
 * Exit code: 0 when nothing regressed and no cell broke, 1 with a regression or an `error` cell, 2 for a usage
 * error (the message lists the configured models that may be asked).
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  client,
  discoverModels,
  parseOriginConfig,
  pool,
  providerEnv,
  resolveFileReferences,
  seedHome,
  startHost,
  stopAllHosts,
  type Host,
  type ModelRef,
  type OriginConfig,
} from "../delegation-timing/harness"
import { startScriptServer, type ScriptServer } from "../lib/script-server"
import { caseName, loadCaseFile, type CaseFile } from "./case-file"
import { runCaseModel } from "./case-run"
import { insideRepo, readFlags, REPO_ROOT, resolvesIntoRepo } from "./cli"
import { matrixHostConfig, matrixHostEnv } from "./host-config"
import {
  buildReport,
  cellOf,
  parseBaseline,
  profileFrom,
  recordOf,
  renderMarkdown,
  type Cell,
  type Profile,
  type Report,
  type RunRecord,
  type Verdict,
} from "./report"
import { redactDeep, runScenario, scrubber, type MatrixContext, type RunResult } from "./runner"
import { SCENARIOS } from "./scenarios"
import { CONCURRENCY, PASS_MIN, RUNS_PER_CELL, STEPS, TURN_TIMEOUT_MS, type Scenario } from "./types"

export { insideRepo }

export const CONFIG_ENV = "GRAPHAGENT_LIVE_EVAL_CONFIG"

export interface Options {
  readonly configFile: string
  readonly models: readonly ModelRef[]
  /** Scenario ids; every scenario when none was asked for. */
  readonly scenarios: readonly string[]
  /** A case file to replay instead of the scenarios. */
  readonly caseFile?: string
  readonly out?: string
  readonly baseline?: string
}

export type Parsed = { readonly ok: true; readonly options: Options } | { readonly ok: false; readonly error: string }

const usageError = (error: string): Parsed => ({ ok: false, error })

const FLAGS = ["--model", "--scenario", "--case", "--out", "--baseline"]

/**
 * The command line, or why it is wrong. `configured` are the QWEN, GLM and DeepSeek models of the configuration
 * (`discoverModels`), the only ones `--model` may name. Nothing is read from the file system here.
 */
export function parseOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  configured: readonly ModelRef[],
  repoRoot: string = REPO_ROOT,
): Parsed {
  const configFile = env[CONFIG_ENV]
  if (!configFile) return usageError(`${CONFIG_ENV} must name the graphagent.json(c) to read the providers from`)
  const flags = readFlags(argv, FLAGS)
  if (!flags.ok) return usageError(flags.error)
  const given = flags.value
  const wanted = [...new Set(given["--model"])]
  if (wanted.length === 0)
    return usageError("--model is required: name at least one configured model as provider/model")
  const models: ModelRef[] = []
  for (const entry of wanted) {
    const found = configured.find((model) => `${model.providerID}/${model.modelID}` === entry)
    if (!found) return usageError(`model ${entry} is not a configured QWEN, GLM or DeepSeek model`)
    models.push(found)
  }
  const cases = given["--case"] ?? []
  if (cases.length > 1) return usageError("--case may be given once")
  if (cases.length > 0 && (given["--scenario"] ?? []).length > 0) {
    return usageError("--case and --scenario cannot be used together")
  }
  const known = new Set(SCENARIOS.map((scenario) => scenario.id))
  const unknown = (given["--scenario"] ?? []).filter((id) => !known.has(id))
  if (unknown.length > 0) return usageError(`unknown scenario ids: ${unknown.join(", ")}`)
  const outs = given["--out"] ?? []
  if (outs.length > 1) return usageError("--out may be given once")
  const out = outs[0] === undefined ? undefined : path.resolve(outs[0])
  if (out !== undefined && insideRepo(out, repoRoot)) {
    return usageError("--out is inside this repository; results and transcripts must not be committed")
  }
  const baselines = given["--baseline"] ?? []
  if (baselines.length > 1) return usageError("--baseline may be given once")
  return {
    ok: true,
    options: {
      configFile,
      models,
      scenarios: [...new Set(given["--scenario"])],
      ...(cases[0] === undefined ? {} : { caseFile: path.resolve(cases[0]) }),
      ...(out === undefined ? {} : { out }),
      ...(baselines[0] === undefined ? {} : { baseline: path.resolve(baselines[0]) }),
    },
  }
}

/** 1 when something regressed or a cell broke before it had a verdict, else 0. */
export function exitCodeOf(report: Pick<Report, "cells" | "regressions">): number {
  return report.regressions.length > 0 || report.cells.some((cell) => cell.verdict === "error") ? 1 : 0
}

const modelId = (model: Pick<ModelRef, "providerID" | "modelID">) => `${model.providerID}/${model.modelID}`

/** The prefix of the directory made when `--out` is not given: a new one in the OS temporary directory. */
export const defaultOutPrefix = (): string => path.join(os.tmpdir(), "graphagent-model-matrix-")

const fileSafe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_")

interface ModelRun {
  readonly cells: readonly Cell[]
  readonly profile: Profile | null
}

/** The cells of a model whose host never ran: every run of every scenario is an `error` with the reason. */
export function brokenCells(label: string, scenarios: readonly Scenario[], failure: string): Cell[] {
  const run: RunRecord = {
    status: "error",
    failures: [failure],
    attempts: 1,
    durationMs: 0,
    tokens: 0,
    calls: 0,
    outcomes: {},
  }
  return scenarios.map((scenario) =>
    cellOf(
      label,
      scenario.id,
      Array.from({ length: RUNS_PER_CELL }, () => run),
    ),
  )
}

/** One host for a model; its scenarios run `RUNS_PER_CELL` times each, `CONCURRENCY` at a time. */
async function runModel(input: {
  readonly origin: OriginConfig
  readonly model: ModelRef
  readonly scenarios: readonly Scenario[]
  readonly script: ScriptServer
  readonly out: string
  readonly log: (line: string) => void
}): Promise<ModelRun> {
  const { origin, model, script } = input
  const label = modelId(model)
  const { passthrough, redact: secrets } = providerEnv(origin, model)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gm-")))
  const home = path.join(root, "home")
  const work = path.join(root, "w")
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(work, { recursive: true })])
  await seedHome(home)
  const redact = scrubber(
    [
      [work, "<work>"],
      [home, "<home>"],
      [os.tmpdir(), "<tmp>"],
      [await fs.realpath(os.tmpdir()), "<tmp>"],
      [os.homedir(), "<user-home>"],
    ],
    secrets,
  )
  const config = matrixHostConfig({ origin, model, scriptURL: script.baseURL, home })
  let host: Host | undefined
  try {
    try {
      host = await startHost({ env: matrixHostEnv({ home, config, passthrough }), cwd: home })
    } catch (error) {
      const failure = redact(error instanceof Error ? error.message : "the evaluation host failed to start")
      input.log(`  ${label}: ${failure}`)
      return { cells: brokenCells(label, input.scenarios, failure), profile: null }
    }
    const ctx: MatrixContext = { mode: "live", host, script, home, work, model, timeoutMs: TURN_TIMEOUT_MS, redact }
    const jobs = input.scenarios.flatMap((scenario) =>
      Array.from({ length: RUNS_PER_CELL }, (_, run) => ({ scenario, run: run + 1 })),
    )
    const results = await pool(jobs, CONCURRENCY, async (job) => {
      const result = await runScenario(ctx, job.scenario, "default")
      input.log(
        `  ${label} ${job.scenario.id} run ${job.run}: ${result.status}${result.failures.length > 0 ? ` (${result.failures.join("; ")})` : ""}`,
      )
      const file = `${fileSafe(model.providerID)}--${fileSafe(model.modelID)}--${job.scenario.id}--run${job.run}.json`
      const transcript = redactDeep({ model: label, scenario: job.scenario.id, run: job.run, ...result }, redact)
      await fs.writeFile(path.join(input.out, "transcripts", file), JSON.stringify(transcript, null, 2))
      return result
    })
    const profile = profileFrom(
      await client(host, work)("/provider").catch(() => undefined),
      model.providerID,
      model.modelID,
    )
    const record = (result: RunResult): RunRecord => {
      const base = recordOf(result)
      return { ...base, failures: base.failures.map(redact) }
    }
    // `pool` returns the results in the order of the jobs, so a cell's runs are in the order of their numbers.
    const cells = input.scenarios.map((scenario) =>
      cellOf(label, scenario.id, results.filter((_, index) => jobs[index]?.scenario === scenario).map(record)),
    )
    return { cells, profile }
  } finally {
    await host?.stop()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** The label of a case's cell in the matrix: the case file's name, made safe for a table cell. */
const caseLabel = (name: string) => `case:${fileSafe(name)}`

/** A model's replay of a case: the cell, and a transcript of every run (mode 0600, it holds what the model said). */
function runCase(input: {
  readonly origin: OriginConfig
  readonly model: ModelRef
  readonly replay: { readonly name: string; readonly file: CaseFile }
  readonly script: ScriptServer
  readonly out: string
  readonly log: (line: string) => void
}): Promise<ModelRun> {
  const { model, replay } = input
  const scenario = caseLabel(replay.name)
  return runCaseModel({
    origin: input.origin,
    model,
    file: replay.file,
    scenario,
    script: input.script,
    log: input.log,
    onRun: async ({ run, result, redact }) => {
      const file = `${fileSafe(model.providerID)}--${fileSafe(model.modelID)}--${fileSafe(scenario)}--run${run}.json`
      const transcript = redactDeep({ model: modelId(model), scenario, run, ...result }, redact)
      await fs.writeFile(path.join(input.out, "transcripts", file), JSON.stringify(transcript, null, 2), {
        mode: 0o600,
      })
    },
  })
}

async function readBaseline(file: string): Promise<ReadonlyMap<string, Verdict>> {
  const parsed = parseBaseline(JSON.parse(await fs.readFile(file, "utf8")))
  if (!parsed) throw new Error("not a results.json of this tool")
  return parsed
}

function listModels(configured: readonly ModelRef[]): string {
  const lines = configured.map((model) => `  ${modelId(model)}`)
  return ["configured QWEN, GLM and DeepSeek models:", ...(lines.length > 0 ? lines : ["  (none)"])].join("\n")
}

/** A usage error: the message and the models that may be asked for, on stderr; exit code 2. */
function usage(error: string, configured: readonly ModelRef[]): number {
  console.error(`eval:models: ${error}\n${listModels(configured)}`)
  return 2
}

async function loadOrigin(configFile: string | undefined): Promise<OriginConfig | undefined> {
  if (!configFile) return undefined
  return resolveFileReferences(parseOriginConfig(await fs.readFile(configFile, "utf8")), configFile)
}

async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      `usage: ${CONFIG_ENV}=<graphagent.json> bun run eval:models --model <provider/model> [--model ...] [--scenario <id> ... | --case <file>] [--out <dir>] [--baseline <results.json>]`,
    )
    return 0
  }
  let origin: OriginConfig | undefined
  try {
    origin = await loadOrigin(env[CONFIG_ENV])
  } catch (error) {
    return usage(`cannot read ${CONFIG_ENV}: ${error instanceof Error ? error.message : "unreadable"}`, [])
  }
  const configured = origin ? discoverModels(origin) : []
  const parsed = parseOptions(argv, env, configured)
  if (!parsed.ok) return usage(parsed.error, configured)
  if (!origin) return usage(`${CONFIG_ENV} is not set`, configured)
  const { options } = parsed
  let baseline: ReadonlyMap<string, Verdict> | undefined
  if (options.baseline) {
    try {
      baseline = await readBaseline(options.baseline)
    } catch (error) {
      return usage(`cannot use --baseline: ${error instanceof Error ? error.message : "unreadable"}`, configured)
    }
  }
  try {
    for (const model of options.models) providerEnv(origin, model)
  } catch (error) {
    return usage(error instanceof Error ? error.message : "a provider needs credentials", configured)
  }
  let replay: { readonly name: string; readonly file: CaseFile } | undefined
  if (options.caseFile) {
    const loaded = await loadCaseFile(options.caseFile)
    if (!loaded.ok) return usage(`cannot use --case: ${loaded.error}`, configured)
    replay = { name: caseName(options.caseFile), file: loaded.value }
  }
  const out = options.out ?? (await fs.mkdtemp(defaultOutPrefix()))
  if (await resolvesIntoRepo(out)) return usage("the output directory is inside this repository", configured)
  await fs.mkdir(path.join(out, "transcripts"), { recursive: true })
  const scenarios =
    options.scenarios.length > 0 ? SCENARIOS.filter((item) => options.scenarios.includes(item.id)) : SCENARIOS
  console.log(
    `models: ${options.models.length}, scenarios: ${replay ? 1 : scenarios.length}, runs per cell: ${RUNS_PER_CELL} (pass needs ${PASS_MIN}), steps: ${STEPS}`,
  )
  const script = startScriptServer()
  try {
    const cells: Cell[] = []
    const profiles: Record<string, Profile | null> = {}
    const log = (line: string) => console.log(line)
    for (const model of options.models) {
      const run = replay
        ? await runCase({ origin, model, replay, script, out, log })
        : await runModel({ origin, model, scenarios, script, out, log })
      cells.push(...run.cells)
      profiles[modelId(model)] = run.profile
    }
    const report = buildReport({ profiles, cells, ...(baseline ? { baseline } : {}) })
    const markdown = renderMarkdown(report)
    await fs.writeFile(path.join(out, "results.json"), JSON.stringify(report, null, 2))
    await fs.writeFile(path.join(out, "report.md"), markdown)
    console.log(markdown)
    console.log(`results: ${out}`)
    return exitCodeOf(report)
  } finally {
    script.stop()
    await stopAllHosts()
  }
}

if (import.meta.main) {
  const stop = () => void stopAllHosts().finally(() => process.exit(130))
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.exitCode = await main(process.argv.slice(2), process.env)
}
