// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness of the delegation-timing evaluation (Issue #1057, plan 6): it drives
 * a real model through the real session runtime and records what the model
 * decides to delegate.
 *
 * Isolation. Every (model, round) pair gets its own host process, the same
 * test host the CLI process tests use (`test/lib/server-host.ts`), with a
 * temporary home, data directory, temp directory and database. The environment is built from
 * an allow-list, so nothing of the developer's own configuration or
 * credentials reaches the host except the variables the chosen provider block
 * names with `{env:NAME}`. The provider block is copied read-only from the
 * developer's existing config into the host's inline config; no endpoint or
 * key is ever written to a file, a log or the report, which name only
 * `provider/model`.
 *
 * Deciding a scenario. A user-level PreToolUse hook (`hook.ts`) lets the model
 * read the fixture copy and stops it at the first `task` call or the first
 * call that is not a plain read, before the call runs: no sub-agent starts and
 * no file changes. What the model did is read back from the session transcript.
 *
 * The `/review` scenarios use the real path end to end: the command starts a
 * background review whose model is a local stub, so its findings are fixed
 * text and cost nothing; the runtime's own result delivery then injects them
 * into the session and starts the main agent's turn, which is what is judged.
 */

import { ChildNotice } from "@/session/child/notice"
import { parse as parseJsonc } from "jsonc-parser"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  decide,
  describeCall,
  HARNESS_COMMAND,
  isRecord,
  judge,
  renderReport,
  type Decision,
  type RunRecord,
  type ToolCall,
} from "./classify"
import { SCENARIOS, expectationOf, type FileEdit, type Scenario } from "./scenarios"

const HERE = import.meta.dir
const FIXTURE = path.join(HERE, "fixtures", "pocketshop")
const HOST_ENTRY = path.join(HERE, "../../lib/server-host.ts")
const HOOK_ENTRY = path.join(HERE, "hook.ts")

export const DEFAULT_STEP_CAP = 8
const HOST_READY_MS = 60_000
const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" }]

export type Family = "qwen" | "glm" | "deepseek"

// The families the maintainers authorised for isolated acceptance calls.
const FAMILIES: ReadonlyArray<readonly [Family, RegExp]> = [
  ["qwen", /qwen/i],
  ["glm", /glm/i],
  ["deepseek", /deepseek/i],
]

export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
  readonly family: Family
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

// ---------------------------------------------------------------------------
// Configuration read from the developer's existing config
// ---------------------------------------------------------------------------

export interface OriginConfig {
  /** Provider id to its block, exactly as the developer wrote it. */
  readonly providers: Readonly<Record<string, Record<string, unknown>>>
}

export function parseOriginConfig(source: string): OriginConfig {
  const parsed: unknown = parseJsonc(source, [], { allowTrailingComma: true })
  const providers: Record<string, Record<string, unknown>> = {}
  if (isRecord(parsed) && isRecord(parsed.provider)) {
    for (const [id, block] of Object.entries(parsed.provider)) if (isRecord(block)) providers[id] = block
  }
  return { providers }
}

export function familyOf(...names: ReadonlyArray<string | undefined>): Family | undefined {
  const joined = names.filter((name): name is string => name !== undefined).join(" ")
  return FAMILIES.find(([, pattern]) => pattern.test(joined))?.[0]
}

/**
 * Models of the authorised families found in the config, or exactly the ones
 * asked for. A model outside those families is refused, so a stray selector
 * cannot spend an unauthorised or expensive model.
 */
export function discoverModels(origin: OriginConfig, selected?: readonly string[]): ModelRef[] {
  const found: ModelRef[] = []
  for (const [providerID, block] of Object.entries(origin.providers)) {
    const models = isRecord(block.models) ? block.models : {}
    for (const [modelID, value] of Object.entries(models)) {
      const detail = isRecord(value) ? value : {}
      const family = familyOf(modelID, text(detail.id), text(detail.name), text(detail.family))
      if (family) found.push({ providerID, modelID, family })
    }
  }
  if (!selected || selected.length === 0) return found
  return selected.map((entry) => {
    const match = found.find((model) => `${model.providerID}/${model.modelID}` === entry)
    if (!match) {
      throw new Error(`model ${entry} is not a configured QWEN, GLM or DeepSeek model (the authorised families)`)
    }
    return match
  })
}

/** Names of the environment variables a value refers to as `{env:NAME}`. */
export function referencedEnv(value: unknown): string[] {
  const names = new Set<string>()
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (match[1]) names.add(match[1])
    } else if (Array.isArray(item)) item.forEach(visit)
    else if (isRecord(item)) Object.values(item).forEach(visit)
  }
  visit(value)
  return [...names]
}

// ---------------------------------------------------------------------------
// Stub reviewer: the model behind the background `/review`
// ---------------------------------------------------------------------------

export interface Expected {
  /** Resolves when the review's request has reached the stub. */
  readonly arrived: Promise<void>
  /** Lets the held answer go. */
  readonly release: () => void
}

export interface Stub {
  readonly baseURL: string
  /** Answers requests that mention `key` (the scenario's directory) with `findings`, once released. */
  readonly expect: (key: string, findings: string) => Expected
  readonly unmatched: () => number
  readonly stop: () => void
}

function completion(findings: string): Response {
  const encoder = new TextEncoder()
  const chunk = (delta: Record<string, unknown>, finish?: string) =>
    `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: "assistant" })))
        controller.enqueue(encoder.encode(chunk({ content: findings })))
        controller.enqueue(encoder.encode(chunk({}, "stop")))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

export function startStub(): Stub {
  interface Entry {
    readonly findings: string
    readonly gate: Promise<void>
    readonly arrive: () => void
  }
  const entries = new Map<string, Entry>()
  let unmatched = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = JSON.stringify(await request.json().catch(() => ({})))
      const key = [...entries.keys()].find((candidate) => body.includes(candidate))
      const entry = key === undefined ? undefined : entries.get(key)
      if (!entry) {
        // Title and other housekeeping requests carry no scenario directory.
        unmatched++
        return completion("No findings.")
      }
      entry.arrive()
      await entry.gate
      return completion(entry.findings)
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    expect(key, findings) {
      let release = () => {}
      let arrive = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      const arrived = new Promise<void>((resolve) => (arrive = resolve))
      entries.set(key, { findings, gate, arrive })
      return { arrived, release }
    },
    unmatched: () => unmatched,
    stop: () => void server.stop(true),
  }
}

// ---------------------------------------------------------------------------
// Host process
// ---------------------------------------------------------------------------

export interface Host {
  readonly url: string
  readonly stderrTail: () => string
  readonly stop: () => Promise<void>
}

const liveHosts = new Set<Host>()

/** Stops every host still running; the live test calls it in a finalizer. */
export async function stopAllHosts(): Promise<void> {
  await Promise.all([...liveHosts].map((host) => host.stop()))
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export interface HostSetup {
  readonly origin: OriginConfig
  readonly model: ModelRef
  readonly stubURL: string
  readonly stepCap: number
  /** The host's temporary home: the only place outside the workspace the model may read (truncated tool output). */
  readonly home: string
}

/** The inline config of one host: the chosen provider, the stub, the step budget and a quiet runtime. */
export function hostConfig(setup: HostSetup): Record<string, unknown> {
  const block = setup.origin.providers[setup.model.providerID]
  if (!block) throw new Error(`provider ${setup.model.providerID} is not in the origin config`)
  return {
    formatter: false,
    lsp: false,
    autoupdate: false,
    provider: {
      [setup.model.providerID]: block,
      stub: {
        name: "Stub reviewer",
        id: "stub",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          reviewer: {
            id: "reviewer",
            name: "Stub reviewer",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "stub-key", baseURL: setup.stubURL },
      },
    },
    model: `${setup.model.providerID}/${setup.model.modelID}`,
    small_model: "stub/reviewer",
    permission: {
      "*": "allow",
      // Nothing outside the workspace is readable, apart from the runtime's own truncated tool output; the
      // model's tool results go to a remote provider, so the developer's files must not be reachable.
      external_directory: {
        "*": "deny",
        [path.join(setup.home, ".local/share/graphagent/tool-output/*")]: "allow",
      },
    },
    compaction: { auto: false },
    reasoningDistillation: { enabled: false },
    agent: {
      build: { steps: setup.stepCap },
      // The user-initiated review runs on the stub: fixed findings, no cost.
      review: { model: "stub/reviewer" },
    },
  }
}

/** The environment of a host: an allow-list plus the variables the provider block names. */
export function hostEnv(input: {
  readonly home: string
  readonly config: Record<string, unknown>
  readonly passthrough: Readonly<Record<string, string>>
}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const name of ["PATH", "SHELL", "LANG"]) {
    const value = process.env[name]
    if (value !== undefined) base[name] = value
  }
  return {
    ...base,
    ...input.passthrough,
    HOME: input.home,
    PWD: input.home,
    // The runtime keeps hook scratch directories and model-written temporary files under the OS temp
    // directory; pointing it into the temporary home keeps them out of the developer's real one.
    TMPDIR: path.join(input.home, "tmp"),
    GRAPHAGENT_TEST_HOME: input.home,
    XDG_CONFIG_HOME: path.join(input.home, ".config"),
    XDG_DATA_HOME: path.join(input.home, ".local/share"),
    XDG_STATE_HOME: path.join(input.home, ".local/state"),
    XDG_CACHE_HOME: path.join(input.home, ".cache"),
    GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(input.config),
    GRAPHAGENT_DB: path.join(input.home, "isolated.db"),
    GRAPHAGENT_DISABLE_PROJECT_CONFIG: "1",
    GRAPHAGENT_DISABLE_AUTOCOMPACT: "1",
    GRAPHAGENT_DISABLE_MODELS_FETCH: "1",
    GRAPHAGENT_AUTH_CONTENT: "{}",
  }
}

async function seedHome(home: string, auditFile: string): Promise<void> {
  const config = path.join(home, ".config", "graphagent")
  await fs.mkdir(config, { recursive: true })
  await fs.mkdir(path.join(home, "tmp"), { recursive: true })
  const command = `${shellQuote(process.execPath)} ${shellQuote(HOOK_ENTRY)} ${shellQuote(auditFile)}`
  await fs.writeFile(
    path.join(config, "hooks.json"),
    JSON.stringify({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] }),
  )
  // A valid, disabled memory config: without one the runtime would enable memory with the conversation model.
  await fs.writeFile(
    path.join(config, "memory.jsonc"),
    JSON.stringify({
      schema_version: 1,
      enabled: false,
      model: "stub/reviewer",
      topic_limit: 10,
      turn_interval: 5,
      injection: { max_topics: 3, max_tokens: 1200 },
    }),
  )
}

async function drain(stream: ReadableStream<Uint8Array>, onText: (chunk: string) => void) {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

export async function startHost(input: { readonly env: Record<string, string>; readonly cwd: string }): Promise<Host> {
  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", HOST_ENTRY], {
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  let stderr = ""
  let stdout = ""
  const keepTail = (current: string, chunk: string) => (current + chunk).slice(-32_768)
  void drain(child.stderr, (chunk) => (stderr = keepTail(stderr, chunk)))
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the evaluation host did not become ready")), HOST_READY_MS)
    void drain(child.stdout, (chunk) => {
      stdout = keepTail(stdout, chunk)
      const match = /listening on (http:\/\/[^\s]+)/.exec(stdout)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    void child.exited.then((code) => reject(new Error(`the evaluation host exited early with code ${code}`)))
  })
  const host: Host = {
    url: await ready.catch(async (error: unknown) => {
      child.kill()
      throw new Error(`${error instanceof Error ? error.message : "host failed"}\n${stderr.slice(-1500)}`)
    }),
    stderrTail: () => stderr,
    stop: async () => {
      liveHosts.delete(host)
      child.kill()
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    },
  }
  liveHosts.add(host)
  return host
}

// ---------------------------------------------------------------------------
// HTTP client of one scenario directory
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    detail: string,
  ) {
    super(`HTTP ${status} on ${route}: ${detail}`)
  }
}

export function client(host: Host, directory: string) {
  return async (route: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<unknown> => {
    const response = await fetch(host.url + route, {
      method: options.body === undefined ? "GET" : "POST",
      headers: { "x-graphagent-directory": encodeURIComponent(directory), "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
    const body = await response.text()
    if (!response.ok) throw new ApiError(route, response.status, body.slice(0, 300))
    return body ? (JSON.parse(body) as unknown) : undefined
  }
}

// ---------------------------------------------------------------------------
// Workspace: the fixture as a small git history plus the scenario's edits
// ---------------------------------------------------------------------------

type Git = (args: readonly string[], cwd: string, date?: string) => Promise<void>

function gitRunner(home: string): Git {
  return async (args, cwd, date) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Pocket Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Pocket Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    }
    const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${errors.slice(0, 300)}`)
  }
}

async function listFiles(root: string, relative = "", skip: readonly string[] = []): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => !skip.includes(entry.name))
      .map(async (entry) => {
        const next = path.join(relative, entry.name)
        return entry.isDirectory() ? listFiles(root, next, skip) : [next]
      }),
  )
  return nested.flat()
}

// Ignored by the fixture's own .gitignore: clutter a cleanup request has something to find.
const CLUTTER: Readonly<Record<string, string>> = {
  "scratch/experiments.txt": "try token rotation every 15 minutes\nretry wrapper benchmark: 3 attempts is enough\n",
  "dist/index.js": "// stale build output from 1.4.0\nexport const version = '1.4.0'\n",
}

/** Applies the scenario's working-tree edits, refusing an edit whose anchor is gone. */
export async function applyEdits(dir: string, edits: readonly FileEdit[]): Promise<void> {
  for (const edit of edits) {
    const target = path.join(dir, edit.file)
    const content = await fs.readFile(target, "utf8")
    if (!content.includes(edit.find)) throw new Error(`edit anchor not found in ${edit.file}`)
    await fs.writeFile(
      target,
      content.replace(edit.find, () => edit.replace),
    )
  }
}

export async function buildWorkspace(dir: string, scenario: Scenario, home: string): Promise<void> {
  const git = gitRunner(home)
  for (const file of await listFiles(FIXTURE)) {
    const target = path.join(dir, file.replace(/\.txt$/, ""))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(FIXTURE, file), target)
  }
  for (const [file, content] of Object.entries(CLUTTER)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), content)
  }
  await git(["init", "-q", "-b", "main"], dir)
  await git(["config", "commit.gpgsign", "false"], dir)
  await git(["config", "core.fsmonitor", "false"], dir)
  // The auth module arrives later, through a merged pull request.
  await git(
    [
      "add",
      "-A",
      "--",
      ".",
      ":(exclude)src/auth",
      ":(exclude)test/auth.login.test.ts",
      ":(exclude)test/auth.session.test.ts",
    ],
    dir,
  )
  await git(["commit", "-q", "-m", "Initial import"], dir, "2026-11-02T10:00:00Z")
  await git(["checkout", "-q", "-b", "auth-refactor"], dir)
  await git(["add", "-A"], dir)
  await git(
    ["commit", "-q", "-m", "refactor(auth): salted password hashing, session TTL and token helpers"],
    dir,
    "2026-11-11T15:30:00Z",
  )
  await git(["checkout", "-q", "main"], dir)
  await git(
    ["merge", "-q", "--no-ff", "-m", "Merge pull request #42 from team/auth-refactor", "auth-refactor"],
    dir,
    "2026-11-12T08:45:00Z",
  )
  await git(["branch", "-q", "-D", "auth-refactor"], dir)
  await applyEdits(dir, scenario.uncommitted)
}

/** A digest of every file outside .git: proves a scenario left the workspace as it found it. */
export async function workspaceDigest(dir: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha1")
  const files = (await listFiles(dir, "", [".git"])).sort()
  for (const file of files) {
    hasher.update(file)
    hasher.update(await fs.readFile(path.join(dir, file)))
  }
  return hasher.digest("hex")
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface PartView {
  readonly type: string
  readonly text?: string
  readonly synthetic?: boolean
  readonly backgroundResult?: Readonly<Record<string, unknown>>
  readonly tool?: string
  readonly callID?: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly status?: string
}

export interface MessageView {
  readonly id: string
  readonly role: string
  readonly parts: readonly PartView[]
  readonly error?: string
  readonly completed: boolean
}

function partView(value: unknown): PartView {
  if (!isRecord(value)) return { type: "unknown" }
  const type = text(value.type) ?? "unknown"
  if (type === "text") {
    const metadata = isRecord(value.metadata) ? value.metadata : {}
    return {
      type,
      text: text(value.text) ?? "",
      synthetic: value.synthetic === true,
      ...(isRecord(metadata.backgroundResult) ? { backgroundResult: metadata.backgroundResult } : {}),
    }
  }
  if (type === "reasoning") return { type, text: text(value.text) ?? "" }
  if (type === "tool") {
    const state = isRecord(value.state) ? value.state : {}
    return {
      type,
      tool: text(value.tool) ?? "",
      ...(text(value.callID) ? { callID: text(value.callID) } : {}),
      input: isRecord(state.input) ? state.input : {},
      status: text(state.status) ?? "",
    }
  }
  return { type }
}

export function readMessages(json: unknown): MessageView[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((item): MessageView[] => {
    if (!isRecord(item) || !isRecord(item.info)) return []
    const failure = isRecord(item.info.error) ? item.info.error : undefined
    const name = failure ? text(failure.name) : undefined
    const detail = failure && isRecord(failure.data) ? text(failure.data.message) : undefined
    return [
      {
        id: text(item.info.id) ?? "",
        role: text(item.info.role) ?? "",
        parts: Array.isArray(item.parts) ? item.parts.map(partView) : [],
        ...(failure && name !== "MessageAbortedError" ? { error: `${name ?? "error"}: ${detail ?? ""}` } : {}),
        completed: isRecord(item.info.time) && typeof item.info.time.completed === "number",
      },
    ]
  })
}

/** The injected result of the user's background `/review`, as the runtime wrote it. */
export function findInjection(messages: readonly MessageView[]): number {
  return messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.parts.some((part) => part.synthetic === true && part.backgroundResult?.initiator === "user"),
  )
}

/** True when the injected message is what the real delivery path writes for a finished `/review`. */
export function isReviewInjection(message: MessageView | undefined): boolean {
  const part = message?.parts.find((item) => item.backgroundResult !== undefined)
  return (
    part !== undefined &&
    part.backgroundResult?.command === HARNESS_COMMAND &&
    part.backgroundResult.status === "completed" &&
    (part.text ?? "").startsWith(ChildNotice.userBackgroundNotice(HARNESS_COMMAND))
  )
}

export function callsOf(messages: readonly MessageView[]): ToolCall[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.flatMap((part): ToolCall[] =>
          part.type === "tool" && part.tool
            ? [{ tool: part.tool, input: part.input ?? {}, ...(part.callID ? { callID: part.callID } : {}) }]
            : [],
        )
      : [],
  )
}

export function stepsOf(messages: readonly MessageView[]): number {
  return messages.filter(
    (message) => message.role === "assistant" && message.parts.some((part) => part.type === "step-start"),
  ).length
}

function lastReply(messages: readonly MessageView[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue
    const reply = message.parts.findLast((part) => part.type === "text" && !part.synthetic)?.text
    if (reply) return reply.slice(0, 600)
  }
  return undefined
}

function digest(messages: readonly MessageView[]) {
  return messages.map((message) => ({
    role: message.role,
    ...(message.error ? { error: message.error } : {}),
    parts: message.parts.map((part) =>
      part.type === "tool"
        ? { type: part.type, tool: part.tool, status: part.status, input: part.input }
        : part.type === "reasoning"
          ? { type: part.type, text: (part.text ?? "").slice(0, 1200) }
          : part.type === "text"
            ? {
                type: part.type,
                synthetic: part.synthetic,
                ...(part.backgroundResult ? { backgroundResult: part.backgroundResult } : {}),
                text: (part.text ?? "").slice(0, 1500),
              }
            : { type: part.type },
    ),
  }))
}

// ---------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function scrubber(places: RunContext["places"]): (value: string) => string {
  const longestFirst = [...places].sort((a, b) => b[0].length - a[0].length)
  return (value) => longestFirst.reduce((current, [place, label]) => current.replaceAll(place, label), value)
}

async function until<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await wait(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function within(label: string, timeoutMs: number, promise: Promise<void>): Promise<void> {
  await Promise.race([promise, wait(timeoutMs).then(() => Promise.reject(new Error(`timed out waiting for ${label}`)))])
}

async function settle(api: ReturnType<typeof client>, sessionID: string, timeoutMs: number): Promise<void> {
  let quiet = 0
  await until("the session to go idle", timeoutMs, async () => {
    const status = await api("/session/status")
    const entry = isRecord(status) ? status[sessionID] : undefined
    const busy = isRecord(entry) && entry.type !== "idle"
    quiet = busy ? 0 : quiet + 1
    return quiet >= 3 ? true : undefined
  })
}

export interface RunContext {
  /** Temporary paths and the label that replaces them in the report, so results do not carry machine paths. */
  readonly places: ReadonlyArray<readonly [string, string]>
  readonly host: Host
  readonly stub: Stub
  readonly model: ModelRef
  readonly round: number
  readonly stepCap: number
  readonly work: string
  readonly home: string
  readonly timeoutMs: number
  readonly redact: (value: string) => string
  readonly transcripts?: string
}

interface Observation {
  readonly messages: readonly MessageView[]
  readonly scopeStart: number
}

async function observe(
  ctx: RunContext,
  scenario: Scenario,
  dir: string,
  api: ReturnType<typeof client>,
): Promise<Observation> {
  const session = await api("/session", { body: { title: scenario.id, permission: ALLOW_ALL } })
  const sessionID = isRecord(session) ? text(session.id) : undefined
  if (!sessionID) throw new Error("the session was not created")
  const model = { providerID: ctx.model.providerID, modelID: ctx.model.modelID }
  const read = async () => readMessages(await api(`/session/${sessionID}/message`))
  if (!scenario.review) {
    await api(`/session/${sessionID}/message`, {
      body: { model, parts: [{ type: "text", text: scenario.request }] },
      timeoutMs: ctx.timeoutMs,
    })
    return { messages: await read(), scopeStart: 0 }
  }
  // The command starts the background review, which waits at the stub. The command returns once the main
  // agent's first turn is over, so the result is released while the session is idle, as it is when a real
  // review takes minutes.
  const held = ctx.stub.expect(await fs.realpath(dir), scenario.review.findings)
  await api(`/session/${sessionID}/command`, {
    body: {
      command: HARNESS_COMMAND,
      arguments: scenario.review.arguments,
      model: `${model.providerID}/${model.modelID}`,
    },
    timeoutMs: ctx.timeoutMs,
  })
  await within("the review to reach the stub", 30_000, held.arrived)
  await settle(api, sessionID, ctx.timeoutMs)
  held.release()
  await until("the injected review result", 90_000, async () => (findInjection(await read()) >= 0 ? true : undefined))
  await settle(api, sessionID, ctx.timeoutMs)
  const messages = await read()
  const index = findInjection(messages)
  if (!isReviewInjection(messages[index])) throw new Error("the injected result is not the runtime's review delivery")
  return { messages, scopeStart: index + 1 }
}

async function attempt(ctx: RunContext, scenario: Scenario, number: number): Promise<RunRecord> {
  const started = Date.now()
  const dir = path.join(ctx.work, `${scenario.id}-${number}`)
  const scrub = scrubber(ctx.places)
  const record = (decision: Decision, extra: { note?: string; steps: number; reply?: string }): RunRecord => {
    const verdict = judge(expectationOf(scenario), decision)
    return {
      model: `${ctx.model.providerID}/${ctx.model.modelID}`,
      family: ctx.model.family,
      round: ctx.round,
      scenario: scenario.id,
      class: scenario.class,
      outcome: decision.outcome,
      ...verdict,
      tasks: decision.tasks.map((task) => ({
        ...task,
        description: scrub(task.description),
        prompt: scrub(task.prompt),
      })),
      decidedBy: scrub(describeCall(decision.first)),
      steps: extra.steps,
      durationMs: Date.now() - started,
      attempts: number,
      ...(extra.note ? { note: scrub(extra.note) } : {}),
      ...(extra.reply ? { reply: scrub(extra.reply) } : {}),
    }
  }
  try {
    await buildWorkspace(dir, scenario, ctx.home)
    const before = await workspaceDigest(dir)
    const api = client(ctx.host, dir)
    const { messages, scopeStart } = await observe(ctx, scenario, dir, api)
    const scoped = messages.slice(scopeStart)
    const failure = scoped.find((message) => message.error)?.error
    const steps = stepsOf(scoped)
    const decision = decide({
      calls: callsOf(scoped),
      steps,
      stepCap: ctx.stepCap,
      ...(failure ? { error: failure } : {}),
    })
    const changed = (await workspaceDigest(dir)) !== before
    if (ctx.transcripts) {
      await fs.writeFile(
        path.join(ctx.transcripts, `${ctx.model.modelID}-r${ctx.round}-${scenario.id}-${number}.json`),
        JSON.stringify(digest(messages), null, 2),
      )
    }
    const notes = [failure ? ctx.redact(failure) : "", changed ? "the workspace changed during the run" : ""].filter(
      Boolean,
    )
    return record(decision, {
      steps,
      ...(notes.length ? { note: notes.join("; ") } : {}),
      ...(lastReply(scoped) ? { reply: lastReply(scoped) } : {}),
    })
  } catch (error) {
    const detail = ctx.redact(error instanceof Error ? error.message : "unknown failure")
    return record({ outcome: "error", tasks: [], edits: 0 }, { steps: 0, note: detail })
  }
}

/** Runs a scenario, retrying once when the run itself fails (provider error, timeout), never when the model decided. */
export async function runScenario(ctx: RunContext, scenario: Scenario): Promise<RunRecord> {
  const first = await attempt(ctx, scenario, 1)
  return first.outcome === "error" ? attempt(ctx, scenario, 2) : first
}

// ---------------------------------------------------------------------------
// Rounds and the whole evaluation
// ---------------------------------------------------------------------------

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      if (item !== undefined) results[index] = await work(item)
    }
  })
  await Promise.all(workers)
  return results
}

export interface EvalOptions {
  readonly configFile: string
  readonly models?: readonly string[]
  readonly rounds: number
  readonly concurrency: number
  readonly stepCap: number
  readonly timeoutMs: number
  readonly scenarios?: readonly string[]
  readonly outDir?: string
  readonly keep: boolean
}

export function optionsFromEnv(env: Record<string, string | undefined>): EvalOptions {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const list = (name: string) =>
    env[name]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  return {
    configFile:
      env.GRAPHAGENT_LIVE_EVAL_CONFIG ||
      path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "graphagent", "graphagent.json"),
    models: list("GRAPHAGENT_LIVE_EVAL_MODELS"),
    rounds: number("GRAPHAGENT_LIVE_EVAL_ROUNDS", 3),
    concurrency: number("GRAPHAGENT_LIVE_EVAL_CONCURRENCY", 4),
    stepCap: number("GRAPHAGENT_LIVE_EVAL_STEPS", DEFAULT_STEP_CAP),
    timeoutMs: number("GRAPHAGENT_LIVE_EVAL_TIMEOUT_MS", 360_000),
    scenarios: list("GRAPHAGENT_LIVE_EVAL_SCENARIOS"),
    outDir: env.GRAPHAGENT_LIVE_EVAL_OUT || undefined,
    keep: env.GRAPHAGENT_LIVE_EVAL_KEEP === "1",
  }
}

function redactor(secretNames: readonly string[]): (value: string) => string {
  const secrets = secretNames
    .map((name) => process.env[name])
    .filter((value): value is string => !!value && value.length >= 4)
  return (value) => {
    const cleaned = secrets.reduce((current, secret) => current.replaceAll(secret, "<redacted>"), value)
    return cleaned.replace(/https?:\/\/(?!127\.0\.0\.1)[^\s"')]+/g, "<url>")
  }
}

async function runRound(input: {
  readonly options: EvalOptions
  readonly origin: OriginConfig
  readonly model: ModelRef
  readonly round: number
  readonly scenarios: readonly Scenario[]
  readonly outDir: string
  readonly onRecord: (record: RunRecord) => void
}): Promise<RunRecord[]> {
  const { options, origin, model } = input
  const names = referencedEnv(origin.providers[model.providerID])
  const missing = names.filter((name) => !process.env[name])
  if (missing.length > 0)
    throw new Error(`the provider block refers to unset environment variables: ${missing.join(", ")}`)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gaeval-"))
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  const transcripts = path.join(input.outDir, "transcripts")
  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(work, { recursive: true }),
    fs.mkdir(transcripts, { recursive: true }),
  ])
  await seedHome(home, path.join(root, "audit.jsonl"))
  const stub = startStub()
  let host: Host | undefined
  try {
    const config = hostConfig({ origin, model, stubURL: stub.baseURL, stepCap: options.stepCap, home })
    const passthrough = Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""]))
    const redact = redactor(names)
    host = await startHost({ env: hostEnv({ home, config, passthrough }), cwd: home }).catch((error: unknown) => {
      throw new Error(redact(error instanceof Error ? error.message : "the evaluation host failed to start"))
    })
    const places: RunContext["places"] = [
      [work, "<work>"],
      [await fs.realpath(work), "<work>"],
      [home, "<home>"],
      [await fs.realpath(home), "<home>"],
      // The runtime's own scratch directory (truncated tool output, temporary scripts a model writes).
      [os.tmpdir(), "<tmp>"],
      [await fs.realpath(os.tmpdir()), "<tmp>"],
    ]
    const context: RunContext = {
      places,
      host,
      stub,
      model,
      round: input.round,
      stepCap: options.stepCap,
      work,
      home,
      timeoutMs: options.timeoutMs,
      redact,
      transcripts,
    }
    return await pool(input.scenarios, options.concurrency, async (scenario) => {
      const record = await runScenario(context, scenario)
      input.onRecord(record)
      return record
    })
  } finally {
    await host?.stop()
    stub.stop()
    if (!options.keep) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

export interface EvalResult {
  readonly records: readonly RunRecord[]
  readonly report: string
  readonly outDir: string
}

export async function evaluate(
  options: EvalOptions,
  log: (line: string) => void = () => undefined,
): Promise<EvalResult> {
  const origin = parseOriginConfig(await fs.readFile(options.configFile, "utf8"))
  const models = discoverModels(origin, options.models)
  if (models.length === 0) throw new Error("no QWEN, GLM or DeepSeek model is configured")
  const scenarios = options.scenarios?.length
    ? SCENARIOS.filter((scenario) => options.scenarios?.includes(scenario.id))
    : SCENARIOS
  const outDir = options.outDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "graphagent-live-eval-")))
  await fs.mkdir(outDir, { recursive: true })
  const lines = path.join(outDir, "runs.jsonl")
  const records: RunRecord[] = []
  for (const model of models) {
    for (let round = 1; round <= options.rounds; round++) {
      log(`round ${round} on ${model.providerID}/${model.modelID}: ${scenarios.length} scenarios`)
      const done = await runRound({
        options,
        origin,
        model,
        round,
        scenarios,
        outDir,
        onRecord: (record) => {
          void fs.appendFile(lines, `${JSON.stringify(record)}\n`)
          log(
            `  ${record.scenario}: ${record.outcome}${record.violation ? " VIOLATION" : record.accurate ? "" : " miss"}`,
          )
        },
      })
      records.push(...done)
    }
  }
  const report = renderReport(records, {
    rounds: options.rounds,
    stepCap: options.stepCap,
    scenarios: scenarios.map((scenario) => ({ id: scenario.id, class: scenario.class, note: scenario.note })),
  })
  await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify(records, null, 2))
  await fs.writeFile(path.join(outDir, "report.md"), report)
  return { records, report, outDir }
}
