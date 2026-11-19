// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The live replay of a case (Issue #1474), `eval:models --case`: asks the model under test the step a recorded
 * session once asked another model, and judges only what it decides to do (`case-judge.ts`).
 *
 * Every run has a host and a database of its own, so no run can see another's session:
 *
 * 1. an empty git workspace, and a home whose one hook is `case-hook.ts`, which stops every tool call before it
 *    runs and writes the first one to an audit file;
 * 2. the case's session is imported into the run's database with the CLI (`graphagent import`), from the workspace,
 *    so the session belongs to the workspace's project and directory. Its permission rules are replaced by the ones
 *    every matrix session has, which keep the file tools inside the workspace;
 * 3. a host starts on that database, and the case's `request` is sent to the imported session.
 *
 * What the judge sees is the audit's first call and the messages the run added after the imported ones.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  client,
  pool,
  providerEnv,
  readMessages,
  seedHome,
  sessionPermission,
  settle,
  startHost,
  type Host,
  type MessageView,
  type ModelRef,
  type OriginConfig,
} from "../delegation-timing/harness"
import type { ScriptServer } from "../lib/script-server"
import type { CaseFile } from "./case-file"
import { firstStoppedCall } from "./case-hook"
import { caseFailures } from "./case-judge"
import { matrixHostConfig, matrixHostEnv } from "./host-config"
import { cellOf, profileFrom, recordOf, type Cell, type Profile } from "./report"
import { callsOf, initRepository, lastReply, scrubber, tokensOf, withRetry, type RunResult } from "./runner"
import { CONCURRENCY, RUNS_PER_CELL, TURN_TIMEOUT_MS, type RunView } from "./types"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../..")
const CLI_ENTRY = path.join(PACKAGE_ROOT, "src", "index.ts")
const HOOK_ENTRY = path.join(import.meta.dir, "case-hook.ts")
const IMPORT_TIMEOUT_MS = 120_000

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * The home of a case-replay host: the quiet user config of `seedHome` and `case-hook.ts` as its one PreToolUse
 * hook, writing to `auditFile`. The `hooks.json` has the shape `seedHome` writes for the delegation-timing host.
 */
export async function seedCaseHome(home: string, auditFile: string): Promise<void> {
  await seedHome(home)
  const command = [process.execPath, HOOK_ENTRY, auditFile].map(shellQuote).join(" ")
  await fs.writeFile(
    path.join(home, ".config", "graphagent", "hooks.json"),
    JSON.stringify({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] }),
  )
}

/** Imports a session file into the database of `env`, as the project of the directory `work`. */
async function importSession(env: Record<string, string>, work: string, file: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", CLI_ENTRY, "import", file], {
    cwd: work,
    env: { ...env, PWD: work },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), IMPORT_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0)
      throw new Error(`importing the session failed (exit code ${code}): ${(stderr || stdout).slice(-600)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** What every run of one model shares. */
export interface CaseJob {
  readonly origin: OriginConfig
  readonly model: ModelRef
  readonly file: CaseFile
  readonly script: ScriptServer
  /** The variables the provider block names, from this process. */
  readonly passthrough: Readonly<Record<string, string>>
  /** Cleans a text of credentials, foreign URLs and local paths before it is kept. */
  readonly redact: (value: string) => string
  readonly timeoutMs: number
}

interface Place {
  readonly home: string
  readonly work: string
  readonly audit: string
  readonly env: Record<string, string>
}

/** The workspace, the home with the hook, and the case's session imported into the database of this run. */
async function prepare(job: CaseJob, root: string): Promise<Place> {
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  const audit = path.join(root, "audit.jsonl")
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(work, { recursive: true })])
  await seedCaseHome(home, audit)
  await initRepository(work, home)
  const config = matrixHostConfig({ origin: job.origin, model: job.model, scriptURL: job.script.baseURL, home })
  const env = matrixHostEnv({ home, config, passthrough: job.passthrough })
  const { info, messages } = job.file.session
  const sessionFile = path.join(root, "session.json")
  const session = JSON.stringify({ info: { ...info, permission: sessionPermission(home) }, messages })
  await fs.writeFile(sessionFile, session, { mode: 0o600 })
  await importSession(env, work, sessionFile)
  return { home, work, audit, env }
}

/** The messages a run added to the imported session; the imported ones, errors and replies included, are not its. */
function freshMessages(job: CaseJob, messages: readonly MessageView[]): MessageView[] {
  const imported = new Set(job.file.session.messages.map((message) => message.info.id))
  return messages.filter((message) => !imported.has(message.id))
}

/** The ids of the calls the messages hold, in the order the model made them. */
function callIDsOf(messages: readonly MessageView[]): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.flatMap((part) => (part.type === "tool" && part.callID ? [part.callID] : []))
      : [],
  )
}

type Outcome = Pick<RunResult, "status" | "failures" | "view" | "tokens">

interface Asked {
  readonly outcome: Outcome
  readonly profile: Profile | null
}

/** Sends the request to the imported session, waits for the turn, and judges what the model decided. */
async function ask(job: CaseJob, place: Place, host: Host): Promise<Asked> {
  const api = client(host, place.work)
  const sessionID = job.file.session.info.id
  const { providerID, modelID } = job.model
  await api(`/session/${sessionID}/message`, {
    body: { model: { providerID, modelID }, parts: [{ type: "text", text: job.file.request }] },
    timeoutMs: job.timeoutMs,
  })
  await settle(api, sessionID, job.timeoutMs)
  const fresh = freshMessages(job, readMessages(await api(`/session/${sessionID}/message`)))
  const calls = callsOf(fresh)
  const reply = lastReply(fresh)
  const view: RunView = { files: {}, calls, reply, todos: [], children: 0 }
  const tokens = tokensOf(fresh)
  const profile = profileFrom(await api("/provider").catch(() => undefined), providerID, modelID)
  const broken = fresh.find((message) => message.error)?.error
  if (broken) return { outcome: { status: "error", failures: [broken], view, tokens }, profile }
  const stopped = firstStoppedCall(await fs.readFile(place.audit, "utf8").catch(() => ""), callIDsOf(fresh))
  const failures = caseFailures(job.file, { ...(stopped ? { stopped } : {}), calls, reply })
  return { outcome: { status: failures.length === 0 ? "pass" : "fail", failures, view, tokens }, profile }
}

/** One attempt: its own directory and host, both gone afterwards. A run that breaks before a verdict is an `error`. */
export async function attemptCase(
  job: CaseJob,
  number: number,
): Promise<{ result: RunResult; profile: Profile | null }> {
  const started = Date.now()
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gc-")))
  let host: Host | undefined
  try {
    const place = await prepare(job, root)
    host = await startHost({ env: place.env, cwd: place.home })
    const { outcome, profile } = await ask(job, place, host)
    const failures = outcome.failures.map(job.redact)
    return { result: { ...outcome, failures, durationMs: Date.now() - started, attempts: number }, profile }
  } catch (error) {
    const detail = job.redact(error instanceof Error ? error.message : "unknown failure")
    const result: RunResult = {
      status: "error",
      failures: [detail],
      tokens: 0,
      durationMs: Date.now() - started,
      attempts: number,
    }
    return { result, profile: null }
  } finally {
    await host?.stop()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

export interface CaseModelRun {
  readonly cells: readonly Cell[]
  readonly profile: Profile | null
}

/**
 * The cell of a model for one case: `RUNS_PER_CELL` runs, `CONCURRENCY` at a time, each on a host of its own.
 * `onRun` is called with each finished run (the caller writes the transcript) and a function that cleans a text.
 */
export async function runCaseModel(input: {
  readonly origin: OriginConfig
  readonly model: ModelRef
  readonly file: CaseFile
  /** The scenario label of the cell. */
  readonly scenario: string
  readonly script: ScriptServer
  readonly log: (line: string) => void
  readonly onRun: (done: { run: number; result: RunResult; redact: (value: string) => string }) => Promise<void>
}): Promise<CaseModelRun> {
  const { model, scenario } = input
  const label = `${model.providerID}/${model.modelID}`
  const { passthrough, redact: secrets } = providerEnv(input.origin, model)
  const redact = scrubber(
    [
      [os.tmpdir(), "<tmp>"],
      [await fs.realpath(os.tmpdir()), "<tmp>"],
      [os.homedir(), "<user-home>"],
    ],
    secrets,
  )
  const job: CaseJob = {
    origin: input.origin,
    model,
    file: input.file,
    script: input.script,
    passthrough,
    redact,
    timeoutMs: TURN_TIMEOUT_MS,
  }
  let profile: Profile | null = null
  const runs = Array.from({ length: RUNS_PER_CELL }, (_, index) => index + 1)
  const results = await pool(runs, CONCURRENCY, async (run) => {
    const result = await withRetry(async (number) => {
      const attempt = await attemptCase(job, number)
      profile ??= attempt.profile
      return attempt.result
    })
    const why = result.failures.length > 0 ? ` (${result.failures.join("; ")})` : ""
    input.log(`  ${label} ${scenario} run ${run}: ${result.status}${why}`)
    await input.onRun({ run, result, redact })
    return result
  })
  const records = results.map((result) => {
    const record = recordOf(result)
    return { ...record, failures: record.failures.map(redact) }
  })
  return { cells: [cellOf(label, scenario, records)], profile }
}
