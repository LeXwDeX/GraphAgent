// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  finishRunSlot,
  initializePrivateRunLedger,
  LIVE_RUN_PLAN,
  markRunStarted,
  promptToCompletedIdle,
  ProviderRequestGuard,
  readPrivateRunLedger,
  reserveRunSlot,
  type LiveArm,
  type LiveRunPlan,
  type RunReservation,
} from "./live-run-contract"
import { materializeBodiesV3, V3_TASKS, type V3TaskID, type V3ToolOperation } from "./task-spec-v3"

const EXPECTED_CONTEXT = 81_920
const EXPECTED_OUTPUT = 4_096
const EXPECTED_TARGET = 54_476
const TURN_TIMEOUT_MS = 240_000
const RUN_TIMEOUT_MS = 1_200_000
const GUARD_PLACEHOLDER = "__S09_PROVIDER_GUARD_BASE_URL__"

type JsonRecord = Record<string, unknown>
export type PrivateConfig = {
  schemaVersion: 1
  candidateSha: string
  freezeManifestSha256: string
  taskSpecSha256: string
  host: {
    executable: string
    argsPrefix: string[]
    cwd: string
    env: Record<string, string>
    apiHeaders: Record<string, string>
    graphagentConfigTemplate: JsonRecord
    startupTimeoutMs: number
  }
  realModel: { providerID: string; modelID: string }
  upstream: ProviderUpstream
}

export type ProviderUpstream = { baseUrl: string; headers: Record<string, string> }

type Authorization = {
  schemaVersion: 1
  externalProviderApproved: true
  candidateSha: string
  freezeManifestSha256: string
  approvedRuns: number[]
}

type PreflightOverflowEvidence = {
  schemaVersion: 1
  pattern: "upstream-normal-completion-provider-usage-over-usable-context-auto-compaction-blocked"
  upstream: {
    httpStatus: number
    completion: "normal-stop"
    usage: ProviderUsage
  }
  resolvedWindow: {
    context: number
    outputReserve: number
    usableContext: number
    inputOverageTokens: number
  }
  autoCompaction: {
    observed: true
    source: "host-log-agent-compaction"
  }
  providerGuard: {
    maximum: number
    forwardedRequests: number
    closedReason: "provider-request-cap"
    blockedAdditionalRequest: true
  }
}

type ProviderNon2xxEvidence = {
  schemaVersion: 1
  pattern: "upstream-non-2xx-guard-closed"
  upstream: ProviderResponseEvidence
  providerGuard: {
    maximum: number
    forwardedRequests: number
    closedReason: string
    additionalForwardingBlocked: true
  }
}

export type LiveRunFailureEvidence = PreflightOverflowEvidence | ProviderNon2xxEvidence

class DriverFailure extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly evidence?: LiveRunFailureEvidence,
  ) {
    super(message)
  }
}

const isRecord = (input: unknown): input is JsonRecord =>
  typeof input === "object" && input !== null && !Array.isArray(input)

function stringRecord(input: unknown, label: string) {
  if (!isRecord(input)) throw new DriverFailure("private-config-invalid", `${label} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") throw new DriverFailure("private-config-invalid", `${label}.${key} must be a string`)
    result[key] = value
  }
  return result
}

function requiredString(input: JsonRecord, name: string) {
  const value = input[name]
  if (typeof value !== "string" || value.length === 0)
    throw new DriverFailure("private-config-invalid", `${name} must be a non-empty string`)
  return value
}

function absolutePath(value: string, label: string) {
  if (!path.isAbsolute(value)) throw new DriverFailure("private-config-invalid", `${label} must be absolute`)
  return value
}

function parseModel(input: unknown, label: string) {
  if (!isRecord(input)) throw new DriverFailure("private-config-invalid", `${label} must be an object`)
  return { providerID: requiredString(input, "providerID"), modelID: requiredString(input, "modelID") }
}

function parsePrivateConfig(input: unknown): PrivateConfig {
  if (!isRecord(input) || input.schemaVersion !== 1)
    throw new DriverFailure("private-config-invalid", "private config schemaVersion must be 1")
  if (!isRecord(input.host) || !isRecord(input.upstream))
    throw new DriverFailure("private-config-invalid", "private config host/upstream are required")
  if (!Array.isArray(input.host.argsPrefix) || input.host.argsPrefix.some((item) => typeof item !== "string"))
    throw new DriverFailure("private-config-invalid", "host.argsPrefix must be a string array")
  if (!isRecord(input.host.graphagentConfigTemplate))
    throw new DriverFailure("private-config-invalid", "host.graphagentConfigTemplate must be an object")
  const startupTimeoutMs = input.host.startupTimeoutMs
  if (!Number.isInteger(startupTimeoutMs) || Number(startupTimeoutMs) <= 0)
    throw new DriverFailure("private-config-invalid", "host.startupTimeoutMs must be a positive integer")

  const executable = absolutePath(requiredString(input.host, "executable"), "host.executable")
  const cwd = absolutePath(requiredString(input.host, "cwd"), "host.cwd")
  const candidateSha = requiredString(input, "candidateSha")
  const freezeManifestSha256 = requiredString(input, "freezeManifestSha256")
  const taskSpecSha256 = requiredString(input, "taskSpecSha256")
  for (const [label, value] of [
    ["candidateSha", candidateSha],
    ["freezeManifestSha256", freezeManifestSha256],
    ["taskSpecSha256", taskSpecSha256],
  ] as const) {
    if (!/^[a-f0-9]{40}$/.test(value) && label === "candidateSha")
      throw new DriverFailure("private-config-invalid", `${label} must be a lowercase commit SHA`)
    if (label !== "candidateSha" && !/^[a-f0-9]{64}$/.test(value))
      throw new DriverFailure("private-config-invalid", `${label} must be a lowercase SHA256`)
  }

  return {
    schemaVersion: 1,
    candidateSha,
    freezeManifestSha256,
    taskSpecSha256,
    host: {
      executable,
      argsPrefix: [...input.host.argsPrefix],
      cwd,
      env: stringRecord(input.host.env ?? {}, "host.env"),
      apiHeaders: stringRecord(input.host.apiHeaders ?? {}, "host.apiHeaders"),
      graphagentConfigTemplate: structuredClone(input.host.graphagentConfigTemplate),
      startupTimeoutMs: Number(startupTimeoutMs),
    },
    realModel: parseModel(input.realModel, "realModel"),
    upstream: {
      baseUrl: requiredString(input.upstream, "baseUrl"),
      headers: stringRecord(input.upstream.headers, "upstream.headers"),
    },
  }
}

function parseAuthorization(input: unknown): Authorization {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 1 ||
    input.externalProviderApproved !== true ||
    typeof input.candidateSha !== "string" ||
    typeof input.freezeManifestSha256 !== "string" ||
    !Array.isArray(input.approvedRuns) ||
    input.approvedRuns.some((run) => !Number.isInteger(run))
  )
    throw new DriverFailure("authorization-invalid")
  return {
    schemaVersion: 1,
    externalProviderApproved: true,
    candidateSha: input.candidateSha,
    freezeManifestSha256: input.freezeManifestSha256,
    approvedRuns: [...input.approvedRuns],
  }
}

function stable(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`
  if (isRecord(input))
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(input[key])}`)
      .join(",")}}`
  return JSON.stringify(input)
}

function sha256(input: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex")
}

async function sha256File(file: string) {
  return sha256(new Uint8Array(await Bun.file(file).arrayBuffer()))
}

function replacePlaceholders(
  input: unknown,
  replacements: Record<string, string>,
  counts: Map<string, number>,
): unknown {
  if (typeof input === "string" && input in replacements) {
    counts.set(input, (counts.get(input) ?? 0) + 1)
    return replacements[input]
  }
  if (Array.isArray(input)) return input.map((item) => replacePlaceholders(item, replacements, counts))
  if (!isRecord(input)) return input
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, replacePlaceholders(value, replacements, counts)]),
  )
}

async function privateWrite(file: string, contents: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, contents, { mode: 0o600 })
}

function joinUpstream(base: string, requestUrl: string) {
  const upstream = new URL(base)
  const incoming = new URL(requestUrl)
  const basePath = upstream.pathname.replace(/\/$/, "")
  const requestPath = incoming.pathname.startsWith("/") ? incoming.pathname : `/${incoming.pathname}`
  upstream.pathname = `${basePath}${requestPath}` || "/"
  upstream.search = incoming.search
  return upstream
}

function forwardedHeaders(request: Request, configured: Record<string, string>) {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    if (["authorization", "host", "content-length", "connection", "transfer-encoding"].includes(key.toLowerCase()))
      continue
    headers.set(key, value)
  }
  for (const [key, value] of Object.entries(configured)) headers.set(key, value)
  return headers
}

function bufferedResponseHeaders(input: Headers) {
  const headers = new Headers(input)
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) headers.delete(name)
  return headers
}

export type ProviderProxy = {
  url: string
  bodies: Uint8Array[]
  usages: ProviderUsage[]
  responses: ProviderResponseEvidence[]
  preArmCalls: number
  preArmInFlight: number
  close: () => Promise<void>
}

type UsageValue = number | "unavailable"
export type ProviderUsage = {
  input: UsageValue
  output: UsageValue
  reasoning: UsageValue
  cacheRead: UsageValue
  cacheWrite: UsageValue
}

export type ProviderResponseEvidence = {
  status: number
  bytes: number
  sha256: string
  completion: "normal-stop" | "other-finish" | "unavailable"
}

const unavailableUsage = (): ProviderUsage => ({
  input: "unavailable",
  output: "unavailable",
  reasoning: "unavailable",
  cacheRead: "unavailable",
  cacheWrite: "unavailable",
})

function finiteUsage(input: unknown): UsageValue {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : "unavailable"
}

function parseProviderCandidates(body: ArrayBuffer) {
  const text = new TextDecoder().decode(body)
  const candidates: JsonRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const value: unknown = JSON.parse(payload)
      if (isRecord(value)) candidates.push(value)
    } catch {
      // Response bytes remain private and are not emitted. Missing parseable
      // usage is represented as unavailable rather than zero.
    }
  }
  if (candidates.length === 0) {
    try {
      const value: unknown = JSON.parse(text)
      if (isRecord(value)) candidates.push(value)
    } catch {
      return candidates
    }
  }
  return candidates
}

function parseProviderUsage(candidates: JsonRecord[]) {
  const item = candidates.findLast((candidate) => isRecord(candidate.usage))
  if (!item || !isRecord(item.usage)) return unavailableUsage()
  const usage = item.usage
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
  const outputDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined
  return {
    input: finiteUsage(usage.prompt_tokens ?? usage.input_tokens),
    output: finiteUsage(usage.completion_tokens ?? usage.output_tokens),
    reasoning: finiteUsage(outputDetails?.reasoning_tokens),
    cacheRead: finiteUsage(promptDetails?.cached_tokens),
    cacheWrite: "unavailable" as const,
  }
}

function parseProviderCompletion(candidates: JsonRecord[]): ProviderResponseEvidence["completion"] {
  for (let index = candidates.length - 1; index >= 0; index--) {
    const choices = candidates[index]?.choices
    if (!Array.isArray(choices)) continue
    for (const choice of choices) {
      if (!isRecord(choice) || typeof choice.finish_reason !== "string") continue
      return choice.finish_reason === "stop" ? "normal-stop" : "other-finish"
    }
  }
  return "unavailable"
}

export function startProviderProxy(input: {
  guard: ProviderRequestGuard
  upstream: ProviderUpstream
  preArmUpstream?: ProviderUpstream
  captureDir: string
}): ProviderProxy {
  const bodies: Uint8Array[] = []
  const usages: ProviderUsage[] = []
  const responses: ProviderResponseEvidence[] = []
  const preArmControllers = new Set<AbortController>()
  let preArmCalls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = new Uint8Array(await request.arrayBuffer())
      if (!input.guard.armed) {
        if (!input.preArmUpstream) return Response.json({ error: "s09-provider-guard-not-armed" }, { status: 503 })
        const ordinal = ++preArmCalls
        const controller = new AbortController()
        preArmControllers.add(controller)
        try {
          await privateWrite(
            path.join(input.captureDir, `local-seed-request-${String(ordinal).padStart(2, "0")}.json`),
            body,
          )
          const response = await fetch(joinUpstream(input.preArmUpstream.baseUrl, request.url), {
            method: request.method,
            headers: forwardedHeaders(request, input.preArmUpstream.headers),
            body: body.byteLength ? body : undefined,
            signal: controller.signal,
            redirect: "error",
          })
          const responseBody = await response.arrayBuffer()
          await privateWrite(
            path.join(input.captureDir, `local-seed-response-${String(ordinal).padStart(2, "0")}.bin`),
            new Uint8Array(responseBody),
          )
          if (!response.ok) input.guard.close(`local-seeder-http-${response.status}`)
          return new Response(responseBody, {
            status: response.status,
            statusText: response.statusText,
            headers: bufferedResponseHeaders(response.headers),
          })
        } catch {
          input.guard.close("local-seeder-transport-failure")
          return Response.json({ error: "s09-local-seeder-failed" }, { status: 502 })
        } finally {
          preArmControllers.delete(controller)
        }
      }
      try {
        return await input.guard.forward(async (signal, ordinal) => {
          bodies.push(body)
          await privateWrite(
            path.join(input.captureDir, `external-request-${String(ordinal).padStart(2, "0")}.json`),
            body,
          )
          const response = await fetch(joinUpstream(input.upstream.baseUrl, request.url), {
            method: request.method,
            headers: forwardedHeaders(request, input.upstream.headers),
            body: body.byteLength ? body : undefined,
            signal,
            redirect: "error",
          })
          // Keep the guard's AbortController registered until the provider
          // stream finishes. Returning at headers would let timeout close the
          // guard after its controller had already been discarded.
          const responseBody = await response.arrayBuffer()
          const responseBytes = new Uint8Array(responseBody)
          const responseCandidates = parseProviderCandidates(responseBody)
          await privateWrite(
            path.join(input.captureDir, `external-response-${String(ordinal).padStart(2, "0")}.bin`),
            responseBytes,
          )
          responses[ordinal - 1] = {
            status: response.status,
            bytes: responseBytes.byteLength,
            sha256: sha256(responseBytes),
            completion: parseProviderCompletion(responseCandidates),
          }
          usages[ordinal - 1] = parseProviderUsage(responseCandidates)
          if (!response.ok) input.guard.close(`provider-http-${response.status}`)
          return new Response(responseBody, {
            status: response.status,
            statusText: response.statusText,
            headers: bufferedResponseHeaders(response.headers),
          })
        })
      } catch (error) {
        input.guard.close("provider-transport-or-stream-failure")
        const code = error instanceof Error && error.name === "AbortError" ? 499 : 429
        return Response.json({ error: "s09-provider-guard-closed" }, { status: code })
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies,
    usages,
    responses,
    get preArmCalls() {
      return preArmCalls
    },
    get preArmInFlight() {
      return preArmControllers.size
    },
    close: async () => {
      input.guard.close("provider-proxy-shutdown")
      for (const controller of preArmControllers) controller.abort(new DriverFailure("local-seeder-shutdown"))
      await server.stop(true)
    },
  }
}

const preflightFiles = ["s09-h0-a.txt", "s09-h0-b.txt", "s09-h0-c.txt"] as const
const preflightPhrases = [
  "alpha amber cedar delta ember forest garden harbor",
  "ivory juniper meadow north ocean prairie quartz river",
  "silver timber upland valley willow xenon yellow zephyr",
] as const
const preflightContents = preflightFiles.map((_, index) =>
  Array.from({ length: 192 }, (_unused, line) => {
    const prefix =
      line === 0 ? `s09-h0-file-${index}-marker` : `s09 h0 file ${index} line ${String(line).padStart(3, "0")}`
    return `${prefix}. ${preflightPhrases[index]}.`
  }).join("\n"),
)
const preflightRecent = Array.from(
  { length: 4 },
  (_, index) => `s09-h0-protected-${index}:${" recent protected context remains stable and unchanged.".repeat(300)}`,
)

function sse(chunks: unknown[]) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
}

function textChunks(text: string) {
  return [
    {
      id: "chatcmpl-s09-seeder",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-s09-seeder",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]
}

function toolChunks(directory: string) {
  return [
    {
      id: "chatcmpl-s09-seeder",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: preflightFiles.flatMap((name, index) =>
              ["source", "witness"].map((kind) => ({
                index: index * 2 + (kind === "source" ? 0 : 1),
                id: `call-h0-${index}-${kind}`,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ filePath: path.join(directory, name) }) },
              })),
            ),
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]
}

function startLocalSeeder(directory: string) {
  let calls = 0
  const replies = [toolChunks(directory), textChunks("s09 h0 seed complete"), ...preflightRecent.map(textChunks)]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      await request.arrayBuffer()
      const reply = replies[calls++]
      if (!reply) return Response.json({ error: "unexpected local seeder request" }, { status: 409 })
      return new Response(sse(reply), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get calls() {
      return calls
    },
    close: async () => server.stop(true),
  }
}

type HostHandle = {
  url: string
  stdoutPath: string
  stderrPath: string
  stop: () => Promise<void>
}

function validateHostConfigTemplate(config: PrivateConfig) {
  const template = config.host.graphagentConfigTemplate
  const realID = `${config.realModel.providerID}/${config.realModel.modelID}`
  if (template.model !== realID || template.small_model !== realID)
    throw new DriverFailure("default-or-small-model-bypasses-guard")
  if (
    !Array.isArray(template.enabled_providers) ||
    template.enabled_providers.length !== 1 ||
    template.enabled_providers[0] !== config.realModel.providerID
  )
    throw new DriverFailure("enabled-provider-allowlist-mismatch")
  if (!isRecord(template.provider)) throw new DriverFailure("provider-routing-template-invalid")
  const providerKeys = Object.keys(template.provider).sort()
  const expectedKeys = [config.realModel.providerID]
  if (stable(providerKeys) !== stable(expectedKeys)) throw new DriverFailure("provider-routing-template-invalid")

  const real = template.provider[config.realModel.providerID]
  if (!isRecord(real) || !isRecord(real.options) || real.options.baseURL !== GUARD_PLACEHOLDER)
    throw new DriverFailure("real-provider-does-not-use-guard")
}

async function boundedChildStop(child: ReturnType<typeof Bun.spawn>, drains: Promise<unknown>) {
  const wait = async (promise: Promise<unknown>, timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("child-cleanup-timeout")), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  child.kill("SIGTERM")
  try {
    await wait(child.exited, 3_000)
  } catch {
    child.kill("SIGKILL")
    await wait(child.exited, 3_000)
  }
  await wait(drains, 3_000)
}

async function startHost(input: {
  config: PrivateConfig
  arm: LiveArm
  guardUrl: string
  outputDir: string
}): Promise<HostHandle> {
  validateHostConfigTemplate(input.config)
  const counts = new Map<string, number>()
  const graphagentConfig = replacePlaceholders(
    input.config.host.graphagentConfigTemplate,
    { [GUARD_PLACEHOLDER]: input.guardUrl },
    counts,
  )
  if (counts.get(GUARD_PLACEHOLDER) !== 1) throw new DriverFailure("provider-routing-template-invalid")
  const compaction =
    isRecord(graphagentConfig) && isRecord(graphagentConfig.compaction) ? graphagentConfig.compaction : undefined
  if (!compaction || compaction.auto !== true || compaction.dynamic !== true)
    throw new DriverFailure("compaction-config-not-frozen")

  const isolation = path.join(input.outputDir, "host-isolation")
  const isolatedHome = path.join(isolation, "home")
  const isolatedConfig = path.join(isolation, "xdg-config")
  const isolatedData = path.join(isolation, "xdg-data")
  const isolatedCache = path.join(isolation, "xdg-cache")
  const isolatedState = path.join(isolation, "xdg-state")
  const isolatedTmp = path.join(isolation, "tmp")
  await Promise.all(
    [isolatedHome, isolatedConfig, isolatedData, isolatedCache, isolatedState, isolatedTmp].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  )
  const inheritedEnv = Object.fromEntries(
    Object.entries(input.config.host.env).filter(([key]) => {
      if (key === "OPENCODE_SERVER_USERNAME" || key === "OPENCODE_SERVER_PASSWORD") return true
      if (key.startsWith("OPENCODE_") || key === "HOME" || key.startsWith("XDG_") || key === "TMPDIR") return false
      return true
    }),
  )
  const env = {
    ...inheritedEnv,
    HOME: isolatedHome,
    OPENCODE_TEST_HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedConfig,
    XDG_DATA_HOME: isolatedData,
    XDG_CACHE_HOME: isolatedCache,
    XDG_STATE_HOME: isolatedState,
    TMPDIR: isolatedTmp,
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PRINT_LOGS: "1",
    OPENCODE_LOG_LEVEL: "INFO",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(graphagentConfig),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_AUTH_CONTENT: "{}",
    ...(input.arm === "disabled" ? { OPENCODE_DISABLE_PRUNE: "true" } : {}),
  }
  delete env.OPENCODE_CONFIG
  if (input.arm === "enabled") delete env.OPENCODE_DISABLE_PRUNE
  const stdoutPath = path.join(input.outputDir, "host.stdout.log")
  const stderrPath = path.join(input.outputDir, "host.stderr.log")
  const stdout = await open(stdoutPath, "w", 0o600)
  const stderr = await open(stderrPath, "w", 0o600)
  const child = Bun.spawn(
    [input.config.host.executable, ...input.config.host.argsPrefix, "serve", "--port", "0", "--hostname", "127.0.0.1"],
    { cwd: input.config.host.cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )

  let readyResolve: ((url: string) => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    file: Awaited<ReturnType<typeof open>>,
    parseReady: boolean,
  ) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        await file.write(next.value)
        if (parseReady) {
          pending += decoder.decode(next.value, { stream: true })
          const match = pending.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
          if (match) readyResolve?.(match[1]!)
          if (pending.length > 8_192) pending = pending.slice(-4_096)
        }
      }
    } finally {
      await file.sync()
      await file.close()
    }
  }
  const drains = Promise.all([drain(child.stdout, stdout, true), drain(child.stderr, stderr, false)])
  void child.exited.then((code) => {
    if (code !== 0) readyReject?.(new DriverFailure("host-exited-before-ready"))
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DriverFailure("host-startup-timeout")), input.config.host.startupTimeoutMs)
    })
    const url = await Promise.race([ready, timeout])
    return {
      url,
      stdoutPath,
      stderrPath,
      stop: async () => {
        await boundedChildStop(child, drains)
      },
    }
  } catch (error) {
    try {
      await boundedChildStop(child, drains)
    } catch {
      // Preserve the startup failure. Cleanup is bounded and the owned child
      // has already received SIGKILL if SIGTERM was insufficient.
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function api(input: {
  host: HostHandle
  config: PrivateConfig
  directory: string
  route: string
  method?: string
  body?: unknown
  signal?: AbortSignal
}): Promise<unknown> {
  const headers = new Headers(input.config.host.apiHeaders)
  headers.set("x-opencode-directory", encodeURIComponent(input.directory))
  if (input.body !== undefined) headers.set("content-type", "application/json")
  const response = await fetch(`${input.host.url}${input.route}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: input.signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new DriverFailure("host-http-error", `host returned HTTP ${response.status}`)
  return response.json()
}

function unwrapRecord(input: unknown, label: string) {
  const value = isRecord(input) && isRecord(input.data) ? input.data : input
  if (!isRecord(value)) throw new DriverFailure("host-response-invalid", `${label} is not an object`)
  return value
}

function unwrapArray(input: unknown, label: string) {
  const value = isRecord(input) && Array.isArray(input.data) ? input.data : input
  if (!Array.isArray(value)) throw new DriverFailure("host-response-invalid", `${label} is not an array`)
  return value
}

async function createSession(host: HostHandle, config: PrivateConfig, directory: string) {
  const response = unwrapRecord(
    await api({
      host,
      config,
      directory,
      route: "/session",
      method: "POST",
      body: { title: "S09 frozen live run", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
    }),
    "session.create",
  )
  const id = response.id
  if (typeof id !== "string") throw new DriverFailure("host-response-invalid", "session id missing")
  return id
}

export function assistantCompleted(input: unknown) {
  const message = isRecord(input) && isRecord(input.data) ? input.data : input
  if (!isRecord(message) || !isRecord(message.info)) return false
  const info = message.info
  const completed = isRecord(info.time) ? info.time.completed : undefined
  return (
    info.role === "assistant" &&
    info.finish === "stop" &&
    info.error === undefined &&
    typeof completed === "number" &&
    Number.isFinite(completed) &&
    completed > 0
  )
}

async function sessionStatus(host: HostHandle, config: PrivateConfig, directory: string, sessionID: string) {
  const response = await api({ host, config, directory, route: "/session/status" })
  const statuses = isRecord(response) && isRecord(response.data) ? response.data : response
  if (!isRecord(statuses)) return "unknown" as const
  const current = statuses[sessionID]
  if (current === undefined) return "idle" as const
  if (!isRecord(current)) return "unknown" as const
  return current.type === "idle" || current.type === "busy" || current.type === "retry" ? current.type : "unknown"
}

async function abortSession(host: HostHandle, config: PrivateConfig, directory: string, sessionID: string) {
  try {
    await api({ host, config, directory, route: `/session/${sessionID}/abort`, method: "POST" })
  } catch {
    // The provider guard is already closed. Host abort is best-effort cleanup.
  }
}

async function prompt(input: {
  host: HostHandle
  config: PrivateConfig
  directory: string
  sessionID: string
  model: { providerID: string; modelID: string }
  text: string
  guard: ProviderRequestGuard
  timeoutMs: number
}) {
  return promptToCompletedIdle({
    timeoutMs: input.timeoutMs,
    guard: input.guard,
    prompt: (signal) =>
      api({
        host: input.host,
        config: input.config,
        directory: input.directory,
        route: `/session/${input.sessionID}/message`,
        method: "POST",
        body: {
          agent: "build",
          model: input.model,
          parts: [{ type: "text", text: input.text }],
        },
        signal,
      }),
    status: () => sessionStatus(input.host, input.config, input.directory, input.sessionID),
    abortSession: () => abortSession(input.host, input.config, input.directory, input.sessionID),
    isCompletedAssistant: assistantCompleted,
  })
}

async function saveJson(file: string, value: unknown) {
  await privateWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function recordedPrompt(input: {
  host: HostHandle
  config: PrivateConfig
  directory: string
  sessionID: string
  model: { providerID: string; modelID: string }
  text: string
  guard: ProviderRequestGuard
  timeoutMs: number
  round: number
  artifactsDir: string
}) {
  const prefix = `round-${String(input.round).padStart(2, "0")}`
  const before = await messages(input.host, input.config, input.directory, input.sessionID)
  await saveJson(path.join(input.artifactsDir, `${prefix}-prompt.json`), {
    modelIdentitySha256: sha256(stable(input.model)),
    text: input.text,
  })
  await saveJson(path.join(input.artifactsDir, `${prefix}-before-history.json`), before)
  const response = await prompt(input)
  await saveJson(path.join(input.artifactsDir, `${prefix}-prompt-response.json`), response)
  const after = await messages(input.host, input.config, input.directory, input.sessionID)
  await saveJson(path.join(input.artifactsDir, `${prefix}-after-history.json`), after)
  return { before, response, after }
}

function messageParts(input: unknown) {
  const message = unwrapRecord(input, "message")
  return Array.isArray(message.parts) ? message.parts : []
}

function messageText(input: unknown) {
  return messageParts(input)
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
}

async function messages(host: HostHandle, config: PrivateConfig, directory: string, sessionID: string) {
  return unwrapArray(await api({ host, config, directory, route: `/session/${sessionID}/message` }), "session.messages")
}

function normalizedMessages(input: unknown[], ids?: ReadonlySet<string>) {
  return input.flatMap((message) => {
    if (!isRecord(message) || !isRecord(message.info) || typeof message.info.id !== "string") return []
    if (ids && !ids.has(message.info.id)) return []
    const copy = structuredClone(message)
    if (isRecord(copy.info) && isRecord(copy.info.time)) delete copy.info.time.consumed
    return [copy]
  })
}

function completedTools(input: unknown[]) {
  return input.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return []
    return message.parts.flatMap((part) => {
      if (!isRecord(part) || part.type !== "tool" || typeof part.callID !== "string" || typeof part.tool !== "string")
        return []
      const state = isRecord(part.state) ? part.state : undefined
      if (!state || state.status !== "completed" || typeof state.output !== "string") return []
      return [{ callID: part.callID, tool: part.tool, input: state.input, output: state.output }]
    })
  })
}

type ObservedTaskTool = {
  callID: string
  tool: string
  input: JsonRecord
  output: string
  status: string
  truncated: unknown
  step: number
}

type ObservedTaskTurn = {
  prompt: string
  tools: ObservedTaskTool[]
  steps: number
}

function taskTurns(history: unknown[]) {
  const turns: ObservedTaskTurn[] = []
  let current: ObservedTaskTurn | undefined
  for (const message of history) {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue
    if (message.info.role === "user") {
      current = { prompt: messageText(message), tools: [], steps: 0 }
      turns.push(current)
      continue
    }
    if (message.info.role !== "assistant" || !current) continue
    let step = current.steps
    for (const part of message.parts) {
      if (!isRecord(part)) continue
      if (part.type === "step-start") {
        step++
        current.steps++
        continue
      }
      if (part.type !== "tool" || typeof part.callID !== "string" || typeof part.tool !== "string") continue
      const state = isRecord(part.state) ? part.state : {}
      current.tools.push({
        callID: part.callID,
        tool: part.tool,
        input: isRecord(state.input) ? state.input : {},
        output: typeof state.output === "string" ? state.output : "",
        status: typeof state.status === "string" ? state.status : "unknown",
        truncated: isRecord(state.metadata) ? state.metadata.truncated : undefined,
        step,
      })
    }
  }
  return turns
}

function relativeToolPath(directory: string, value: unknown) {
  if (typeof value !== "string" || value.length === 0) return undefined
  const absolute = path.resolve(directory, value)
  const relative = path.relative(directory, absolute)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return undefined
  return relative.split(path.sep).join("/")
}

function shellWords(command: unknown) {
  if (typeof command !== "string" || /[;&|\n\r]/.test(command)) return []
  const words: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "")
  return words
}

function isRestoreCommand(input: JsonRecord, directory: string) {
  const words = shellWords(input.command)
  if (words[0] !== "cp") return false
  const operands = words[1] === "--" ? words.slice(2) : words.slice(1)
  if (operands.length !== 2) return false
  return (
    relativeToolPath(directory, operands[0]) === "backup/version.orig.txt" &&
    relativeToolPath(directory, operands[1]) === "app/version.txt"
  )
}

function observedToolKey(tool: ObservedTaskTool, directory: string) {
  if (tool.tool === "read") {
    const file = relativeToolPath(directory, tool.input.filePath)
    return file ? `read:${file}` : undefined
  }
  if (tool.tool === "edit") {
    const file = relativeToolPath(directory, tool.input.filePath)
    return file ? `edit:${file}` : undefined
  }
  if (tool.tool === "grep") {
    const requested = relativeToolPath(directory, tool.input.path ?? directory)
    return typeof tool.input.pattern === "string" && requested ? `grep:${tool.input.pattern}:${requested}` : undefined
  }
  if (tool.tool === "bash" && isRestoreCommand(tool.input, directory)) return "bash:restore-version"
  return undefined
}

function expectedToolKey(operation: V3ToolOperation) {
  if (operation.kind === "read") return `read:${operation.path}`
  if (operation.kind === "edit") return `edit:${operation.path}`
  if (operation.kind === "grep") return `grep:${operation.pattern}:${operation.path}`
  return "bash:restore-version"
}

type LiveTaskConstraint = { name: string; pass: boolean }
type LiveTaskConstraintInput = {
  finalText: string
  files: Map<string, string>
  manifest: Map<string, string>
}

const taskConstraints: Readonly<Record<V3TaskID, (input: LiveTaskConstraintInput) => readonly LiveTaskConstraint[]>> = {
  "t1-read-then-edit": ({ finalText, files, manifest }) => {
    const original = manifest.get("config/settings.ini") ?? ""
    const expected = original.replace("retries = 3", "retries = 7")
    const finalWord = (manifest.get("filler/f02.txt") ?? "").trim().split(/\s+/).at(-1) ?? ""
    const escaped = finalWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return [
      { name: "settings-final-exact", pass: files.get("config/settings.ini") === expected },
      { name: "answer-retries-7", pass: /retr(y|ies)\D{0,30}7\b/i.test(finalText) },
      { name: "answer-f02-lastword", pass: finalWord.length > 0 && new RegExp(`\\b${escaped}\\b`).test(finalText) },
    ]
  },
  "t2-repeated-search": ({ finalText, manifest }) => {
    const needle7Count = [...manifest.values()].reduce(
      (total, body) => total + (body.match(/NEEDLE-7/g)?.length ?? 0),
      0,
    )
    const needle3Files = [...manifest.entries()].flatMap(([file, body]) => (body.includes("NEEDLE-3") ? [file] : []))
    const needle3File = needle3Files.length === 1 ? needle3Files[0]! : ""
    const answer = /^\s*NEEDLE-7\s+count\s*=\s*(\d+)\s*;\s*NEEDLE-3\s+file\s*=\s*([^\s;]+)\s*$/i.exec(finalText)
    return [
      {
        name: "answer-needle7-count",
        pass: answer !== null && Number(answer[1]) === needle7Count,
      },
      {
        name: "answer-needle3-file",
        pass: needle3File.length > 0 && answer !== null && answer[2] === needle3File,
      },
    ]
  },
  "t3-aba": ({ finalText, files, manifest }) => [
    { name: "version-restored-exact", pass: files.get("app/version.txt") === manifest.get("app/version.txt") },
    {
      name: "backup-intact",
      pass: files.get("backup/version.orig.txt") === manifest.get("backup/version.orig.txt"),
    },
    { name: "answer-alpha", pass: /alpha/i.test(finalText) },
  ],
  "t4-return-earlier": ({ finalText, manifest }) => {
    const p2Lines = [...manifest.entries()]
      .filter(([file]) => file.startsWith("p2/"))
      .reduce((total, [, body]) => total + body.split("\n").length, 0)
    return [
      { name: "answer-gate-code", pass: finalText.includes("5521") },
      { name: "answer-p2-lines", pass: new RegExp(`\\b${p2Lines}\\b`).test(finalText) },
    ]
  },
}

export function validateTaskAnswer(id: V3TaskID, input: LiveTaskConstraintInput) {
  return taskConstraints[id](input)
}

export function validateTaskTrajectory(input: { id: V3TaskID; directory: string; history: unknown[] }) {
  const spec = V3_TASKS[input.id]
  const turns = taskTurns(input.history)
  const failures: string[] = []
  const extraCalls: Array<{ turn: number; callID: string; tool: string; key: string | null; status: string }> = []
  if (turns.length !== spec.prompts.length) failures.push("prompt-turn-count-mismatch")
  for (let index = 0; index < spec.prompts.length; index++) {
    const turn = turns[index]
    const prompt = spec.prompts[index]
    if (!turn || !prompt || turn.prompt !== prompt.text) {
      failures.push(`turn-${index + 1}-prompt-mismatch`)
      continue
    }
    const expectedGroups = prompt.groups.map((group) => group.map(expectedToolKey))
    const expectedKeys = expectedGroups.flat()
    const observed = turn.tools.map((tool) => ({ tool, key: observedToolKey(tool, input.directory) }))
    const observedRequired = observed.flatMap(({ key }) => (key && expectedKeys.includes(key) ? [key] : []))
    for (const key of expectedKeys) {
      const count = observedRequired.filter((item) => item === key).length
      if (count !== 1) failures.push(`turn-${index + 1}-${key}-count-${count}`)
    }
    const groupSteps = expectedGroups.map((group, groupIndex) => {
      const steps = new Set(observed.flatMap(({ tool, key }) => (key && group.includes(key) ? [tool.step] : [])))
      if (steps.size !== 1) failures.push(`turn-${index + 1}-group-${groupIndex + 1}-step-mismatch`)
      return steps.size === 1 ? [...steps][0] : undefined
    })
    for (let groupIndex = 1; groupIndex < groupSteps.length; groupIndex++) {
      const previous = groupSteps[groupIndex - 1]
      const current = groupSteps[groupIndex]
      if (previous !== undefined && current !== undefined && current <= previous)
        failures.push(`turn-${index + 1}-group-order-mismatch`)
    }
    for (const item of observed) {
      if (!item.key || !expectedKeys.includes(item.key)) {
        extraCalls.push({
          turn: index + 1,
          callID: item.tool.callID,
          tool: item.tool.tool,
          key: item.key ?? null,
          status: item.tool.status,
        })
      }
      if (item.key?.startsWith("read:") && (item.tool.status !== "completed" || item.tool.truncated !== false))
        failures.push(`turn-${index + 1}-${item.key}-not-complete`)
    }
  }

  const allTools = turns.flatMap((turn) => turn.tools)
  if (input.id === "t1-read-then-edit") {
    const edit = allTools.find((tool) => observedToolKey(tool, input.directory) === "edit:config/settings.ini")
    if (edit?.input.oldString !== "retries = 3" || edit.input.newString !== "retries = 7")
      failures.push("t1-edit-transform-mismatch")
  }
  if (input.id === "t2-repeated-search") {
    const greps = allTools.filter((tool) => tool.tool === "grep")
    if (
      greps.length !== 2 ||
      greps.some(
        (tool) => tool.input.pattern !== "NEEDLE-7" || relativeToolPath(input.directory, tool.input.path) !== "src",
      )
    )
      failures.push("t2-grep-pair-mismatch")
  }
  if (input.id === "t3-aba") {
    const versionReads = allTools.filter(
      (tool) => observedToolKey(tool, input.directory) === "read:app/version.txt" && tool.status === "completed",
    )
    if (
      versionReads.length !== 3 ||
      !versionReads[0]?.output.includes("release = alpha") ||
      !versionReads[1]?.output.includes("release = beta") ||
      !versionReads[2]?.output.includes("release = alpha")
    )
      failures.push("t3-version-read-aba-mismatch")
    const edit = allTools.find((tool) => observedToolKey(tool, input.directory) === "edit:app/version.txt")
    if (edit?.input.oldString !== "release = alpha" || edit.input.newString !== "release = beta")
      failures.push("t3-edit-transform-mismatch")
  }
  return {
    pass: failures.length === 0,
    failures,
    extraCalls,
    expectedProviderRequests: spec.expectedProviderRequests,
    turns: turns.map((turn) => ({ steps: turn.steps, toolCalls: turn.tools.length })),
  }
}

export function validateLiveAnswerAttribution(id: V3TaskID, finalText: string, manifest: Map<string, string>) {
  if (id !== "t1-read-then-edit") return { name: "live-answer-attribution", pass: true, detail: "not-t1" }
  const expected = (manifest.get("filler/f02.txt") ?? "").trim().split(/\s+/).at(-1) ?? ""
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const labelled = new RegExp(
    `(?:f02(?:\\.txt)?(?:\\s+last\\s+word)?|last\\s+word(?:\\s+of\\s+f02(?:\\.txt)?)?)\\s*[:=]\\s*${escaped}\\b`,
    "i",
  )
  const ordered = new RegExp(`^\\s*retries\\s*=\\s*7\\s*;\\s*${escaped}\\s*$`, "i")
  const pass = expected.length > 0 && finalText.split(/\r?\n/).some((line) => labelled.test(line) || ordered.test(line))
  return { name: "live-answer-attribution", pass, detail: `expected-f02-word-sha256=${sha256(expected)}` }
}

function hasCompactionPart(input: unknown[]) {
  return input.some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message.parts) &&
      message.parts.some((part) => isRecord(part) && part.type === "compaction"),
  )
}

function hostUsage(input: unknown[], model: { providerID: string; modelID: string }) {
  const rows = input.flatMap((message) => {
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant") return []
    const info = message.info
    const providerID =
      typeof info.providerID === "string" ? info.providerID : isRecord(info.model) ? info.model.providerID : undefined
    const modelID =
      typeof info.modelID === "string" ? info.modelID : isRecord(info.model) ? info.model.modelID : undefined
    if (providerID !== model.providerID || modelID !== model.modelID || !isRecord(info.tokens)) return []
    const cache = isRecord(info.tokens.cache) ? info.tokens.cache : undefined
    return [
      {
        input: finiteUsage(info.tokens.input),
        output: finiteUsage(info.tokens.output),
        reasoning: finiteUsage(info.tokens.reasoning),
        cacheRead: finiteUsage(cache?.read),
        cacheWrite: finiteUsage(cache?.write),
      },
    ]
  })
  const sum = (key: keyof ProviderUsage): UsageValue => {
    const values = rows.map((row) => row[key])
    return values.length > 0 && values.every((value): value is number => typeof value === "number")
      ? values.reduce((total, value) => total + value, 0)
      : "unavailable"
  }
  return {
    requestsWithHostUsage: rows.length,
    input: sum("input"),
    output: sum("output"),
    reasoning: sum("reasoning"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
  }
}

function outboundToolResults(body: Uint8Array) {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
  const outbound = unwrapRecord(parsed, "provider request")
  const rows = Array.isArray(outbound.messages) ? outbound.messages : []
  const results = new Map<string, string>()
  for (const row of rows) {
    if (
      !isRecord(row) ||
      row.role !== "tool" ||
      typeof row.tool_call_id !== "string" ||
      typeof row.content !== "string"
    )
      continue
    if (results.has(row.tool_call_id)) throw new DriverFailure("duplicate-outbound-tool-call-id")
    results.set(row.tool_call_id, row.content)
  }
  return { outbound, results }
}

export function verifyOutboundIntegrity(input: {
  arm: LiveArm
  body: Uint8Array
  history: unknown[]
  requireFold: boolean
}) {
  const { outbound, results } = outboundToolResults(input.body)
  const stored = completedTools(input.history)
  const byCall = new Map<string, (typeof stored)[number]>()
  for (const item of stored) {
    if (byCall.has(item.callID)) throw new DriverFailure("duplicate-stored-tool-call-id")
    byCall.set(item.callID, item)
  }
  let folded = 0
  for (const [callID, content] of results) {
    const expected = byCall.get(callID)
    if (!expected) throw new DriverFailure("outbound-tool-call-id-missing-from-stored-history")
    if (content.startsWith("[Duplicate tool output folded.")) {
      folded++
      if (input.arm !== "enabled") throw new DriverFailure("disabled-outbound-folded")
      const witnessID = [...results.keys()].find((candidate) => candidate !== callID && content.includes(candidate))
      const witness = witnessID ? byCall.get(witnessID) : undefined
      if (!witnessID || !witness || results.get(witnessID) !== witness.output)
        throw new DriverFailure("outbound-witness-not-byte-exact")
      if (
        expected.tool !== witness.tool ||
        stable(expected.input) !== stable(witness.input) ||
        expected.output !== witness.output
      )
        throw new DriverFailure("outbound-source-witness-identity-mismatch")
    } else if (content !== expected.output) {
      throw new DriverFailure("outbound-tool-result-mutated")
    }
  }
  if (input.requireFold && folded === 0) throw new DriverFailure("enabled-outbound-has-no-fold")
  if (input.arm === "disabled" && folded !== 0) throw new DriverFailure("disabled-outbound-folded")
  return {
    foldedSources: folded,
    storedToolResults: stored.length,
    outboundToolResults: results.size,
    requestBodySha256: sha256(input.body),
    requestBodyBytes: input.body.byteLength,
    outboundShapeSha256: sha256(
      stable({ keys: Object.keys(outbound).sort(), messages: Array.isArray(outbound.messages) }),
    ),
  }
}

async function resolvedModelProof(host: HostHandle, config: PrivateConfig, directory: string, arm: LiveArm) {
  const providerResponse = await api({ host, config, directory, route: "/provider" })
  const providerList = unwrapRecord(providerResponse, "provider.list")
  const all = Array.isArray(providerList.all) ? providerList.all : []
  const provider = all.find((item) => isRecord(item) && item.id === config.realModel.providerID)
  if (!isRecord(provider) || !isRecord(provider.models)) throw new DriverFailure("real-model-not-resolved")
  const model = provider.models[config.realModel.modelID]
  if (!isRecord(model) || !isRecord(model.limit)) throw new DriverFailure("real-model-not-resolved")
  if (model.limit.context !== EXPECTED_CONTEXT || model.limit.output !== EXPECTED_OUTPUT)
    throw new DriverFailure("resolved-model-window-mismatch")

  const configResponse = await api({ host, config, directory, route: "/config" })
  const hostConfig = unwrapRecord(configResponse, "config.get")
  const compaction = isRecord(hostConfig.compaction) ? hostConfig.compaction : undefined
  if (!compaction || compaction.auto !== true || compaction.dynamic !== (arm === "enabled"))
    throw new DriverFailure("resolved-compaction-config-mismatch")

  const modelProjection = {
    providerID: config.realModel.providerID,
    modelID: config.realModel.modelID,
    context: model.limit.context,
    output: model.limit.output,
    apiNpm: isRecord(model.api) && typeof model.api.npm === "string" ? model.api.npm : "unknown",
    capabilities: isRecord(model.capabilities) ? model.capabilities : {},
  }
  return {
    context: EXPECTED_CONTEXT as const,
    outputReserve: EXPECTED_OUTPUT as const,
    modelIdentitySha256: sha256(stable(config.realModel)),
    modelConfigSha256: sha256(stable(modelProjection)),
  }
}

function logField(line: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = line.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|([^\\s]+))`))
  return match?.[1] ?? match?.[2]
}

async function assessDiagnostics(host: HostHandle, arm: LiveArm) {
  const raw = `${await readFile(host.stdoutPath, "utf8")}\n${await readFile(host.stderrPath, "utf8")}`
  const diagnostics = raw
    .split(/\r?\n/)
    .filter((line) => line.includes('message="context folding"'))
    .map((line) => ({
      purpose: logField(line, "requestPurpose"),
      enabled: logField(line, "enabled"),
      applied: logField(line, "applied"),
      foldedOutputs: logField(line, "foldedOutputs"),
      targetTokens: logField(line, "targetTokens"),
      skipReason: logField(line, "skipReason"),
      externalDcp: logField(line, "externalDcp"),
    }))
  const conversation = diagnostics.filter((entry) => entry.purpose === "conversation")
  if (conversation.length === 0) throw new DriverFailure("folding-diagnostic-missing")
  if (diagnostics.some((entry) => entry.purpose === "compaction"))
    throw new DriverFailure("automatic-compaction-preceded-sample")
  if (diagnostics.some((entry) => entry.externalDcp === "active" || entry.externalDcp === "loaded"))
    throw new DriverFailure("external-dcp-active")
  if (arm === "enabled") {
    if (conversation.some((entry) => entry.enabled !== "true" || entry.targetTokens !== String(EXPECTED_TARGET)))
      throw new DriverFailure("enabled-diagnostic-window-or-state-mismatch")
    if (!conversation.some((entry) => entry.applied === "true" && Number(entry.foldedOutputs) > 0))
      throw new DriverFailure("enabled-diagnostic-has-no-positive-fold")
  } else {
    if (
      conversation.some(
        (entry) =>
          entry.enabled !== "false" ||
          entry.applied !== "false" ||
          Number(entry.foldedOutputs) !== 0 ||
          entry.targetTokens !== "unknown" ||
          entry.skipReason !== "disabled",
      )
    )
      throw new DriverFailure("disabled-diagnostic-mismatch")
  }
  return {
    conversation: conversation.length,
    compaction: 0,
    positive: conversation.filter((entry) => entry.applied === "true" && Number(entry.foldedOutputs) > 0).length,
    targetObservation: arm === "enabled" ? EXPECTED_TARGET : "unavailable-budget-disabled",
    requestPreparationDurationMs: "unavailable-host-diagnostic-does-not-emit-duration",
  }
}

async function seedPreflightWorkspace(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await Promise.all(
    preflightFiles.map((file, index) => privateWrite(path.join(directory, file), `${preflightContents[index]}\n`)),
  )
}

const taskID = (task: NonNullable<LiveRunPlan["task"]>): V3TaskID =>
  ({ T1: "t1-read-then-edit", T2: "t2-repeated-search", T3: "t3-aba", T4: "t4-return-earlier" })[task]

async function seedTaskWorkspace(directory: string, id: V3TaskID) {
  const manifest = materializeBodiesV3(id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [file, body] of manifest) await privateWrite(path.join(directory, file), body)
  return manifest
}

export async function inspectWorkspace(directory: string, expectedFiles: Iterable<string>) {
  const files = new Map<string, string>()
  const unexpectedEntries: string[] = []
  const expectedDirectories = new Set<string>()
  for (const file of expectedFiles) {
    let current = path.posix.dirname(file.split(path.sep).join("/"))
    while (current !== ".") {
      expectedDirectories.add(current)
      current = path.posix.dirname(current)
    }
  }
  const walk = async (current: string, relativeDirectory = "") => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = path.posix.join(relativeDirectory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        unexpectedEntries.push(`symlink:${relative}`)
      } else if (info.isDirectory()) {
        if (!expectedDirectories.has(relative)) unexpectedEntries.push(`directory:${relative}`)
        else await walk(absolute, relative)
      } else if (info.isFile()) {
        files.set(relative, await readFile(absolute, "utf8"))
      } else {
        unexpectedEntries.push(`special:${relative}`)
      }
    }
  }
  await walk(directory)
  return { files, unexpectedEntries: unexpectedEntries.sort() }
}

async function privateArtifactInventory(outputDir: string) {
  const items: Array<{ logicalName: string; bytes: number; sha256: string }> = []
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(outputDir, absolute)
      if (
        relative === "workspace" ||
        relative.startsWith(`workspace${path.sep}`) ||
        relative === "host-isolation" ||
        relative.startsWith(`host-isolation${path.sep}`) ||
        relative === "result.json"
      )
        continue
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer())
        items.push({ logicalName: relative.split(path.sep).join("/"), bytes: bytes.byteLength, sha256: sha256(bytes) })
      }
    }
  }
  await walk(outputDir)
  return items.sort((left, right) => left.logicalName.localeCompare(right.logicalName))
}

function unchangedExisting(before: unknown[], after: unknown[]) {
  const normalized = normalizedMessages(before)
  const ids = new Set(
    normalized.flatMap((message) =>
      isRecord(message) && isRecord(message.info) && typeof message.info.id === "string" ? [message.info.id] : [],
    ),
  )
  const afterExisting = normalizedMessages(after, ids)
  return {
    beforeSha256: sha256(stable(normalized)),
    afterSha256: sha256(stable(afterExisting)),
    intact: stable(normalized) === stable(afterExisting),
  }
}

async function runPreflight(input: {
  plan: LiveRunPlan
  host: HostHandle
  config: PrivateConfig
  directory: string
  guard: ProviderRequestGuard
  proxy: ProviderProxy
  seeder: ReturnType<typeof startLocalSeeder>
  runDeadline: number
  outputDir: string
  beforeExternal: () => Promise<void>
}) {
  const remaining = () => {
    const value = input.runDeadline - Date.now()
    if (value <= 0) throw new DriverFailure("task-run-timeout")
    return value
  }
  await seedPreflightWorkspace(input.directory)
  remaining()
  const sessionID = await createSession(input.host, input.config, input.directory)
  const localGuard = new ProviderRequestGuard(64)
  let round = 1
  await recordedPrompt({
    ...input,
    sessionID,
    model: input.config.realModel,
    text: "collect the deterministic S09 H0 duplicate reads",
    guard: localGuard,
    timeoutMs: Math.min(TURN_TIMEOUT_MS, remaining()),
    round: round++,
    artifactsDir: path.join(input.outputDir, "rounds"),
  })
  for (let index = 0; index < preflightRecent.length; index++) {
    await recordedPrompt({
      ...input,
      sessionID,
      model: input.config.realModel,
      text: `preserve recent S09 H0 turn ${index}`,
      guard: localGuard,
      timeoutMs: Math.min(TURN_TIMEOUT_MS, remaining()),
      round: round++,
      artifactsDir: path.join(input.outputDir, "rounds"),
    })
  }
  if (input.seeder.calls !== 6 || input.proxy.preArmCalls !== 6)
    throw new DriverFailure("local-seeder-call-count-mismatch")
  await input.beforeExternal()
  input.guard.arm()
  const turnStarted = Date.now()
  const measured = await recordedPrompt({
    ...input,
    sessionID,
    model: input.config.realModel,
    text: "Reply with exactly: S09-PREFLIGHT-OK",
    guard: input.guard,
    timeoutMs: Math.min(TURN_TIMEOUT_MS, remaining()),
    round,
    artifactsDir: path.join(input.outputDir, "rounds"),
  })
  const { before, response, after } = measured
  if (Date.now() - turnStarted > TURN_TIMEOUT_MS) throw new DriverFailure("turn-timeout")
  remaining()
  const original = unchangedExisting(before, after)
  if (!original.intact) throw new DriverFailure("stored-history-mutated")
  if (hasCompactionPart(after)) throw new DriverFailure("automatic-compaction-part-present")
  if (!messageText(response).includes("S09-PREFLIGHT-OK")) throw new DriverFailure("preflight-quality-failed")
  if (input.proxy.bodies.length !== 1) throw new DriverFailure("preflight-provider-request-count-mismatch")
  const outbound = verifyOutboundIntegrity({
    arm: input.plan.arm,
    body: input.proxy.bodies[0]!,
    history: after,
    requireFold: input.plan.arm === "enabled",
  })
  const wire = new TextDecoder().decode(input.proxy.bodies[0])
  if (!preflightRecent.every((text) => wire.includes(text))) throw new DriverFailure("protected-recent-content-mutated")
  return {
    quality: { pass: true, finalTextSha256: sha256(messageText(response)) },
    history: original,
    outbound,
    providerRequests: input.guard.count,
    hostUsage: hostUsage(after, input.config.realModel),
  }
}

async function runTask(input: {
  plan: LiveRunPlan
  host: HostHandle
  config: PrivateConfig
  directory: string
  guard: ProviderRequestGuard
  proxy: ProviderProxy
  runDeadline: number
  outputDir: string
}) {
  if (!input.plan.task) throw new DriverFailure("task-plan-missing-task")
  const id = taskID(input.plan.task)
  const spec = V3_TASKS[id]
  const manifest = await seedTaskWorkspace(input.directory, id)
  const sessionID = await createSession(input.host, input.config, input.directory)
  const historyChecks: ReturnType<typeof unchangedExisting>[] = []
  const responses: unknown[] = []
  for (let round = 0; round < spec.prompts.length; round++) {
    const text = spec.prompts[round]!.text
    const remaining = input.runDeadline - Date.now()
    if (remaining <= 0) throw new DriverFailure("task-run-timeout")
    const turnStarted = Date.now()
    const measured = await recordedPrompt({
      ...input,
      sessionID,
      model: input.config.realModel,
      text,
      guard: input.guard,
      timeoutMs: Math.min(TURN_TIMEOUT_MS, remaining),
      round: round + 1,
      artifactsDir: path.join(input.outputDir, "rounds"),
    })
    const { before, response, after } = measured
    responses.push(response)
    if (Date.now() - turnStarted > TURN_TIMEOUT_MS) throw new DriverFailure("turn-timeout")
    const check = unchangedExisting(before, after)
    if (!check.intact) throw new DriverFailure("stored-history-mutated")
    historyChecks.push(check)
  }
  const history = await messages(input.host, input.config, input.directory, sessionID)
  if (Date.now() > input.runDeadline) throw new DriverFailure("task-run-timeout")
  if (hasCompactionPart(history)) throw new DriverFailure("automatic-compaction-part-present")
  const workspace = await inspectWorkspace(input.directory, manifest.keys())
  const files = workspace.files
  if (Date.now() > input.runDeadline) throw new DriverFailure("task-run-timeout")
  const finalText = messageText(responses.at(-1))
  const constraints = [
    ...validateTaskAnswer(id, { finalText, files, manifest }),
    validateLiveAnswerAttribution(id, finalText, manifest),
  ]
  const trajectory = validateTaskTrajectory({ id, directory: input.directory, history })
  const unexpectedChanges = [...manifest].flatMap(([file, original]) =>
    files.get(file) !== original && !spec.allowedChanges.includes(file) ? [file] : [],
  )
  const unexpectedFiles = [...files.keys()].filter((file) => !manifest.has(file))
  const missingFiles = [...manifest.keys()].filter((file) => !files.has(file))
  if (
    constraints.some((constraint) => !constraint.pass) ||
    unexpectedChanges.length ||
    unexpectedFiles.length ||
    missingFiles.length ||
    workspace.unexpectedEntries.length ||
    !trajectory.pass
  )
    throw new DriverFailure("external-quality-or-side-effect-failed")
  const outboundChecks = input.proxy.bodies.map((body) =>
    verifyOutboundIntegrity({ arm: input.plan.arm, body, history, requireFold: false }),
  )
  if (input.plan.arm === "enabled" && !outboundChecks.some((check) => check.foldedSources > 0))
    throw new DriverFailure("enabled-outbound-has-no-fold")
  if (input.guard.count < 1 || input.guard.count > input.plan.maxProviderRequests)
    throw new DriverFailure("task-provider-request-count-mismatch")
  return {
    quality: {
      pass: true,
      constraints: constraints.map((constraint) => ({ name: constraint.name, pass: constraint.pass })),
      finalTextSha256: sha256(finalText),
      manifestSha256: sha256(stable([...manifest])),
      finalWorkspaceSha256: sha256(stable([...files].sort(([left], [right]) => left.localeCompare(right)))),
      unexpectedChanges: 0,
      unexpectedFiles: 0,
      missingFiles: 0,
      unexpectedEntries: 0,
      trajectory,
      providerRequestPlan: {
        expectedScripted: spec.expectedProviderRequests,
        observed: input.guard.count,
        delta: input.guard.count - spec.expectedProviderRequests,
      },
    },
    history: { turns: historyChecks, intact: historyChecks.every((check) => check.intact) },
    outbound: outboundChecks,
    providerRequests: input.guard.count,
    hostUsage: hostUsage(history, input.config.realModel),
  }
}

async function observedAutomaticCompaction(host: HostHandle | undefined) {
  if (!host) return false
  try {
    const raw = `${await readFile(host.stdoutPath, "utf8")}\n${await readFile(host.stderrPath, "utf8")}`
    return raw.includes("agent=compaction")
  } catch {
    return false
  }
}

export function oneRequestPreflightOverflowEvidence(input: {
  plan: LiveRunPlan
  context: number
  outputReserve: number
  response: ProviderResponseEvidence | undefined
  usage: ProviderUsage | undefined
  guard: { maximum: number; count: number; closedReason: string | undefined }
  automaticCompactionObserved: boolean
}): LiveRunFailureEvidence | undefined {
  if (input.plan.kind !== "one-request-preflight" || input.plan.maxProviderRequests !== 1) return undefined
  const usableContext = input.context - input.outputReserve
  if (
    !input.response ||
    !input.usage ||
    typeof input.usage.input !== "number" ||
    input.response.status < 200 ||
    input.response.status >= 300 ||
    input.response.completion !== "normal-stop" ||
    input.usage.input <= usableContext ||
    input.guard.maximum !== 1 ||
    input.guard.count !== 1 ||
    input.guard.closedReason !== "provider-request-cap" ||
    !input.automaticCompactionObserved
  )
    return undefined

  return {
    schemaVersion: 1,
    pattern: "upstream-normal-completion-provider-usage-over-usable-context-auto-compaction-blocked",
    upstream: {
      httpStatus: input.response.status,
      completion: input.response.completion,
      usage: input.usage,
    },
    resolvedWindow: {
      context: input.context,
      outputReserve: input.outputReserve,
      usableContext,
      inputOverageTokens: input.usage.input - usableContext,
    },
    autoCompaction: {
      observed: true,
      source: "host-log-agent-compaction",
    },
    providerGuard: {
      maximum: input.guard.maximum,
      forwardedRequests: input.guard.count,
      closedReason: "provider-request-cap",
      blockedAdditionalRequest: true,
    },
  }
}

export function providerNon2xxEvidence(input: {
  response: ProviderResponseEvidence | undefined
  ordinal: number
  guard: { maximum: number; count: number; closedReason: string | undefined }
}): ProviderNon2xxEvidence | undefined {
  if (
    !input.response ||
    input.response.status < 400 ||
    input.ordinal !== input.guard.count ||
    input.guard.closedReason !== `provider-http-${input.response.status}`
  )
    return undefined
  return {
    schemaVersion: 1,
    pattern: "upstream-non-2xx-guard-closed",
    upstream: input.response,
    providerGuard: {
      maximum: input.guard.maximum,
      forwardedRequests: input.guard.count,
      closedReason: input.guard.closedReason,
      additionalForwardingBlocked: true,
    },
  }
}

export function providerNon2xxFailure(input: {
  responses: ProviderResponseEvidence[]
  guard: { maximum: number; count: number; closedReason: string | undefined }
}) {
  const evidence = input.responses
    .map((response, index) => providerNon2xxEvidence({ response, ordinal: index + 1, guard: input.guard }))
    .find((candidate) => candidate !== undefined)
  if (!evidence) return undefined
  return new DriverFailure(
    `provider-upstream-http-${evidence.upstream.status}`,
    `a forwarded provider request returned HTTP ${evidence.upstream.status}; the guard blocked all later forwarding`,
    evidence,
  )
}

async function classifyLiveRunFailure(input: {
  error: unknown
  plan: LiveRunPlan
  proof: Awaited<ReturnType<typeof resolvedModelProof>> | undefined
  proxy: ProviderProxy
  guard: ProviderRequestGuard
  host: HostHandle | undefined
}) {
  if (input.error instanceof DriverFailure && input.error.evidence) return input.error
  const non2xx = providerNon2xxFailure({ responses: input.proxy.responses, guard: input.guard })
  if (non2xx) return non2xx
  if (input.plan.kind !== "one-request-preflight" || input.plan.maxProviderRequests !== 1) return input.error
  const ordinal = input.proxy.responses.length - 1
  if (!input.proof) return input.error
  const evidence = oneRequestPreflightOverflowEvidence({
    plan: input.plan,
    context: input.proof.context,
    outputReserve: input.proof.outputReserve,
    response: input.proxy.responses[ordinal],
    usage: input.proxy.usages[ordinal],
    guard: input.guard,
    automaticCompactionObserved: await observedAutomaticCompaction(input.host),
  })
  if (!evidence) return input.error

  return new DriverFailure(
    "provider-usage-exceeded-usable-context-auto-compaction-blocked",
    "upstream completed normally, provider input usage exceeded usable context, and automatic compaction was blocked by the request guard",
    evidence,
  )
}

function failureCode(error: unknown) {
  if (error instanceof DriverFailure) return error.code
  if (error instanceof Error && error.message.includes("provider request hard cap")) return "provider-request-cap"
  if (error instanceof Error && error.message.includes("prompt exceeded")) return "turn-timeout"
  return "unclassified-live-run-failure"
}

export function failureArtifact(run: number, error: unknown) {
  const artifact: {
    schemaVersion: 1
    run: number
    code: string
    evidence?: LiveRunFailureEvidence
  } = {
    schemaVersion: 1,
    run,
    code: failureCode(error),
  }
  if (error instanceof DriverFailure && error.evidence) artifact.evidence = error.evidence
  return artifact
}

async function verifyFreeze(input: {
  config: PrivateConfig
  authorization: Authorization
  freezeManifestPath: string
  taskSpecPath: string
  run: number
}) {
  if (
    input.authorization.candidateSha !== input.config.candidateSha ||
    input.authorization.freezeManifestSha256 !== input.config.freezeManifestSha256 ||
    !input.authorization.approvedRuns.includes(input.run)
  )
    throw new DriverFailure("authorization-does-not-bind-run")
  if ((await sha256File(input.freezeManifestPath)) !== input.config.freezeManifestSha256)
    throw new DriverFailure("freeze-manifest-hash-mismatch")
  if ((await sha256File(input.taskSpecPath)) !== input.config.taskSpecSha256)
    throw new DriverFailure("task-spec-hash-mismatch")
  const manifest: unknown = JSON.parse(await readFile(input.freezeManifestPath, "utf8"))
  if (!isRecord(manifest) || manifest.candidateSha !== input.config.candidateSha || manifest.dirtyStatus !== "clean")
    throw new DriverFailure("freeze-manifest-candidate-mismatch")
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: input.config.host.cwd })
  const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: input.config.host.cwd })
  if (head.exitCode !== 0 || new TextDecoder().decode(head.stdout).trim() !== input.config.candidateSha)
    throw new DriverFailure("candidate-head-mismatch")
  if (statusResult.exitCode !== 0 || new TextDecoder().decode(statusResult.stdout).trim() !== "")
    throw new DriverFailure("candidate-worktree-not-clean")
}

async function assertPriorBindings(
  ledgerPath: string,
  plan: LiveRunPlan,
  proof: Awaited<ReturnType<typeof resolvedModelProof>>,
) {
  const ledger = await readPrivateRunLedger(ledgerPath)
  if (
    ledger.continuation.sourceModelIdentitySha256 !== proof.modelIdentitySha256 ||
    ledger.continuation.sourceModelConfigSha256 !== proof.modelConfigSha256 ||
    ledger.continuation.sourceContext !== proof.context ||
    ledger.continuation.sourceOutputReserve !== proof.outputReserve
  )
    throw new DriverFailure("cross-continuation-model-config-mismatch")
  const prior = ledger.runs.filter((entry) => entry.run < plan.run && entry.state === "pass")
  for (const entry of prior) {
    if (
      !entry.evidence ||
      entry.evidence.modelIdentitySha256 !== proof.modelIdentitySha256 ||
      entry.evidence.modelConfigSha256 !== proof.modelConfigSha256 ||
      entry.evidence.context !== proof.context ||
      entry.evidence.outputReserve !== proof.outputReserve
    )
      throw new DriverFailure("cross-run-model-config-mismatch")
  }
}

async function writePairedWindowProof(input: {
  ledgerPath: string
  outputDir: string
  plan: LiveRunPlan
  proof: Awaited<ReturnType<typeof resolvedModelProof>>
  hostResolvedEvidenceSha256: string
}) {
  const ledger = await readPrivateRunLedger(input.ledgerPath)
  const counterpart = ledger.runs.find(
    (entry) =>
      entry.run < input.plan.run &&
      entry.state === "pass" &&
      entry.arm !== input.plan.arm &&
      (input.plan.kind === "one-request-preflight"
        ? entry.kind === "one-request-preflight"
        : entry.kind === "task" && entry.task === input.plan.task),
  )
  if (!counterpart?.evidence) return { status: "pending-counterpart" as const }
  if (
    counterpart.evidence.modelIdentitySha256 !== input.proof.modelIdentitySha256 ||
    counterpart.evidence.modelConfigSha256 !== input.proof.modelConfigSha256 ||
    counterpart.evidence.context !== input.proof.context ||
    counterpart.evidence.outputReserve !== input.proof.outputReserve
  )
    throw new DriverFailure("paired-model-config-mismatch")

  const current = {
    run: input.plan.run,
    arm: input.plan.arm,
    hostResolvedEvidenceSha256: input.hostResolvedEvidenceSha256,
  }
  const prior = {
    run: counterpart.run,
    arm: counterpart.arm,
    hostResolvedEvidenceSha256: counterpart.evidence.hostResolvedEvidenceSha256,
  }
  const pairEvidence = {
    schemaVersion: 1,
    source: "paired-live-host-resolved-model-evidence",
    runs: [prior, current].sort((left, right) => left.run - right.run),
  }
  const pairEvidenceContents = `${JSON.stringify(pairEvidence, null, 2)}\n`
  const pairEvidencePath = path.join(input.outputDir, "paired-host-model-evidence.json")
  await privateWrite(pairEvidencePath, pairEvidenceContents)
  const sourceEvidenceSha256 = sha256(pairEvidenceContents)
  const armProof = {
    context: input.proof.context,
    outputReserve: input.proof.outputReserve,
    modelConfigSha256: input.proof.modelConfigSha256,
  }
  const windowProof = {
    schemaVersion: 1,
    evidenceLevel: "live-host",
    source: "host-resolved-model-config",
    sourceEvidenceSha256,
    arms: { enabled: armProof, disabled: armProof },
  }
  const windowProofContents = `${JSON.stringify(windowProof, null, 2)}\n`
  await privateWrite(path.join(input.outputDir, "paired-window-proof.json"), windowProofContents)
  return {
    status: "complete" as const,
    counterpartRun: counterpart.run,
    sourceEvidenceSha256,
    windowProofSha256: sha256(windowProofContents),
  }
}

export async function executeLiveRun(input: {
  config: PrivateConfig
  ledgerPath: string
  outputRoot: string
  plan: LiveRunPlan
  beforeExternal?: () => Promise<void>
}) {
  const runStarted = Date.now()
  const runDeadline = runStarted + RUN_TIMEOUT_MS
  const outputDir = path.join(input.outputRoot, `run-${input.plan.run}`)
  await mkdir(outputDir, { recursive: false, mode: 0o700 })
  const workspace = path.join(outputDir, "workspace")
  const guard = new ProviderRequestGuard(input.plan.maxProviderRequests, input.plan.kind === "task")
  const seeder = input.plan.kind === "one-request-preflight" ? startLocalSeeder(workspace) : undefined
  const proxy = startProviderProxy({
    guard,
    upstream: input.config.upstream,
    ...(seeder ? { preArmUpstream: { baseUrl: seeder.url, headers: {} } } : {}),
    captureDir: path.join(outputDir, "captures"),
  })
  let host: HostHandle | undefined
  let result: unknown
  let proof: Awaited<ReturnType<typeof resolvedModelProof>> | undefined
  let hostResolvedEvidenceSha256: string | undefined
  let pairedWindowProof: Awaited<ReturnType<typeof writePairedWindowProof>> | undefined
  let primaryError: unknown
  try {
    host = await startHost({
      config: input.config,
      arm: input.plan.arm,
      guardUrl: proxy.url,
      outputDir,
    })
    proof = await resolvedModelProof(host, input.config, workspace, input.plan.arm)
    const hostResolvedEvidence = {
      schemaVersion: 1,
      source: "live-host-provider-and-config-http",
      candidateSha: input.config.candidateSha,
      freezeManifestSha256: input.config.freezeManifestSha256,
      run: input.plan.run,
      arm: input.plan.arm,
      foldingEnabled: input.plan.arm === "enabled",
      context: proof.context,
      outputReserve: proof.outputReserve,
      modelIdentitySha256: proof.modelIdentitySha256,
      modelConfigSha256: proof.modelConfigSha256,
    }
    const hostResolvedContents = `${JSON.stringify(hostResolvedEvidence, null, 2)}\n`
    await privateWrite(path.join(outputDir, "host-resolved-model-evidence.json"), hostResolvedContents)
    hostResolvedEvidenceSha256 = sha256(hostResolvedContents)
    await assertPriorBindings(input.ledgerPath, input.plan, proof)
    pairedWindowProof = await writePairedWindowProof({
      ledgerPath: input.ledgerPath,
      outputDir,
      plan: input.plan,
      proof,
      hostResolvedEvidenceSha256,
    })
    if (input.plan.kind === "one-request-preflight") {
      if (!seeder) throw new DriverFailure("local-seeder-missing")
      result = await runPreflight({
        ...input,
        host,
        directory: workspace,
        guard,
        proxy,
        seeder,
        runDeadline,
        outputDir,
        beforeExternal: input.beforeExternal ?? (async () => undefined),
      })
    } else {
      result = await runTask({ ...input, host, directory: workspace, guard, proxy, runDeadline, outputDir })
    }
  } catch (error) {
    primaryError = error
  }
  if (primaryError === undefined && guard.closed)
    primaryError = new DriverFailure(
      "provider-guard-closed-before-finalization",
      guard.closedReason ?? "provider guard closed before finalization",
    )
  guard.close("run-finalization")
  const cleanup = await Promise.allSettled([
    ...(host ? [host.stop()] : []),
    proxy.close(),
    ...(seeder ? [seeder.close()] : []),
  ])
  if (primaryError !== undefined) {
    throw await classifyLiveRunFailure({
      error: primaryError,
      plan: input.plan,
      proof,
      proxy,
      guard,
      host,
    })
  }
  const cleanupFailure = cleanup.find((item): item is PromiseRejectedResult => item.status === "rejected")
  if (cleanupFailure) {
    throw new DriverFailure("run-cleanup-failed", String(cleanupFailure.reason))
  }
  if (!host || !proof || !hostResolvedEvidenceSha256 || !pairedWindowProof || result === undefined)
    throw new DriverFailure("run-result-incomplete")
  const diagnostics = await assessDiagnostics(host, input.plan.arm)
  if (Date.now() > runDeadline) throw new DriverFailure("task-run-timeout")
  const runResult = isRecord(result) ? result : {}
  const usage = {
    hostRecorded: runResult.hostUsage ?? unavailableUsage(),
    providerReported: proxy.usages.length === 0 ? [unavailableUsage()] : proxy.usages,
  }
  const privateArtifacts = await privateArtifactInventory(outputDir)
  const summary = {
    schemaVersion: 1,
    run: input.plan.run,
    kind: input.plan.kind,
    arm: input.plan.arm,
    task: input.plan.task ?? null,
    status: "PASS",
    candidateSha: input.config.candidateSha,
    freezeManifestSha256: input.config.freezeManifestSha256,
    taskSpecSha256: input.config.taskSpecSha256,
    resolvedWindow: {
      context: proof.context,
      outputReserve: proof.outputReserve,
      targetObservation: diagnostics.targetObservation,
      modelConfigSha256: proof.modelConfigSha256,
      hostResolvedEvidenceSha256,
      pair: pairedWindowProof,
    },
    modelIdentitySha256: proof.modelIdentitySha256,
    providerRequests: guard.count,
    providerRequestMaximum: input.plan.maxProviderRequests,
    retryBudget: 0,
    wallMs: Date.now() - runStarted,
    liveHostMemory: {
      rssBaselineBytes: "unavailable-no-reliable-live-host-sampler",
      rssPeakBytes: "unavailable-no-reliable-live-host-sampler",
      rssDeltaBytes: "unavailable-no-reliable-live-host-sampler",
    },
    diagnostics,
    result,
    usage,
    providerResponses: proxy.responses,
    privateArtifacts,
  }
  const serialized = `${JSON.stringify(summary, null, 2)}\n`
  await privateWrite(path.join(outputDir, "result.json"), serialized)
  return {
    summary,
    resultSha256: sha256(serialized),
    proof,
    hostResolvedEvidenceSha256,
    providerRequests: guard.count,
  }
}

function arg(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requireArg(name: string) {
  const value = arg(name)
  if (!value) throw new DriverFailure("usage", `missing ${name}`)
  return value
}

async function main() {
  const ledgerPath = absolutePath(requireArg("--ledger"), "--ledger")
  if (process.argv.includes("--initialize-continuation-ledger")) {
    const sourceLedgerPath = absolutePath(requireArg("--source-ledger"), "--source-ledger")
    const run22FailureSummaryPath = absolutePath(requireArg("--run22-failure-summary"), "--run22-failure-summary")
    await initializePrivateRunLedger(ledgerPath, { sourceLedgerPath, run22FailureSummaryPath })
    console.log(
      JSON.stringify({
        status: "INITIALIZED_CONTINUATION",
        ceilingSessions: 28,
        historicalConsumedSessions: 22,
        authorizedNewProviderRequestLimit: 100,
        consumedNewProviderRequests: 55,
        remainingNewProviderRequests: 45,
        plannedProviderRequestMaximum: 44,
        fixedRuns: LIVE_RUN_PLAN.map((entry) => entry.run),
      }),
    )
    return
  }
  if (!process.argv.includes("--execute-live")) throw new DriverFailure("live-execution-flag-required")
  const privateConfigPath = absolutePath(requireArg("--private-config"), "--private-config")
  const authorizationPath = absolutePath(requireArg("--authorization"), "--authorization")
  const freezeManifestPath = absolutePath(requireArg("--freeze-manifest"), "--freeze-manifest")
  const outputRoot = absolutePath(requireArg("--private-output"), "--private-output")
  const run = Number(requireArg("--run"))
  const plan = LIVE_RUN_PLAN.find((entry) => entry.run === run)
  if (!plan) throw new DriverFailure("run-not-in-fixed-plan")
  const privateConfigStat = await stat(privateConfigPath)
  if (!privateConfigStat.isFile() || (privateConfigStat.mode & 0o077) !== 0)
    throw new DriverFailure("private-config-permissions-not-owner-only")
  const config = parsePrivateConfig(JSON.parse(await readFile(privateConfigPath, "utf8")))
  const authorization = parseAuthorization(JSON.parse(await readFile(authorizationPath, "utf8")))
  const taskSpecPath = path.join(path.dirname(import.meta.path), "task-spec-v3.ts")
  await verifyFreeze({ config, authorization, freezeManifestPath, taskSpecPath, run })
  await stat(ledgerPath)
  const ledgerStat = await stat(ledgerPath)
  if (!ledgerStat.isFile() || (ledgerStat.mode & 0o077) !== 0)
    throw new DriverFailure("private-ledger-permissions-not-owner-only")
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })

  // This is the durable model-session budget boundary. No host or provider
  // listener exists before this point. A crash after reservation consumes the
  // fixed run slot and a later invocation halts instead of retrying it.
  let reservation: RunReservation | undefined
  try {
    if (plan.kind === "task") {
      reservation = await reserveRunSlot(ledgerPath, run)
      await markRunStarted(ledgerPath, reservation)
    }
    const executed = await executeLiveRun({
      config,
      ledgerPath,
      outputRoot,
      plan,
      ...(plan.kind === "one-request-preflight"
        ? {
            beforeExternal: async () => {
              reservation = await reserveRunSlot(ledgerPath, run)
              await markRunStarted(ledgerPath, reservation)
            },
          }
        : {}),
    })
    if (!reservation) throw new DriverFailure("run-slot-not-reserved-before-external")
    await finishRunSlot(ledgerPath, reservation, {
      state: "pass",
      evidence: {
        candidateCommit: config.candidateSha,
        freezeManifestSha256: config.freezeManifestSha256,
        modelIdentitySha256: executed.proof.modelIdentitySha256,
        modelConfigSha256: executed.proof.modelConfigSha256,
        hostResolvedEvidenceSha256: executed.hostResolvedEvidenceSha256,
        context: executed.proof.context,
        outputReserve: executed.proof.outputReserve,
        providerRequests: executed.providerRequests,
        resultSha256: executed.resultSha256,
      },
    })
    console.log(JSON.stringify({ run, status: "PASS", resultSha256: executed.resultSha256 }))
  } catch (error) {
    const artifact = failureArtifact(run, error)
    const code = artifact.code
    if (reservation) await finishRunSlot(ledgerPath, reservation, { state: "fail", failureCode: code })
    await privateWrite(path.join(outputRoot, `run-${run}`, "failure.json"), `${JSON.stringify(artifact, null, 2)}\n`)
    console.error(JSON.stringify({ run, status: "FAIL", code }))
    process.exitCode = 1
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "REFUSED", code: failureCode(error) }))
    process.exitCode = 1
  })
}
