import { createHash } from "node:crypto"
import { cpus, loadavg, platform, release, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker, isMainThread, parentPort, threadId, workerData } from "node:worker_threads"
import { LLM, Model, PreparedRequest, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  ContextFoldingPolicy,
  estimateContextFoldingBudget,
  type ContextFoldingProjectionResult,
} from "@opencode-ai/core/session/context-folding"
import { ContextFoldingToolSourceLedger } from "@opencode-ai/core/session/context-folding/tool-source-ledger"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { CoreContextFolding } from "@opencode-ai/core/session/runner/context-folding"
import { toLLMMessagesWithBindings } from "@opencode-ai/core/session/runner/to-llm-message"
import { DateTime, Effect } from "effect"

const CONTEXT_LIMIT = 81_920
const OUTPUT_RESERVE = 4_096
const TARGET_TOKENS = 54_476
const ONE_MIB_TARGET_BYTES = 1_000_000
const EIGHT_MIB_TARGET_BYTES = 7_500_000
const POSITIVE_BODY_BYTES = 131_072
const RSS_PROBE_REPETITIONS = 3
const textEncoder = new TextEncoder()
const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = join(dirname(scriptPath), "../../..")
const now = DateTime.makeUnsafe(1)

type SizeClass = "1MiB" | "8MiB"
type ControlName = "all-unique" | "all-protected" | "below-target" | "work-limit" | "budget-exhausted"
type FixtureMode = "positive" | ControlName

type PairSample = Readonly<{
  repetition: number
  order: "disabled-enabled" | "enabled-disabled"
  disabledBudgetOnlyMs: number
  enabledFullAdapterMs: number
  signedIncrementalMs: number
  applied: boolean
  foldedOutputs: number
  originalIntact: boolean
  witnessIntact: boolean
  projectedOutputBytes: number
}>

type PositiveEvidence = Readonly<{
  serializedInputBytes: number
  projectedOutputBytes: number
  originalIntact: boolean
  witnessIntact: boolean
  applied: boolean
  foldedOutputs: number
  skipReason: string | null
  preparedInputSha256: string
  sourceHistorySha256: string
  canonicalRequestSha256: string
}>

type ControlEvidence = Readonly<{
  name: ControlName
  passed: boolean
  originalIntact: boolean
  requestUnchanged: boolean
  applied: boolean
  foldedOutputs: number
  skipReason: string | null
}>

type Fixture = Readonly<{
  sessionID: string
  sourceMessages: readonly SessionMessage.Message[]
  conversion: ReturnType<typeof toLLMMessagesWithBindings>
  request: LLMRequest
  prepared: PreparedRequest
  budgetBody: unknown
  witnessCallID: string | undefined
  originalHash: string
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requiredNumber = (input: Record<string, unknown>, key: string, integer = false) => {
  const value = input[key]
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${key} must be a finite${integer ? " integer" : ""} number`)
  }
  return value
}

const requiredBoolean = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`)
  return value
}

const requiredSha256 = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${key} must be SHA-256`)
  return value
}

const positiveEvidenceFrom = (value: unknown): PositiveEvidence => {
  if (!isRecord(value)) throw new Error("positive evidence must be an object")
  const skipReason = value.skipReason
  if (skipReason !== null && typeof skipReason !== "string") throw new Error("skipReason must be string or null")
  return {
    serializedInputBytes: requiredNumber(value, "serializedInputBytes", true),
    projectedOutputBytes: requiredNumber(value, "projectedOutputBytes", true),
    originalIntact: requiredBoolean(value, "originalIntact"),
    witnessIntact: requiredBoolean(value, "witnessIntact"),
    applied: requiredBoolean(value, "applied"),
    foldedOutputs: requiredNumber(value, "foldedOutputs", true),
    skipReason,
    preparedInputSha256: requiredSha256(value, "preparedInputSha256"),
    sourceHistorySha256: requiredSha256(value, "sourceHistorySha256"),
    canonicalRequestSha256: requiredSha256(value, "canonicalRequestSha256"),
  }
}

const pairSampleFrom = (value: unknown): PairSample => {
  if (!isRecord(value)) throw new Error("pair sample must be an object")
  const order = value.order
  if (order !== "disabled-enabled" && order !== "enabled-disabled") throw new Error("invalid pair order")
  return {
    repetition: requiredNumber(value, "repetition", true),
    order,
    disabledBudgetOnlyMs: requiredNumber(value, "disabledBudgetOnlyMs"),
    enabledFullAdapterMs: requiredNumber(value, "enabledFullAdapterMs"),
    signedIncrementalMs: requiredNumber(value, "signedIncrementalMs"),
    applied: requiredBoolean(value, "applied"),
    foldedOutputs: requiredNumber(value, "foldedOutputs", true),
    originalIntact: requiredBoolean(value, "originalIntact"),
    witnessIntact: requiredBoolean(value, "witnessIntact"),
    projectedOutputBytes: requiredNumber(value, "projectedOutputBytes", true),
  }
}

const finite = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new Error(`${name} is not finite`)
  return value
}

const round = (value: number) => Math.round(value * 1_000) / 1_000
const bytes = (value: unknown) => textEncoder.encode(JSON.stringify(value)).byteLength
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fixtureHash = (fixture: Pick<Fixture, "sourceMessages" | "request">) =>
  hash({ sourceMessages: fixture.sourceMessages, request: fixture.request })

const percentile = (values: readonly number[], fraction: number) => {
  if (values.length === 0) throw new Error("percentile requires at least one value")
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
}

const model = Model.make({
  id: "s09-p0-model",
  provider: "s09-p0-provider",
  route: OpenAIChat.route,
  defaults: {
    limits: { context: CONTEXT_LIMIT, output: OUTPUT_RESERVE },
    generation: { maxTokens: OUTPUT_RESERVE },
  },
})

const modelRef = {
  id: ModelV2.ID.make(String(model.id)),
  providerID: ProviderV2.ID.make(String(model.provider)),
}

const prepare = (request: LLMRequest) =>
  request.model.route.body.from(request).pipe(
    Effect.map(
      (body) =>
        new PreparedRequest({
          id: request.id ?? "s09-p0-request",
          route: request.model.route.id,
          protocol: request.model.route.protocol,
          model: request.model,
          body,
        }),
    ),
  )

const toolMessage = (input: {
  messageID: string
  callID: string
  body: string
  path: string
}): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make(input.messageID),
  type: "assistant",
  agent: "build",
  model: modelRef,
  time: { created: now, completed: now },
  content: [
    {
      type: "tool",
      id: input.callID,
      name: "read",
      state: {
        status: "completed",
        input: { path: input.path, offset: 1, limit: 200 },
        structured: {
          type: "text-page",
          content: input.body,
          mime: "text/plain",
          offset: 1,
          truncated: false,
          next: 2,
        },
        content: [],
      },
      time: { created: now, ran: now, completed: now },
    },
  ],
})

const textMessage = (id: string, length: number): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make(id),
  type: "assistant",
  agent: "build",
  model: modelRef,
  time: { created: now, completed: now },
  content: [{ type: "text", id: `${id}-text`, text: "r".repeat(Math.max(0, length)) }],
})

const makeMessages = (input: { mode: Exclude<FixtureMode, "work-limit">; label: string; fillerCharacters: number }) => {
  const slug = input.label.replace(/[^A-Za-z0-9_]/g, "_")
  const sourceBody = "p".repeat(
    input.mode === "below-target" ? 20_000 : input.mode === "budget-exhausted" ? 4_300_000 : POSITIVE_BODY_BYTES,
  )
  const witnessBody = input.mode === "all-unique" ? `${sourceBody.slice(0, -1)}q` : sourceBody
  const path = "/fixture/repeated.txt"
  const candidates = [
    toolMessage({ messageID: `msg_${slug}_source`, callID: `${slug}-source-call`, body: sourceBody, path }),
    toolMessage({
      messageID: `msg_${slug}_witness`,
      callID: `${slug}-witness-call`,
      body: witnessBody,
      path,
    }),
  ]
  const recentCount = input.mode === "all-protected" ? 2 : 4
  const base = Math.floor(input.fillerCharacters / recentCount)
  const remainder = input.fillerCharacters - base * recentCount
  const recent = Array.from({ length: recentCount }, (_, index) =>
    textMessage(`msg_${slug}_recent_${index}`, base + (index === 0 ? remainder : 0)),
  )
  return [...candidates, ...recent]
}

const requestFor = (messages: readonly SessionMessage.Message[]) => {
  const conversion = toLLMMessagesWithBindings(messages, model)
  const request = LLM.request({ model, messages: conversion.messages, tools: [] })
  return { conversion, request }
}

const makeSizedMessages = async (label: SizeClass, targetBytes: number) => {
  let fillerCharacters = Math.max(1, targetBytes - POSITIVE_BODY_BYTES * 2 - 2_048)
  let messages = makeMessages({ mode: "positive", label, fillerCharacters })
  for (let attempt = 0; attempt < 4; attempt++) {
    const { request } = requestFor(messages)
    const prepared = await Effect.runPromise(prepare(request))
    const delta = targetBytes - bytes(prepared.body)
    if (delta === 0) return messages
    fillerCharacters += delta
    if (fillerCharacters < 1) throw new Error(`${label}: target byte calibration underflow`)
    messages = makeMessages({ mode: "positive", label, fillerCharacters })
  }
  const { request } = requestFor(messages)
  const prepared = await Effect.runPromise(prepare(request))
  if (bytes(prepared.body) !== targetBytes) {
    throw new Error(`${label}: could not calibrate prepared body to ${targetBytes} bytes`)
  }
  return messages
}

const makeWorkLimitMessages = () =>
  Array.from({ length: 4_097 }, (_, index) => textMessage(`msg_work_limit_${index}`, 8))

const buildFixture = async (mode: FixtureMode, sizeClass?: SizeClass): Promise<Fixture> => {
  let sourceMessages: readonly SessionMessage.Message[]
  if (mode === "positive") {
    if (!sizeClass) throw new Error("positive fixture requires a size class")
    sourceMessages = await makeSizedMessages(
      sizeClass,
      sizeClass === "1MiB" ? ONE_MIB_TARGET_BYTES : EIGHT_MIB_TARGET_BYTES,
    )
  } else if (mode === "work-limit") {
    sourceMessages = makeWorkLimitMessages()
  } else {
    const fillerCharacters = 80_000
    sourceMessages = makeMessages({ mode, label: mode, fillerCharacters })
  }
  const { conversion, request } = requestFor(sourceMessages)
  const prepared = await Effect.runPromise(prepare(request))
  const budgetBody = JSON.parse(JSON.stringify(prepared.body)) as unknown
  const slug = (sizeClass ?? mode).replace(/[^A-Za-z0-9_]/g, "_")
  const witnessCallID = mode === "work-limit" ? undefined : `${slug}-witness-call`
  const sessionID = `ses_s09_p0_${slug}`
  const base = { sourceMessages, request }
  return {
    sessionID,
    sourceMessages,
    conversion,
    request,
    prepared,
    budgetBody,
    witnessCallID,
    originalHash: fixtureHash(base),
  }
}

const registerFixture = Effect.fnUntraced(function* (
  ledger: ContextFoldingToolSourceLedger.Interface,
  fixture: Fixture,
) {
  const generation = yield* ledger.activate([
    { toolName: "read", sourceKind: "host-builtin", registrationID: "s09-p0-read", instructions: "none" },
  ])
  for (const message of fixture.sourceMessages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      yield* ledger.record({
        sessionID: fixture.sessionID,
        assistantMessageID: message.id,
        callID: part.id,
        toolName: part.name,
        source: {
          sourceKind: "host-builtin",
          registrationID: "s09-p0-read",
          registrationGeneration: generation,
          instructions: "none",
        },
      })
    }
  }
})

const enabled = (ledger: ContextFoldingToolSourceLedger.Interface, fixture: Fixture) =>
  CoreContextFolding.project({
    enabled: true,
    purpose: "conversation",
    sessionID: fixture.sessionID,
    sourceMessages: fixture.sourceMessages,
    conversion: fixture.conversion,
    expectedMessages: fixture.conversion.messages,
    model,
    request: fixture.request,
    ledger,
    prepare,
  })

const disabledBudgetOnly = (fixture: Fixture) =>
  estimateContextFoldingBudget({
    contextLimit: CONTEXT_LIMIT,
    inputLimit: { kind: "absent" },
    outputReserve: OUTPUT_RESERVE,
    system: { kind: "none" },
    messages: fixture.budgetBody,
    tools: [],
    protocolOverheadTokens: 0,
    media: "none",
  })

const witnessBody = (request: LLMRequest, callID: string | undefined) => {
  if (!callID) return undefined
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.id !== callID || part.result.type !== "json") continue
      const value = part.result.value
      if (typeof value !== "object" || value === null || !("content" in value)) continue
      return typeof value.content === "string" ? value.content : undefined
    }
  }
  return undefined
}

const evidence = async (
  fixture: Fixture,
  result: ContextFoldingProjectionResult<LLMRequest>,
): Promise<PositiveEvidence> => {
  const projected = await Effect.runPromise(prepare(result.request))
  const expectedWitness = witnessBody(fixture.request, fixture.witnessCallID)
  return {
    serializedInputBytes: bytes(fixture.prepared.body),
    projectedOutputBytes: bytes(projected.body),
    originalIntact: fixtureHash(fixture) === fixture.originalHash,
    witnessIntact:
      expectedWitness !== undefined && expectedWitness === witnessBody(result.request, fixture.witnessCallID),
    applied: result.applied,
    foldedOutputs: result.plan.replacements.length,
    skipReason: result.plan.skipReason ?? null,
    preparedInputSha256: hash(fixture.budgetBody),
    sourceHistorySha256: hash(fixture.sourceMessages),
    canonicalRequestSha256: hash(fixture.request),
  }
}

const assertPositiveEvidence = (sizeClass: SizeClass, value: PositiveEvidence) => {
  if (
    !value.applied ||
    value.foldedOutputs <= 0 ||
    !value.originalIntact ||
    !value.witnessIntact ||
    value.projectedOutputBytes >= value.serializedInputBytes ||
    value.skipReason !== null
  ) {
    throw new Error(`${sizeClass}: positive folding assertion failed: ${JSON.stringify(value)}`)
  }
}

const assertBudgetBaseline = (sizeClass: SizeClass, value: ReturnType<typeof disabledBudgetOnly>) => {
  if (value.targetTokens !== TARGET_TOKENS || value.overBudget !== true || value.skipReason !== undefined) {
    throw new Error(`${sizeClass}: invalid budget-only baseline: ${JSON.stringify(value)}`)
  }
}

const runTiming = async (sizeClass: SizeClass, warmup: number, repetitions: number) => {
  const fixture = await buildFixture("positive", sizeClass)
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* ContextFoldingToolSourceLedger.Service
      yield* registerFixture(ledger, fixture)
      let lastEvidence: PositiveEvidence | undefined
      for (let index = 0; index < warmup; index++) {
        const budget = disabledBudgetOnly(fixture)
        assertBudgetBaseline(sizeClass, budget)
        const result = yield* enabled(ledger, fixture)
        lastEvidence = yield* Effect.promise(() => evidence(fixture, result))
        assertPositiveEvidence(sizeClass, lastEvidence)
      }
      const pairs: PairSample[] = []
      for (let repetition = 0; repetition < repetitions; repetition++) {
        Bun.gc(true)
        let disabledMs = 0
        let enabledMs = 0
        let budget: ReturnType<typeof disabledBudgetOnly>
        let result: ContextFoldingProjectionResult<LLMRequest>
        if (repetition % 2 === 0) {
          let start = performance.now()
          budget = disabledBudgetOnly(fixture)
          disabledMs = performance.now() - start
          start = performance.now()
          result = yield* enabled(ledger, fixture)
          enabledMs = performance.now() - start
        } else {
          let start = performance.now()
          result = yield* enabled(ledger, fixture)
          enabledMs = performance.now() - start
          start = performance.now()
          budget = disabledBudgetOnly(fixture)
          disabledMs = performance.now() - start
        }
        assertBudgetBaseline(sizeClass, budget)
        lastEvidence = yield* Effect.promise(() => evidence(fixture, result))
        assertPositiveEvidence(sizeClass, lastEvidence)
        pairs.push({
          repetition,
          order: repetition % 2 === 0 ? "disabled-enabled" : "enabled-disabled",
          disabledBudgetOnlyMs: finite(disabledMs, "disabledBudgetOnlyMs"),
          enabledFullAdapterMs: finite(enabledMs, "enabledFullAdapterMs"),
          signedIncrementalMs: finite(enabledMs - disabledMs, "signedIncrementalMs"),
          applied: lastEvidence.applied,
          foldedOutputs: lastEvidence.foldedOutputs,
          originalIntact: lastEvidence.originalIntact,
          witnessIntact: lastEvidence.witnessIntact,
          projectedOutputBytes: lastEvidence.projectedOutputBytes,
        })
      }
      if (!lastEvidence) throw new Error(`${sizeClass}: no timing evidence produced`)
      return { sizeClass, warmup, repetitions, pairs, evidence: lastEvidence }
    }).pipe(Effect.provide(ContextFoldingToolSourceLedger.layer)),
  )
}

const runRssWorker = async (sizeClass: SizeClass, waitForStart: () => Promise<void>) => {
  const fixture = await buildFixture("positive", sizeClass)
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* ContextFoldingToolSourceLedger.Service
      yield* registerFixture(ledger, fixture)
      Bun.gc(true)
      yield* Effect.promise(waitForStart)
      let lastEvidence: PositiveEvidence | undefined
      for (let index = 0; index < RSS_PROBE_REPETITIONS; index++) {
        Bun.gc(true)
        const result = yield* enabled(ledger, fixture)
        lastEvidence = yield* Effect.promise(() => evidence(fixture, result))
        assertPositiveEvidence(sizeClass, lastEvidence)
      }
      if (!lastEvidence) throw new Error(`${sizeClass}: RSS worker produced no result`)
      return {
        sizeClass,
        repetitions: RSS_PROBE_REPETITIONS,
        workerThreadID: threadId,
        evidence: lastEvidence,
      }
    }).pipe(Effect.provide(ContextFoldingToolSourceLedger.layer)),
  )
}

type RssWorkerResult = Awaited<ReturnType<typeof runRssWorker>>

const rssWorkerResultFrom = (value: unknown): RssWorkerResult => {
  if (!isRecord(value)) throw new Error("RSS worker result must be an object")
  const sizeClassValue = value.sizeClass
  if (typeof sizeClassValue !== "string") throw new Error("RSS worker sizeClass must be a string")
  return {
    sizeClass: sizeClassFrom(sizeClassValue),
    repetitions: requiredNumber(value, "repetitions", true),
    workerThreadID: requiredNumber(value, "workerThreadID", true),
    evidence: positiveEvidenceFrom(value.evidence),
  }
}

const runRssProbe = async (sizeClass: SizeClass) => {
  const handshake = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const handshakeState = new Int32Array(handshake)
  const worker = new Worker(scriptPath, { workerData: { kind: "s09-p0-rss", sizeClass, handshake } })
  return new Promise<{
    sizeClass: SizeClass
    baselineResidentBytes: number
    peakSampledResidentBytes: number
    deltaBytes: number
    samples: number
    samplingIntervalMs: number
    samplerProcessID: number
    workerThreadID: number
    sharedProcessRss: true
    repetitions: number
    evidence: PositiveEvidence
  }>((resolve, reject) => {
    const samplingIntervalMs = 1
    let baselineResidentBytes: number | undefined
    let peakSampledResidentBytes = 0
    let samples = 0
    let sampler: ReturnType<typeof setInterval> | undefined
    let settled = false
    let lastStage = "spawned"
    const handshakePoll = setInterval(() => {
      if (baselineResidentBytes !== undefined || Atomics.load(handshakeState, 0) !== 1) return
      baselineResidentBytes = process.memoryUsage().rss
      peakSampledResidentBytes = baselineResidentBytes
      samples = 1
      lastStage = "baseline-recorded"
      clearInterval(handshakePoll)
      sampler = setInterval(sample, samplingIntervalMs)
      Atomics.store(handshakeState, 0, 2)
      Atomics.notify(handshakeState, 0)
    }, 1)
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      clearInterval(handshakePoll)
      finishSampling()
      void worker.terminate()
      reject(new Error(`${sizeClass}: RSS worker timed out after stage ${lastStage}`))
    }, 30_000)
    const sample = () => {
      const current = process.memoryUsage().rss
      peakSampledResidentBytes = Math.max(peakSampledResidentBytes, current)
      samples++
    }
    const finishSampling = () => {
      if (sampler) clearInterval(sampler)
      sampler = undefined
      sample()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(handshakePoll)
      finishSampling()
      void worker.terminate()
      reject(error)
    }
    worker.on("message", (message: unknown) => {
      if (!isRecord(message) || typeof message.type !== "string") {
        fail(new Error(`${sizeClass}: invalid RSS worker message`))
        return
      }
      if (message.type === "boot") {
        lastStage = "boot"
        return
      }
      if (message.type === "result") {
        finishSampling()
        if (baselineResidentBytes === undefined) {
          fail(new Error(`${sizeClass}: RSS worker result arrived before baseline`))
          return
        }
        let value: RssWorkerResult
        try {
          value = rssWorkerResultFrom(message.value)
        } catch (error) {
          fail(error instanceof Error ? error : new Error(`${sizeClass}: invalid RSS worker result`))
          return
        }
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(handshakePoll)
        void worker.terminate()
        resolve({
          sizeClass,
          baselineResidentBytes,
          peakSampledResidentBytes,
          deltaBytes: Math.max(0, peakSampledResidentBytes - baselineResidentBytes),
          samples,
          samplingIntervalMs,
          samplerProcessID: process.pid,
          workerThreadID: value.workerThreadID,
          sharedProcessRss: true,
          repetitions: value.repetitions,
          evidence: value.evidence,
        })
      }
    })
    worker.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)))
    })
    worker.on("exit", (code) => {
      if (!settled) fail(new Error(`${sizeClass}: RSS worker exited ${code} before sending a result`))
    })
  })
}

const expectedControlReason: Record<ControlName, string> = {
  "all-unique": "no-eligible-duplicates",
  "all-protected": "all-sources-protected",
  "below-target": "below-target",
  "work-limit": "work-limit",
  "budget-exhausted": "work-limit",
}
const controlNames = ["all-unique", "all-protected", "below-target", "work-limit", "budget-exhausted"] as const

const runControls = async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* ContextFoldingToolSourceLedger.Service
      const controls = []
      for (const name of controlNames) {
        const fixture = yield* Effect.promise(() => buildFixture(name))
        yield* registerFixture(ledger, fixture)
        const result = yield* enabled(ledger, fixture)
        const originalIntact = fixtureHash(fixture) === fixture.originalHash
        const requestUnchanged = result.request === fixture.request && hash(result.request) === hash(fixture.request)
        const skipReason = result.plan.skipReason ?? null
        const foldedOutputs = result.plan.replacements.length
        const passed =
          originalIntact &&
          requestUnchanged &&
          !result.applied &&
          foldedOutputs === 0 &&
          skipReason === expectedControlReason[name]
        controls.push({
          name,
          passed,
          originalIntact,
          requestUnchanged,
          applied: result.applied,
          foldedOutputs,
          skipReason,
        })
      }
      return controls
    }).pipe(Effect.provide(ContextFoldingToolSourceLedger.layer)),
  )

const requiredArg = (name: string) => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const writeJson = (path: string, value: unknown) => Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)

const sizeClassFrom = (value: string): SizeClass => {
  if (value === "1MiB" || value === "8MiB") return value
  throw new Error(`unknown class ${value}`)
}

const controlNameFrom = (value: unknown): ControlName => {
  if (
    value === "all-unique" ||
    value === "all-protected" ||
    value === "below-target" ||
    value === "work-limit" ||
    value === "budget-exhausted"
  )
    return value
  throw new Error(`unknown control name: ${String(value)}`)
}

const childMain = async (mode: string) => {
  const output = requiredArg("--output")
  if (mode === "controls") {
    await writeJson(output, await runControls())
    return
  }
  const sizeClass = sizeClassFrom(requiredArg("--class"))
  if (mode === "timing") {
    const warmup = Number(requiredArg("--warmup"))
    const repetitions = Number(requiredArg("--repetitions"))
    await writeJson(output, await runTiming(sizeClass, warmup, repetitions))
    return
  }
  if (mode === "rss") {
    await writeJson(output, await runRssProbe(sizeClass))
    return
  }
  throw new Error(`unknown child mode ${mode}`)
}

const readJson = async (path: string): Promise<unknown> => {
  const value: unknown = JSON.parse(await Bun.file(path).text())
  return value
}

const timingResultFrom = (value: unknown) => {
  if (!isRecord(value) || typeof value.sizeClass !== "string" || !Array.isArray(value.pairs)) {
    throw new Error("invalid timing child result")
  }
  return {
    sizeClass: sizeClassFrom(value.sizeClass),
    warmup: requiredNumber(value, "warmup", true),
    repetitions: requiredNumber(value, "repetitions", true),
    pairs: value.pairs.map(pairSampleFrom),
    evidence: positiveEvidenceFrom(value.evidence),
  }
}

const rssProbeFrom = (value: unknown) => {
  if (!isRecord(value) || typeof value.sizeClass !== "string" || value.sharedProcessRss !== true) {
    throw new Error("invalid RSS child result")
  }
  return {
    sizeClass: sizeClassFrom(value.sizeClass),
    baselineResidentBytes: requiredNumber(value, "baselineResidentBytes", true),
    peakSampledResidentBytes: requiredNumber(value, "peakSampledResidentBytes", true),
    deltaBytes: requiredNumber(value, "deltaBytes", true),
    samples: requiredNumber(value, "samples", true),
    samplingIntervalMs: requiredNumber(value, "samplingIntervalMs"),
    samplerProcessID: requiredNumber(value, "samplerProcessID", true),
    workerThreadID: requiredNumber(value, "workerThreadID", true),
    sharedProcessRss: true as const,
    repetitions: requiredNumber(value, "repetitions", true),
    evidence: positiveEvidenceFrom(value.evidence),
  }
}

const controlsFrom = (value: unknown): ControlEvidence[] => {
  if (!Array.isArray(value)) throw new Error("control child result must be an array")
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("control result must be an object")
    const skipReason = item.skipReason
    if (skipReason !== null && typeof skipReason !== "string")
      throw new Error("control skipReason must be string or null")
    return {
      name: controlNameFrom(item.name),
      passed: requiredBoolean(item, "passed"),
      originalIntact: requiredBoolean(item, "originalIntact"),
      requestUnchanged: requiredBoolean(item, "requestUnchanged"),
      applied: requiredBoolean(item, "applied"),
      foldedOutputs: requiredNumber(item, "foldedOutputs", true),
      skipReason,
    }
  })
}

const waitFor = async (process: ReturnType<typeof Bun.spawn>) => {
  const code = await process.exited
  if (code !== 0) throw new Error(`child exited ${code}`)
}

const spawnChild = (args: readonly string[]) =>
  Bun.spawn([process.execPath, scriptPath, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  })

const sampleRss = async (sizeClass: SizeClass, tempDirectory: string) => {
  const output = join(tempDirectory, `${sizeClass}-rss.json`)
  const child = spawnChild(["--child", "rss", "--class", sizeClass, "--output", output])
  await waitFor(child)
  return rssProbeFrom(await readJson(output))
}

const gitOutput = (args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

const fileSha256 = async (path: string) =>
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex")

const candidateManifest = async (smoke: boolean) => {
  const candidateSha = gitOutput(["rev-parse", "HEAD"])
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) throw new Error(`invalid candidate SHA: ${candidateSha}`)
  const statusLines = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line.length > 0)
  const trackedDirty = statusLines.filter((line) => !line.startsWith("?? "))
  const untracked = statusLines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3))
  const untrackedSource = untracked.filter((path) => !path.startsWith("docs/continuation-2026-09-20/s09/"))
  const sourceClean = trackedDirty.length === 0 && untrackedSource.length === 0
  if (!smoke && !sourceClean) {
    throw new Error(
      `formal sampling requires a clean source candidate; trackedDirty=${trackedDirty.length}, untrackedSource=${untrackedSource.length}`,
    )
  }
  return {
    candidateSha,
    sourceClean,
    trackedDirtyEntries: trackedDirty.length,
    untrackedSourceEntries: untrackedSource.length,
    ignoredEvidenceUntrackedEntries: untracked.length - untrackedSource.length,
    runnerSha256: await fileSha256(scriptPath),
    gateSha256: await fileSha256(join(repositoryRoot, "docs/continuation-2026-09-20/s09/scripts/performance-gate.ts")),
    policy: {
      protectRecentSteps: ContextFoldingPolicy.protectRecentSteps,
      protectRecentTokens: ContextFoldingPolicy.protectRecentTokens,
      softTargetRatio: ContextFoldingPolicy.softTargetRatio,
      minimumNetSavingsTokens: ContextFoldingPolicy.minimumNetSavingsTokens,
      workLimits: ContextFoldingPolicy.workLimits,
      contextLimit: CONTEXT_LIMIT,
      outputReserve: OUTPUT_RESERVE,
      targetTokens: TARGET_TOKENS,
    },
  }
}

const orchestrate = async () => {
  const rawDirectory = requiredArg("--raw-dir")
  const summaryPath = requiredArg("--summary")
  const smoke = process.argv.includes("--smoke")
  await Bun.$`mkdir -p ${rawDirectory}`.quiet()
  const manifest = await candidateManifest(smoke)
  const startedAt = new Date().toISOString()
  const loadAtStart = loadavg()
  const timing = []
  const rss: Awaited<ReturnType<typeof sampleRss>>[] = []
  for (const sizeClass of ["1MiB", "8MiB"] as const) {
    const output = join(rawDirectory, `${sizeClass}-timing.json`)
    const warmup = smoke ? 1 : sizeClass === "1MiB" ? 5 : 3
    const repetitions = smoke ? 2 : sizeClass === "1MiB" ? 20 : 10
    const child = spawnChild([
      "--child",
      "timing",
      "--class",
      sizeClass,
      "--warmup",
      String(warmup),
      "--repetitions",
      String(repetitions),
      "--output",
      output,
    ])
    await waitFor(child)
    timing.push(timingResultFrom(await readJson(output)))
    rss.push(await sampleRss(sizeClass, rawDirectory))
  }
  const controlsPath = join(rawDirectory, "controls.json")
  const controlsChild = spawnChild(["--child", "controls", "--output", controlsPath])
  await waitFor(controlsChild)
  const controls = controlsFrom(await readJson(controlsPath))
  const raw = {
    schemaVersion: 1,
    candidateSha: manifest.candidateSha,
    smoke,
    startedAt,
    completedAt: new Date().toISOString(),
    machineLoad: { start: loadAtStart, end: loadavg() },
    manifest: {
      ...manifest,
      runtime: {
        bun: Bun.version,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        ramMiB: Math.floor(totalmem() / (1024 * 1024)),
      },
      measurement: {
        disabledBaseline: "estimateContextFoldingBudget over the independently copied prepared provider body only",
        enabledArm: "CoreContextFolding.project production adapter",
        pairOrder: "alternating within each repetition",
        rss: "fresh child process; worker executes adapter while main thread samples shared process RSS after a shared atomic ready/release handshake",
        rssSamplingIntervalMs: 1,
        rssSamplingIncludesEvidenceWork: true,
        rssMayMissShorterThanEffectiveInterval: true,
      },
      fixtures: timing.map((item) => ({
        class: item.sizeClass,
        preparedInputSha256: item.evidence.preparedInputSha256,
        sourceHistorySha256: item.evidence.sourceHistorySha256,
        canonicalRequestSha256: item.evidence.canonicalRequestSha256,
        serializedInputBytes: item.evidence.serializedInputBytes,
      })),
    },
    timing,
    rss,
    controls,
  }
  const rawPath = join(rawDirectory, "performance-raw-samples.json")
  await writeJson(rawPath, raw)
  const rawBytes = await Bun.file(rawPath).arrayBuffer()
  const rawSamplesSha256 = createHash("sha256").update(new Uint8Array(rawBytes)).digest("hex")
  const rows = timing.map((item) => {
    const rssItem = rss.find((candidate) => candidate.sizeClass === item.sizeClass)
    if (!rssItem) throw new Error(`${item.sizeClass}: missing RSS result`)
    const deltas = item.pairs.map((pair) => pair.signedIncrementalMs)
    return {
      class: item.sizeClass,
      serializedInputBytes: item.evidence.serializedInputBytes,
      projectedOutputBytes: item.evidence.projectedOutputBytes,
      warmup: item.warmup,
      repetitions: item.repetitions,
      p95IncrementalMs: round(percentile(deltas, 0.95)),
      rssDeltaPeakMiB: round(rssItem.deltaBytes / (1024 * 1024)),
      originalIntact: item.evidence.originalIntact && rssItem.evidence.originalIntact,
      witnessIntact: item.evidence.witnessIntact && rssItem.evidence.witnessIntact,
      applied: item.evidence.applied && rssItem.evidence.applied,
      foldedOutputs: Math.min(item.evidence.foldedOutputs, rssItem.evidence.foldedOutputs),
    }
  })
  const summary = {
    schemaVersion: 1,
    candidateSha: manifest.candidateSha,
    runtime: {
      bun: Bun.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      ramMiB: Math.floor(totalmem() / (1024 * 1024)),
    },
    method: {
      pairedPerRepetition: true,
      rssUsesFreshProcessBaseline: true,
      coversBudgetScanCompareCopyFingerprintVerify: true,
    },
    rows,
    controls,
    rawSamplesSha256,
  }
  await writeJson(summaryPath, summary)
  console.log(JSON.stringify({ summaryPath, rawPath, rawSamplesSha256, rows, controls }, null, 2))
}

const rssWorkerEntry = async () => {
  const data: unknown = workerData
  const port = parentPort
  if (
    !isRecord(data) ||
    data.kind !== "s09-p0-rss" ||
    typeof data.sizeClass !== "string" ||
    !(data.handshake instanceof SharedArrayBuffer) ||
    !port
  ) {
    throw new Error("invalid RSS worker initialization")
  }
  port.postMessage({ type: "boot" })
  const sizeClass = sizeClassFrom(data.sizeClass)
  const handshakeState = new Int32Array(data.handshake)
  const value = await runRssWorker(sizeClass, async () => {
    Atomics.store(handshakeState, 0, 1)
    Atomics.notify(handshakeState, 0)
    const status = Atomics.wait(handshakeState, 0, 1, 30_000)
    if (status === "timed-out" || Atomics.load(handshakeState, 0) !== 2) {
      throw new Error(`${sizeClass}: RSS baseline handshake failed`)
    }
  })
  port.postMessage({ type: "result", value })
}

if (!isMainThread) await rssWorkerEntry()
else {
  const childIndex = process.argv.indexOf("--child")
  if (childIndex >= 0) await childMain(process.argv[childIndex + 1] ?? "")
  else await orchestrate()
}
