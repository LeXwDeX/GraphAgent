// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

export type LiveArm = "enabled" | "disabled"
export type LiveTask = "T1" | "T2" | "T3" | "T4"
export type LiveRunPlan = {
  run: number
  kind: "one-request-preflight" | "task"
  arm: LiveArm
  task?: LiveTask
  maxProviderRequests: 1 | 11 | 12
}

export const LIVE_RUN_PLAN: readonly LiveRunPlan[] = [
  { run: 25, kind: "task", task: "T3", arm: "disabled", maxProviderRequests: 11 },
  { run: 26, kind: "task", task: "T3", arm: "enabled", maxProviderRequests: 11 },
  { run: 27, kind: "task", task: "T4", arm: "disabled", maxProviderRequests: 11 },
  { run: 28, kind: "task", task: "T4", arm: "enabled", maxProviderRequests: 11 },
] as const

const SOURCE_RUN_PLAN: readonly LiveRunPlan[] = [
  { run: 19, kind: "task", task: "T2", arm: "disabled", maxProviderRequests: 12 },
  { run: 20, kind: "task", task: "T2", arm: "enabled", maxProviderRequests: 12 },
  { run: 21, kind: "task", task: "T3", arm: "disabled", maxProviderRequests: 12 },
  { run: 22, kind: "task", task: "T3", arm: "enabled", maxProviderRequests: 12 },
  { run: 23, kind: "task", task: "T4", arm: "disabled", maxProviderRequests: 12 },
  { run: 24, kind: "task", task: "T4", arm: "enabled", maxProviderRequests: 12 },
] as const

export const AUTHORIZED_NEW_PROVIDER_REQUEST_LIMIT = 100
export const PLANNED_PROVIDER_REQUEST_MAXIMUM = 44

export type RunLedgerState = "planned" | "reserved" | "started" | "pass" | "fail" | "invalid"
export type PrivateRunLedger = {
  schemaVersion: 6
  contract: "s09-user-authorized-qwen-100req-t3-trajectory-recovery-28"
  ceilingSessions: 28
  historicalConsumedSessions: 22
  authorizedNewProviderRequestLimit: 100
  consumedNewProviderRequests: 55
  remainingNewProviderRequests: 45
  plannedProviderRequestMaximum: 44
  retryBudget: 0
  continuation: {
    sourceLedgerSha256: string
    run22FailureSummarySha256: string
    sourceSchemaVersion: 5
    sourceContract: "s09-user-authorized-qwen-100req-t2-recovery-24"
    sourceCeilingSessions: 24
    sourceHistoricalConsumedSessions: 18
    sourceConsumedSessions: 22
    sourceCandidateCommit: string
    sourceModelIdentitySha256: string
    sourceModelConfigSha256: string
    sourceContext: 81920
    sourceOutputReserve: 4096
    consumedRun: 22
    consumedRunState: "fail"
    consumedRunFailureCode: string
  }
  halted: null | { at: string; run: number | null; reason: string }
  runs: Array<
    LiveRunPlan & {
      state: RunLedgerState
      lease?: string
      reservedAt?: string
      startedAt?: string
      finishedAt?: string
      failureCode?: string
      evidence?: {
        candidateCommit: string
        freezeManifestSha256: string
        modelIdentitySha256: string
        modelConfigSha256: string
        hostResolvedEvidenceSha256: string
        context: 81920
        outputReserve: 4096
        providerRequests: number
        resultSha256: string
      }
    }
  >
  updatedAt: string
}

const isoNow = () => new Date().toISOString()
const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

type ContinuationAnchor = PrivateRunLedger["continuation"]

function newPrivateRunLedger(anchor: ContinuationAnchor, now = isoNow()): PrivateRunLedger {
  return {
    schemaVersion: 6,
    contract: "s09-user-authorized-qwen-100req-t3-trajectory-recovery-28",
    ceilingSessions: 28,
    historicalConsumedSessions: 22,
    authorizedNewProviderRequestLimit: 100,
    consumedNewProviderRequests: 55,
    remainingNewProviderRequests: 45,
    plannedProviderRequestMaximum: 44,
    retryBudget: 0,
    continuation: anchor,
    halted: null,
    runs: LIVE_RUN_PLAN.map((entry) => ({ ...entry, state: "planned" })),
    updatedAt: now,
  }
}

function validateLedger(input: unknown): PrivateRunLedger {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 6 ||
    input.contract !== "s09-user-authorized-qwen-100req-t3-trajectory-recovery-28" ||
    input.ceilingSessions !== 28 ||
    input.historicalConsumedSessions !== 22 ||
    input.authorizedNewProviderRequestLimit !== AUTHORIZED_NEW_PROVIDER_REQUEST_LIMIT ||
    input.consumedNewProviderRequests !== 55 ||
    input.remainingNewProviderRequests !== 45 ||
    input.plannedProviderRequestMaximum !== PLANNED_PROVIDER_REQUEST_MAXIMUM ||
    input.retryBudget !== 0 ||
    !Array.isArray(input.runs) ||
    input.runs.length !== LIVE_RUN_PLAN.length ||
    typeof input.updatedAt !== "string"
  )
    throw new Error("private run ledger has an invalid fixed contract")

  const continuation = input.continuation
  if (
    !isRecord(continuation) ||
    typeof continuation.sourceLedgerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(continuation.sourceLedgerSha256) ||
    typeof continuation.run22FailureSummarySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(continuation.run22FailureSummarySha256) ||
    continuation.sourceSchemaVersion !== 5 ||
    continuation.sourceContract !== "s09-user-authorized-qwen-100req-t2-recovery-24" ||
    continuation.sourceCeilingSessions !== 24 ||
    continuation.sourceHistoricalConsumedSessions !== 18 ||
    continuation.sourceConsumedSessions !== 22 ||
    typeof continuation.sourceCandidateCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(continuation.sourceCandidateCommit) ||
    typeof continuation.sourceModelIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(continuation.sourceModelIdentitySha256) ||
    typeof continuation.sourceModelConfigSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(continuation.sourceModelConfigSha256) ||
    continuation.sourceContext !== 81_920 ||
    continuation.sourceOutputReserve !== 4_096 ||
    continuation.consumedRun !== 22 ||
    continuation.consumedRunState !== "fail" ||
    typeof continuation.consumedRunFailureCode !== "string" ||
    continuation.consumedRunFailureCode.length === 0
  )
    throw new Error("private run ledger has an invalid continuation anchor")

  const halted = input.halted
  if (
    halted !== null &&
    (!isRecord(halted) ||
      typeof halted.at !== "string" ||
      (halted.run !== null && !Number.isInteger(halted.run)) ||
      typeof halted.reason !== "string" ||
      halted.reason.length === 0)
  )
    throw new Error("private run ledger has invalid halt state")

  const runs: PrivateRunLedger["runs"] = []
  const states: RunLedgerState[] = ["planned", "reserved", "started", "pass", "fail", "invalid"]
  const isRunState = (value: unknown): value is RunLedgerState =>
    typeof value === "string" && states.some((state) => state === value)

  for (let index = 0; index < LIVE_RUN_PLAN.length; index++) {
    const expected = LIVE_RUN_PLAN[index]!
    const actual = input.runs[index]
    if (
      !isRecord(actual) ||
      actual.run !== expected.run ||
      actual.kind !== expected.kind ||
      actual.arm !== expected.arm ||
      actual.task !== expected.task ||
      actual.maxProviderRequests !== expected.maxProviderRequests ||
      !isRunState(actual.state)
    )
      throw new Error(`private run ledger schedule mismatch at run ${expected.run}`)

    const state = actual.state
    if (!isRunState(state)) throw new Error(`private run ledger state invalid at run ${expected.run}`)
    const hasLease = typeof actual.lease === "string" && actual.lease.length > 0
    const hasReservedAt = typeof actual.reservedAt === "string"
    const hasStartedAt = typeof actual.startedAt === "string"
    const hasFinishedAt = typeof actual.finishedAt === "string"
    const hasFailure = typeof actual.failureCode === "string" && actual.failureCode.length > 0

    if (
      state === "planned" &&
      (hasLease || hasReservedAt || hasStartedAt || hasFinishedAt || hasFailure || actual.evidence)
    )
      throw new Error(`planned run ${expected.run} contains consumed-slot fields`)
    if (
      state === "reserved" &&
      (!hasLease || !hasReservedAt || hasStartedAt || hasFinishedAt || hasFailure || actual.evidence)
    )
      throw new Error(`reserved run ${expected.run} has inconsistent fields`)
    if (
      state === "started" &&
      (!hasLease || !hasReservedAt || !hasStartedAt || hasFinishedAt || hasFailure || actual.evidence)
    )
      throw new Error(`started run ${expected.run} has inconsistent fields`)
    if (
      (state === "fail" || state === "invalid") &&
      (!hasLease || !hasReservedAt || !hasFinishedAt || !hasFailure || actual.evidence)
    )
      throw new Error(`failed run ${expected.run} has inconsistent fields`)

    let evidence: PrivateRunLedger["runs"][number]["evidence"]
    if (state === "pass") {
      if (!hasLease || !hasReservedAt || !hasStartedAt || !hasFinishedAt || hasFailure || !isRecord(actual.evidence))
        throw new Error(`passed run ${expected.run} has inconsistent fields`)
      const value = actual.evidence
      if (
        typeof value.candidateCommit !== "string" ||
        !/^[a-f0-9]{40}$/.test(value.candidateCommit) ||
        typeof value.freezeManifestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.freezeManifestSha256) ||
        typeof value.modelIdentitySha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.modelIdentitySha256) ||
        typeof value.modelConfigSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.modelConfigSha256) ||
        typeof value.hostResolvedEvidenceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.hostResolvedEvidenceSha256) ||
        value.context !== 81_920 ||
        value.outputReserve !== 4_096 ||
        !Number.isInteger(value.providerRequests) ||
        Number(value.providerRequests) < 1 ||
        Number(value.providerRequests) > expected.maxProviderRequests ||
        typeof value.resultSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.resultSha256)
      )
        throw new Error(`passed run ${expected.run} has invalid evidence`)
      evidence = {
        candidateCommit: value.candidateCommit,
        freezeManifestSha256: value.freezeManifestSha256,
        modelIdentitySha256: value.modelIdentitySha256,
        modelConfigSha256: value.modelConfigSha256,
        hostResolvedEvidenceSha256: value.hostResolvedEvidenceSha256,
        context: 81_920,
        outputReserve: 4_096,
        providerRequests: Number(value.providerRequests),
        resultSha256: value.resultSha256,
      }
    }

    runs.push({
      ...expected,
      state,
      ...(hasLease ? { lease: String(actual.lease) } : {}),
      ...(hasReservedAt ? { reservedAt: String(actual.reservedAt) } : {}),
      ...(hasStartedAt ? { startedAt: String(actual.startedAt) } : {}),
      ...(hasFinishedAt ? { finishedAt: String(actual.finishedAt) } : {}),
      ...(hasFailure ? { failureCode: String(actual.failureCode) } : {}),
      ...(evidence ? { evidence } : {}),
    })
  }

  const consumed = runs.filter((entry) => entry.state !== "planned")
  if (input.historicalConsumedSessions + consumed.length > input.ceilingSessions)
    throw new Error("private run ledger exceeds the fixed session ceiling")
  const active = runs.filter((entry) => entry.state === "reserved" || entry.state === "started")
  if (active.length > 1) throw new Error("private run ledger has multiple active reservations")
  const firstNonPass = runs.findIndex((entry) => entry.state !== "pass")
  if (firstNonPass >= 0 && runs.slice(firstNonPass + 1).some((entry) => entry.state !== "planned"))
    throw new Error("private run ledger violates fixed order")
  const terminalFailure = runs.find((entry) => entry.state === "fail" || entry.state === "invalid")
  if ((terminalFailure && halted === null) || (!terminalFailure && halted !== null))
    throw new Error("private run ledger halt state does not match terminal failures")
  if (terminalFailure && isRecord(halted) && halted.run !== terminalFailure.run)
    throw new Error("private run ledger halt run does not match terminal failure")

  const normalizedHalt =
    halted === null
      ? null
      : {
          at: String(halted.at),
          run: halted.run === null ? null : Number(halted.run),
          reason: String(halted.reason),
        }
  return {
    schemaVersion: 6,
    contract: "s09-user-authorized-qwen-100req-t3-trajectory-recovery-28",
    ceilingSessions: 28,
    historicalConsumedSessions: 22,
    authorizedNewProviderRequestLimit: 100,
    consumedNewProviderRequests: 55,
    remainingNewProviderRequests: 45,
    plannedProviderRequestMaximum: 44,
    retryBudget: 0,
    continuation: {
      sourceLedgerSha256: continuation.sourceLedgerSha256,
      run22FailureSummarySha256: continuation.run22FailureSummarySha256,
      sourceSchemaVersion: 5,
      sourceContract: "s09-user-authorized-qwen-100req-t2-recovery-24",
      sourceCeilingSessions: 24,
      sourceHistoricalConsumedSessions: 18,
      sourceConsumedSessions: 22,
      sourceCandidateCommit: continuation.sourceCandidateCommit,
      sourceModelIdentitySha256: continuation.sourceModelIdentitySha256,
      sourceModelConfigSha256: continuation.sourceModelConfigSha256,
      sourceContext: 81_920,
      sourceOutputReserve: 4_096,
      consumedRun: 22,
      consumedRunState: "fail",
      consumedRunFailureCode: continuation.consumedRunFailureCode,
    },
    halted: normalizedHalt,
    runs,
    updatedAt: input.updatedAt,
  }
}

async function atomicWrite(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, file)
  const directory = await open(path.dirname(file), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function withLedgerLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  let lock
  try {
    lock = await open(lockPath, "wx", 0o600)
  } catch {
    throw new Error("private run ledger is locked; refusing concurrent or uncertain execution")
  }
  try {
    await lock.writeFile(`${process.pid}\n`)
    await lock.sync()
    return await task()
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

async function readLedger(file: string): Promise<PrivateRunLedger> {
  return validateLedger(JSON.parse(await readFile(file, "utf8")))
}

export function readPrivateRunLedger(file: string) {
  return readLedger(file)
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function continuationAnchor(sourceLedgerRaw: string, failureSummaryRaw: string): ContinuationAnchor {
  const source: unknown = JSON.parse(sourceLedgerRaw)
  if (
    !isRecord(source) ||
    source.schemaVersion !== 5 ||
    source.contract !== "s09-user-authorized-qwen-100req-t2-recovery-24" ||
    source.ceilingSessions !== 24 ||
    source.historicalConsumedSessions !== 18 ||
    source.authorizedNewProviderRequestLimit !== 100 ||
    source.consumedNewProviderRequests !== 25 ||
    source.remainingNewProviderRequests !== 75 ||
    source.plannedProviderRequestMaximum !== 72 ||
    source.retryBudget !== 0 ||
    !Array.isArray(source.runs) ||
    source.runs.length !== SOURCE_RUN_PLAN.length ||
    !isRecord(source.halted) ||
    source.halted.run !== 22 ||
    !isRecord(source.continuation) ||
    source.continuation.sourceCeilingSessions !== 23 ||
    source.continuation.sourceHistoricalConsumedSessions !== 13 ||
    source.continuation.sourceConsumedSessions !== 18 ||
    source.continuation.consumedRun !== 18 ||
    source.continuation.consumedRunState !== "fail" ||
    typeof source.continuation.sourceModelIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.continuation.sourceModelIdentitySha256) ||
    typeof source.continuation.sourceModelConfigSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.continuation.sourceModelConfigSha256) ||
    source.continuation.sourceContext !== 81_920 ||
    source.continuation.sourceOutputReserve !== 4_096
  )
    throw new Error("source ledger is not the fixed failed run22 T2-recovery contract")
  let passedProviderRequests = 0
  let candidateCommit = ""
  for (let index = 0; index < SOURCE_RUN_PLAN.length; index++) {
    const expected = SOURCE_RUN_PLAN[index]!
    const actual = source.runs[index]
    const expectedState = index < 3 ? "pass" : index === 3 ? "fail" : "planned"
    if (
      !isRecord(actual) ||
      actual.run !== expected.run ||
      actual.kind !== expected.kind ||
      actual.arm !== expected.arm ||
      actual.task !== expected.task ||
      actual.maxProviderRequests !== expected.maxProviderRequests ||
      actual.state !== expectedState
    )
      throw new Error(
        `source ledger does not preserve accepted T2/T3 baseline and run22 failure at schedule index ${index}`,
      )
    if (expectedState === "pass") {
      if (
        !isRecord(actual.evidence) ||
        typeof actual.evidence.candidateCommit !== "string" ||
        !/^[a-f0-9]{40}$/.test(actual.evidence.candidateCommit) ||
        actual.evidence.modelIdentitySha256 !== source.continuation.sourceModelIdentitySha256 ||
        actual.evidence.modelConfigSha256 !== source.continuation.sourceModelConfigSha256 ||
        actual.evidence.context !== 81_920 ||
        actual.evidence.outputReserve !== 4_096 ||
        !Number.isInteger(actual.evidence.providerRequests) ||
        Number(actual.evidence.providerRequests) < 1 ||
        Number(actual.evidence.providerRequests) > expected.maxProviderRequests
      )
        throw new Error(`source ledger pass evidence invalid at run ${expected.run}`)
      if (candidateCommit && candidateCommit !== actual.evidence.candidateCommit)
        throw new Error("source ledger pass candidates disagree")
      candidateCommit = actual.evidence.candidateCommit
      passedProviderRequests += Number(actual.evidence.providerRequests)
    }
  }
  const run22 = source.runs[3]!
  if (
    !isRecord(run22) ||
    typeof run22.failureCode !== "string" ||
    run22.failureCode !== "external-quality-or-side-effect-failed" ||
    source.halted.reason !== run22.failureCode ||
    passedProviderRequests !== 22
  )
    throw new Error("source ledger run22 failure or request accounting is inconsistent")

  const sourceLedgerSha256 = sha256(sourceLedgerRaw)
  const summary: unknown = JSON.parse(failureSummaryRaw)
  if (
    !isRecord(summary) ||
    typeof summary.candidate !== "string" ||
    !/^[a-f0-9]{40}$/.test(summary.candidate) ||
    summary.candidate !== candidateCommit ||
    summary.run !== 22 ||
    summary.status !== "FAIL" ||
    summary.consumed !== true ||
    summary.acceptedT3 !== false ||
    summary.originalLedgerFailureCode !== run22.failureCode ||
    summary.derivedClassification !== "t3-extra-shell-subcommand" ||
    !isRecord(summary.upstream) ||
    summary.upstream.actualForwardedRequests !== 8 ||
    !isRecord(summary.diagnosis) ||
    summary.diagnosis.constraintsPass !== true ||
    summary.diagnosis.trajectoryPass !== false ||
    JSON.stringify(summary.diagnosis.trajectoryFailures) !==
      JSON.stringify(["turn-3-bash:restore-version-count-0", "turn-3-group-1-step-mismatch"]) ||
    summary.diagnosis.extraShellSubcommand !== "grep" ||
    summary.diagnosis.workspaceHashesIntact !== true ||
    summary.diagnosis.sideEffects !== 0 ||
    JSON.stringify(summary.preservedPasses) !== JSON.stringify([19, 20, 21]) ||
    JSON.stringify(summary.remainingRuns) !== JSON.stringify([23, 24]) ||
    !isRecord(summary.artifacts) ||
    summary.artifacts["continuation-ledger.json"] !== sourceLedgerSha256
  )
    throw new Error("run22 failure summary does not bind the source ledger")

  return {
    sourceLedgerSha256,
    run22FailureSummarySha256: sha256(failureSummaryRaw),
    sourceSchemaVersion: 5,
    sourceContract: "s09-user-authorized-qwen-100req-t2-recovery-24",
    sourceCeilingSessions: 24,
    sourceHistoricalConsumedSessions: 18,
    sourceConsumedSessions: 22,
    sourceCandidateCommit: candidateCommit,
    sourceModelIdentitySha256: source.continuation.sourceModelIdentitySha256,
    sourceModelConfigSha256: source.continuation.sourceModelConfigSha256,
    sourceContext: 81_920,
    sourceOutputReserve: 4_096,
    consumedRun: 22,
    consumedRunState: "fail",
    consumedRunFailureCode: run22.failureCode,
  }
}

export async function initializePrivateRunLedger(
  file: string,
  source: { sourceLedgerPath: string; run22FailureSummaryPath: string },
) {
  return withLedgerLock(file, async () => {
    try {
      await lstat(file)
      throw new Error("private run ledger already exists; refusing to replace durable budget state")
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) throw error
      if (!isRecord(error) || error.code !== "ENOENT") throw error
      for (const sourcePath of [source.sourceLedgerPath, source.run22FailureSummaryPath]) {
        const sourceStat = await lstat(sourcePath)
        if (!sourceStat.isFile() || (sourceStat.mode & 0o077) !== 0)
          throw new Error("continuation source evidence must be an owner-only regular file")
      }
      const anchor = continuationAnchor(
        await readFile(source.sourceLedgerPath, "utf8"),
        await readFile(source.run22FailureSummaryPath, "utf8"),
      )
      const ledger = newPrivateRunLedger(anchor)
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const directory = await open(path.dirname(file), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      return ledger
    }
  })
}

export type RunReservation = { run: number; lease: string; plan: LiveRunPlan }

export async function reserveRunSlot(file: string, requestedRun: number): Promise<RunReservation> {
  return withLedgerLock(file, async () => {
    const ledger = await readLedger(file)
    if (ledger.halted) throw new Error(`model stage is halted: ${ledger.halted.reason}`)

    const interrupted = ledger.runs.find((entry) => entry.state === "reserved" || entry.state === "started")
    if (interrupted) {
      interrupted.state = "invalid"
      interrupted.finishedAt = isoNow()
      interrupted.failureCode = "interrupted-after-durable-reservation"
      ledger.halted = {
        at: isoNow(),
        run: interrupted.run,
        reason: "interrupted run slot remains consumed and cannot be retried",
      }
      ledger.updatedAt = isoNow()
      await atomicWrite(file, ledger)
      throw new Error(`run ${interrupted.run} was interrupted after reservation; model stage halted`)
    }

    const next = ledger.runs.find((entry) => entry.state === "planned")
    if (!next || next.run !== requestedRun)
      throw new Error(`run order mismatch; next durable slot is ${next?.run ?? "none"}, requested ${requestedRun}`)
    const priorFailure = ledger.runs.find((entry) => entry.run < requestedRun && entry.state !== "pass")
    if (priorFailure)
      throw new Error(`prior run ${priorFailure.run} is ${priorFailure.state}; fixed-order model stage cannot continue`)

    const consumed = ledger.historicalConsumedSessions + ledger.runs.filter((entry) => entry.state !== "planned").length
    if (consumed >= ledger.ceilingSessions) throw new Error("model session ceiling exhausted before reservation")

    const lease = crypto.randomUUID()
    next.state = "reserved"
    next.lease = lease
    next.reservedAt = isoNow()
    ledger.updatedAt = isoNow()
    await atomicWrite(file, ledger)
    return {
      run: next.run,
      lease,
      plan: {
        run: next.run,
        kind: next.kind,
        arm: next.arm,
        ...(next.task ? { task: next.task } : {}),
        maxProviderRequests: next.maxProviderRequests,
      },
    }
  })
}

async function updateReservedRun(
  file: string,
  reservation: RunReservation,
  update: (run: PrivateRunLedger["runs"][number], ledger: PrivateRunLedger) => void,
) {
  return withLedgerLock(file, async () => {
    const ledger = await readLedger(file)
    const run = ledger.runs.find((entry) => entry.run === reservation.run)
    if (!run || run.lease !== reservation.lease) throw new Error("run reservation lease mismatch")
    update(run, ledger)
    ledger.updatedAt = isoNow()
    await atomicWrite(file, ledger)
    return ledger
  })
}

export function markRunStarted(file: string, reservation: RunReservation) {
  return updateReservedRun(file, reservation, (run) => {
    if (run.state !== "reserved") throw new Error(`cannot start run from state ${run.state}`)
    run.state = "started"
    run.startedAt = isoNow()
  })
}

export function finishRunSlot(
  file: string,
  reservation: RunReservation,
  result:
    | {
        state: "pass"
        evidence: NonNullable<PrivateRunLedger["runs"][number]["evidence"]>
      }
    | { state: "fail" | "invalid"; failureCode: string },
) {
  return updateReservedRun(file, reservation, (run, ledger) => {
    if (run.state !== "reserved" && run.state !== "started")
      throw new Error(`cannot finish run from state ${run.state}`)
    run.state = result.state
    run.finishedAt = isoNow()
    if (result.state === "pass") {
      run.evidence = result.evidence
    } else {
      run.failureCode = result.failureCode
      ledger.halted = { at: isoNow(), run: run.run, reason: result.failureCode }
    }
  })
}

export class ProviderBudgetExceeded extends Error {
  constructor(readonly maximum: number) {
    super(`provider request hard cap ${maximum} reached before forwarding`)
  }
}

export class ProviderGuardClosed extends Error {
  constructor(readonly reason: string) {
    super(`provider guard is closed: ${reason}`)
  }
}

export type GuardAttempt = {
  ordinal: number
  startedAt: string
  outcome: "forwarded" | "failed" | "aborted"
}

export class ProviderRequestGuard {
  readonly attempts: GuardAttempt[] = []
  readonly #inflight = new Set<AbortController>()
  #closedReason: string | undefined
  #armed: boolean

  constructor(
    readonly maximum: number,
    initiallyArmed = true,
  ) {
    if (!Number.isInteger(maximum) || maximum <= 0) throw new Error("provider request maximum must be positive")
    this.#armed = initiallyArmed
  }

  get count() {
    return this.attempts.length
  }

  get closed() {
    return this.#closedReason !== undefined
  }

  get closedReason() {
    return this.#closedReason
  }

  get armed() {
    return this.#armed
  }

  arm() {
    if (this.#closedReason) throw new ProviderGuardClosed(this.#closedReason)
    this.#armed = true
  }

  close(reason: string) {
    if (!this.#closedReason) this.#closedReason = reason
    for (const controller of this.#inflight) controller.abort(new ProviderGuardClosed(this.#closedReason))
  }

  async forward<T>(forwarder: (signal: AbortSignal, ordinal: number) => Promise<T>): Promise<T> {
    if (this.#closedReason) throw new ProviderGuardClosed(this.#closedReason)
    if (!this.#armed) throw new ProviderGuardClosed("not-armed")
    if (this.attempts.length >= this.maximum) {
      this.close("provider-request-cap")
      throw new ProviderBudgetExceeded(this.maximum)
    }

    const controller = new AbortController()
    const attempt: GuardAttempt = {
      ordinal: this.attempts.length + 1,
      startedAt: isoNow(),
      outcome: "forwarded",
    }
    // Durable run reservation happens outside this class. Within the run,
    // increment before the callback can reach the provider.
    this.attempts.push(attempt)
    this.#inflight.add(controller)
    try {
      return await forwarder(controller.signal, attempt.ordinal)
    } catch (error) {
      attempt.outcome = controller.signal.aborted ? "aborted" : "failed"
      throw error
    } finally {
      this.#inflight.delete(controller)
    }
  }
}

export type PromptCompletionInput<T> = {
  timeoutMs: number
  guard: ProviderRequestGuard
  prompt: (signal: AbortSignal) => Promise<T>
  status: () => Promise<"idle" | "busy" | "retry" | "unknown">
  abortSession: () => Promise<void>
  isCompletedAssistant: (result: T) => boolean
}

export async function promptToCompletedIdle<T>(input: PromptCompletionInput<T>): Promise<T> {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("prompt timeout must be positive")
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      input.guard.close("turn-timeout")
      controller.abort(new Error("turn-timeout"))
      reject(new Error(`prompt exceeded ${input.timeoutMs}ms`))
      void Promise.race([
        input.abortSession(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000)
        }),
      ]).catch(() => undefined)
    }, input.timeoutMs)
  })

  try {
    // A synchronous prompt RPC resolves only after the host loop returns. Do
    // not infer completion from assistant counts or a quiet polling window.
    const operation = async () => {
      const result = await input.prompt(controller.signal)
      if (!input.isCompletedAssistant(result))
        throw new Error("prompt RPC did not return a completed assistant response")
      const status = await input.status()
      if (status !== "idle") throw new Error(`session is ${status} after completed prompt RPC`)
      return result
    }
    return await Promise.race([operation(), timeout])
  } catch (error) {
    input.guard.close(error instanceof Error ? error.message : "prompt-failed")
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
