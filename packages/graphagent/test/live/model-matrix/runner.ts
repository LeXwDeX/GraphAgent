// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs one scenario on a host (Issue #1474): builds its workspace, sends its prompt through the real HTTP API,
 * waits for the session to go idle and reads back what happened as a `RunView` for the scenario's judge. Both
 * tiers use it; the replay tier only differs in whom the host's model requests reach.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { isRecord } from "../delegation-timing/classify"
import {
  client,
  gitRunner,
  readMessages,
  sessionPermission,
  settle,
  type Host,
  type MessageView,
  type ModelRef,
  type PartView,
} from "../delegation-timing/harness"
import type { ScriptServer } from "../lib/script-server"
import type { Call, RunView, Scenario, Script, ScriptFamily } from "./types"

/** Characters of each workspace file a `RunView` keeps. */
const FILE_CAP = 20_000

type ModelPick = Pick<ModelRef, "providerID" | "modelID">

/** The replay tier's models: `gpt-` in the ID makes the runtime offer apply_patch instead of edit and write. */
export const REPLAY_MODELS: Readonly<Record<ScriptFamily, ModelPick>> = {
  default: { providerID: "script", modelID: "scripted" },
  apply_patch: { providerID: "script", modelID: "gpt-scripted" },
}

export interface MatrixContext {
  /** `replay`: the script server answers, as `REPLAY_MODELS` says. `live`: `model` answers. */
  readonly mode: "replay" | "live"
  readonly host: Host
  readonly script: ScriptServer
  /** The host's temporary home; the model may read the truncated tool output kept there. */
  readonly home: string
  /** The directory the workspaces are made in. */
  readonly work: string
  /** The model under test in the live tier. */
  readonly model: ModelPick
  readonly timeoutMs: number
  /** Cleans a text of credentials, foreign URLs and local paths before it is kept. */
  readonly redact: (value: string) => string
}

export interface RunResult {
  /** `pass`: the judge was satisfied. `fail`: it was not. `error`: the run produced no verdict. */
  readonly status: "pass" | "fail" | "error"
  /** The criteria not met (`fail`), or why the run is an `error`. */
  readonly failures: readonly string[]
  /** What the judge saw; absent when the run broke before the session could be read. */
  readonly view?: RunView
  /** Input, output and reasoning tokens of all assistant messages. */
  readonly tokens: number
  readonly durationMs: number
  readonly attempts: number
}

/** The marker key of a script: the scenario id, and `<id>:apply_patch` for the apply_patch family. */
export const caseKey = (id: string, family: ScriptFamily): string => (family === "default" ? id : `${id}:${family}`)

/** The script a scenario has for a family. */
export function scriptOf(scenario: Scenario, family: ScriptFamily): Script {
  const script = family === "default" ? scenario.scripts.default : scenario.scripts.apply_patch
  if (!script) throw new Error(`scenario ${scenario.id} has no ${family} script`)
  return script
}

/** The families a scenario is replayed as: the default one, and apply_patch when it has a script for it. */
export function familiesOf(scenario: Scenario): ScriptFamily[] {
  return scenario.scripts.apply_patch ? ["default", "apply_patch"] : ["default"]
}

/** The longest paths first, so a path inside another is not half replaced. */
export function scrubber(places: ReadonlyArray<readonly [string, string]>, redact: (value: string) => string) {
  const longestFirst = places.filter(([place]) => place.length > 0).sort((a, b) => b[0].length - a[0].length)
  return (value: string): string =>
    redact(longestFirst.reduce((current, [place, label]) => current.replaceAll(place, label), value))
}

async function buildWorkspace(ctx: MatrixContext, scenario: Scenario): Promise<string> {
  const dir = await fs.mkdtemp(path.join(ctx.work, "w-"))
  for (const [file, content] of Object.entries(scenario.files)) {
    const target = path.join(dir, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  const git = gitRunner(ctx.home)
  await git(["init", "-q", "-b", "main"], dir)
  await git(["config", "commit.gpgsign", "false"], dir)
  await git(["config", "core.fsmonitor", "false"], dir)
  await git(["add", "-A"], dir)
  await git(["commit", "-q", "--allow-empty", "-m", "Initial import"], dir)
  return dir
}

/** Every file below `root` except `.git`, by `/`-separated path. */
async function readFiles(root: string, relative = ""): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) Object.assign(found, await readFiles(root, next))
    else if (entry.isFile()) found[next] = (await fs.readFile(path.join(root, next), "utf8")).slice(0, FILE_CAP)
  }
  return found
}

function callOf(part: PartView): Call {
  const done = part.status === "completed"
  const failed = part.status === "error"
  return {
    tool: part.tool ?? "",
    input: part.input ? { ...part.input } : {},
    status: done ? "completed" : "error",
    // A call that never finished was cut off by the run, which is what `aborted` says.
    outcome: part.outcome ?? "aborted",
    text: done
      ? (part.output ?? "")
      : failed
        ? (part.error ?? "")
        : `(the call did not finish: ${part.status ?? "unknown"})`,
  }
}

/** The calls of the assistant messages, in message order and in part order within a message. */
export function callsOf(messages: readonly MessageView[]): Call[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.flatMap((part): Call[] => (part.type === "tool" && part.tool ? [callOf(part)] : []))
      : [],
  )
}

/** The last non-synthetic text of an assistant message. */
export function lastReply(messages: readonly MessageView[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue
    const reply = message.parts.findLast((part) => part.type === "text" && !part.synthetic)?.text
    if (reply) return reply
  }
  return ""
}

export function tokensOf(messages: readonly MessageView[]): number {
  return messages.reduce(
    (sum, message) =>
      message.role === "assistant"
        ? sum + message.tokens.input + message.tokens.output + message.tokens.reasoning
        : sum,
    0,
  )
}

function todosOf(value: unknown): RunView["todos"] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    isRecord(item) && typeof item.content === "string" && typeof item.status === "string"
      ? [{ content: item.content, status: item.status }]
      : [],
  )
}

async function viewOf(
  api: ReturnType<typeof client>,
  dir: string,
  sessionID: string,
  messages: readonly MessageView[],
): Promise<RunView> {
  const [todos, children] = await Promise.all([
    api(`/session/${sessionID}/todo`),
    api(`/session/${sessionID}/children`),
  ])
  return {
    files: await readFiles(dir),
    calls: callsOf(messages),
    reply: lastReply(messages),
    todos: todosOf(todos),
    children: Array.isArray(children) ? children.length : 0,
  }
}

async function attempt(
  ctx: MatrixContext,
  scenario: Scenario,
  family: ScriptFamily,
  number: number,
): Promise<RunResult> {
  const started = Date.now()
  const done = (result: Omit<RunResult, "durationMs" | "attempts">): RunResult => ({
    ...result,
    durationMs: Date.now() - started,
    attempts: number,
  })
  try {
    const key = caseKey(scenario.id, family)
    const replay = ctx.mode === "replay"
    if (replay) ctx.script.register(key, scriptOf(scenario, family).replies)
    const model = replay ? REPLAY_MODELS[family] : ctx.model
    const dir = await buildWorkspace(ctx, scenario)
    const api = client(ctx.host, dir)
    const session = await api("/session", { body: { title: scenario.id, permission: sessionPermission(ctx.home) } })
    const sessionID = isRecord(session) && typeof session.id === "string" ? session.id : undefined
    if (!sessionID) throw new Error("the session was not created")
    const text = replay ? `${scenario.prompt}\n[case ${key}]` : scenario.prompt
    await api(`/session/${sessionID}/message`, {
      body: { model: { providerID: model.providerID, modelID: model.modelID }, parts: [{ type: "text", text }] },
      timeoutMs: ctx.timeoutMs,
    })
    await settle(api, sessionID, ctx.timeoutMs)
    const messages = readMessages(await api(`/session/${sessionID}/message`))
    const view = await viewOf(api, dir, sessionID, messages)
    const tokens = tokensOf(messages)
    const failure = messages.find((message) => message.error)?.error
    if (failure) return done({ status: "error", failures: [ctx.redact(failure)], view, tokens })
    const failures = scenario.judge(view)
    return done({ status: failures.length === 0 ? "pass" : "fail", failures, view, tokens })
  } catch (error) {
    const detail = ctx.redact(error instanceof Error ? error.message : "unknown failure")
    return done({ status: "error", failures: [detail], tokens: 0 })
  }
}

/** Runs a scenario; a run that is an `error` (not one the model failed) is tried once more. */
export async function runScenario(ctx: MatrixContext, scenario: Scenario, family: ScriptFamily): Promise<RunResult> {
  const first = await attempt(ctx, scenario, family, 1)
  return first.status === "error" ? attempt(ctx, scenario, family, 2) : first
}
