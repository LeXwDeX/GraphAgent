// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DatabaseMetrics } from "@graphagent/core/database/metrics"
import { Hash } from "@graphagent/core/util/hash"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { PartID, type SessionID } from "./schema"

/**
 * HS14 (#1028 PR1): per-step observability for prompt-cache stability.
 *
 * Every provider request records its timing, token usage, database/process
 * work, and a fingerprint of the request prefix. Consecutive requests in one
 * session compare fingerprints, and a change logs which segment moved, so a
 * cache-destroying request is traceable without reproducing the turn.
 */

export interface PrefixFingerprint {
  readonly tools: string
  readonly system: string
  readonly prefix: string
  readonly toolChoice: string
  /**
   * Per-message digests. A whole-list digest necessarily changes on every
   * normal step (the history grows), so prefix identity is decided by
   * comparing this array instead.
   */
  readonly messageHashes: readonly string[]
  /**
   * Digest of each named system section (Issue #1458), so a changed `system` can be traced to the section that
   * moved. Absent when the request carried no labels or not one per text.
   */
  readonly sections?: Readonly<Record<string, string>>
}

export interface StepMetrics {
  readonly sessionID: SessionID
  readonly step: number
  readonly prepareMs: number
  readonly requestMs: number
  readonly ttftMs: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly input: number
  readonly sqlCount: number
  readonly commits: number
  readonly gitSpawns: number
  readonly fingerprint: PrefixFingerprint
}

export type FingerprintSegment = "tools" | "system" | "prefix" | "tool_choice"

/**
 * The sections of the system prompt `buildTurnRequest` assembles, in prompt order. A request labels each system
 * text with one of them so the change log can name the section that moved.
 */
export const SYSTEM_SECTIONS = [
  "environment",
  "language",
  "instructions",
  "mcp_instructions",
  "skills",
  "goal",
  "hooks",
  "dag",
  "runtime_note",
  "structured_output",
  "one_shot_event",
] as const

export type SystemSection = (typeof SYSTEM_SECTIONS)[number]

/**
 * Sections that may differ between two requests of one session: the model, project references, instruction
 * files, MCP servers, skills and hooks are reloaded or switched while a session runs, the structured-output
 * note only applies to some turns, and the one-shot event is the registered exception for a history that ends
 * with an assistant message. A change in any other section is not a registered exception to prefix stability.
 */
export const VOLATILE_SYSTEM_SECTIONS: ReadonlySet<SystemSection> = new Set(
  SYSTEM_SECTIONS.filter((name) => !["language", "goal", "dag", "runtime_note"].includes(name)),
)

/** Process-wide git child-process counter; the step reports the difference. */
let gitSpawns = 0

export function recordGitSpawn(): void {
  gitSpawns += 1
}

export interface StepCounters {
  readonly sqlCount: number
  readonly commits: number
  readonly gitSpawns: number
}

/** Monotonic counters; subtract two snapshots to scope them to one step. */
export function counters(): StepCounters {
  const database = DatabaseMetrics.snapshot()
  return { sqlCount: database.sqlCount, commits: database.commits, gitSpawns }
}

/** The usage of one provider request as `Session.getUsage` reports it. */
export interface StepUsage {
  readonly cost: number
  readonly tokens: SessionV1.StepFinishPart["tokens"]
}

export interface StepMetricsInput {
  readonly sessionID: SessionID
  readonly step: number
  /** `performance.now()` marks of the processor: process entry, request start, first streamed token, step end. */
  readonly processStartedAt: number
  readonly stepStartedAt: number
  readonly firstTokenAt: number | undefined
  readonly now: number
  readonly usage: StepUsage
  /** The counters at the previous step end (or process entry), and now. */
  readonly base: StepCounters
  readonly current: StepCounters
  readonly fingerprint: PrefixFingerprint
}

/** The in-memory record of one step: timing and usage from the processor's marks, counters scoped to the step. */
export function stepMetricsOf(input: StepMetricsInput): StepMetrics {
  return {
    sessionID: input.sessionID,
    step: input.step,
    prepareMs: input.stepStartedAt - input.processStartedAt,
    requestMs: input.now - input.stepStartedAt,
    ttftMs: input.firstTokenAt === undefined ? 0 : input.firstTokenAt - input.stepStartedAt,
    cacheRead: input.usage.tokens.cache.read,
    cacheWrite: input.usage.tokens.cache.write,
    input: input.usage.tokens.input,
    sqlCount: input.current.sqlCount - input.base.sqlCount,
    commits: input.current.commits - input.base.commits,
    gitSpawns: input.current.gitSpawns - input.base.gitSpawns,
    fingerprint: input.fingerprint,
  }
}

/**
 * #1473: the tool and retry counts of the step in progress. The tool-call state
 * machine counts the calls that reach a terminal state. `retries` is the retry
 * policy's own number, which counts from 1 over one processing run, so the step
 * that finally goes through reports how many retries it needed. The processor
 * starts a fresh one when the step finishes and when a run begins.
 */
export interface StepStats {
  toolCalls: number
  toolErrors: number
  retries: number
}

export function makeStepStats(): StepStats {
  return { toolCalls: 0, toolErrors: 0, retries: 0 }
}

/**
 * Durable events encode `NonNegativeInt`, so a `performance.now()` difference is rounded, and a value that is
 * negative or not finite becomes 0 instead of failing the publish.
 */
function wholeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** What a `step-finish` part persists of one step: whole-millisecond timings and the step's tool and retry counts. */
export function finishMetricsOf(step: StepMetrics, stats: StepStats): SessionV1.StepFinishMetrics {
  return {
    prepareMs: wholeMs(step.prepareMs),
    requestMs: wholeMs(step.requestMs),
    ttftMs: wholeMs(step.ttftMs),
    toolCalls: stats.toolCalls,
    toolErrors: stats.toolErrors,
    retries: stats.retries,
  }
}

export interface StepFinishInput {
  readonly message: Pick<SessionV1.Assistant, "id" | "sessionID">
  readonly reason: string
  readonly snapshot: string | undefined
  readonly usage: StepUsage
  /** Left off the part when absent, so a step that took no metrics persists exactly what it did before. */
  readonly metrics: SessionV1.StepFinishMetrics | undefined
}

/** The `step-finish` part that settles one provider request. */
export function stepFinishPart(input: StepFinishInput): SessionV1.StepFinishPart {
  return {
    id: PartID.ascending(),
    reason: input.reason,
    snapshot: input.snapshot,
    messageID: input.message.id,
    sessionID: input.message.sessionID,
    type: "step-finish",
    tokens: input.usage.tokens,
    cost: input.usage.cost,
    ...(input.metrics ? { metrics: input.metrics } : {}),
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stable(entry))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  )
}

/** Stable digest of any JSON-shaped value; object key order never matters. */
export function digestValue(value: unknown): string {
  return Hash.sha256(JSON.stringify(stable(value)) ?? "undefined")
}

export interface FingerprintInput {
  /** Model-facing tool definitions, already reduced to their serialized shape. */
  readonly tools: unknown
  readonly system: readonly string[]
  /** Section of each `system` text, same length and order. Ignored when the lengths differ. */
  readonly systemLabels?: readonly SystemSection[] | undefined
  readonly messages: readonly unknown[]
  readonly toolChoice?: string | undefined
}

/** One digest per section, over that section's texts in prompt order; undefined without one label per text. */
function sectionDigests(
  system: readonly string[],
  labels: readonly SystemSection[] | undefined,
): Record<string, string> | undefined {
  if (labels === undefined || labels.length !== system.length) return undefined
  const grouped = new Map<string, string[]>()
  system.forEach((text, index) => {
    const name = labels[index]
    grouped.set(name, [...(grouped.get(name) ?? []), text])
  })
  return Object.fromEntries([...grouped].map(([name, texts]) => [name, digestValue(texts)]))
}

export function fingerprintOf(input: FingerprintInput): PrefixFingerprint {
  const messageHashes = input.messages.map(digestValue)
  const sections = sectionDigests(input.system, input.systemLabels)
  return {
    tools: digestValue(input.tools),
    system: digestValue(input.system),
    prefix: digestValue(messageHashes),
    toolChoice: input.toolChoice ?? "auto",
    messageHashes,
    ...(sections === undefined ? {} : { sections }),
  }
}

function extendsPrefix(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length > next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

/**
 * Which request segments moved between two steps. A normal step appends to the
 * history and therefore rewrites the whole-list digest; it is not a prefix
 * break, so `prefix` is reported only when the previous message list is not an
 * actual prefix of the next one.
 */
export function explainFingerprintChange(
  previous: PrefixFingerprint,
  next: PrefixFingerprint,
): ReadonlyArray<FingerprintSegment> {
  const changed: FingerprintSegment[] = []
  if (previous.tools !== next.tools) changed.push("tools")
  if (previous.system !== next.system) changed.push("system")
  if (!extendsPrefix(previous.messageHashes, next.messageHashes)) changed.push("prefix")
  if (previous.toolChoice !== next.toolChoice) changed.push("tool_choice")
  return changed
}

/**
 * Which system sections moved between two steps: those whose digest differs and those that only one of the
 * steps carries, in ascending order. Empty when either step has no section digests.
 */
export function explainSectionChange(previous: PrefixFingerprint, next: PrefixFingerprint): string[] {
  const before = previous.sections
  const after = next.sections
  if (before === undefined || after === undefined) return []
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort()
}

const RING_CAPACITY = 50
const SESSION_CAPACITY = 100
const rings = new Map<SessionID, StepMetrics[]>()

/**
 * In-memory ring buffer of recent steps, keyed by session. Sessions are kept in
 * insertion order so a long-lived process cannot grow without bound; the
 * oldest session is dropped once the cap is reached.
 */
export const StepMetricsRing = {
  push(metrics: StepMetrics): void {
    let ring = rings.get(metrics.sessionID)
    if (!ring) {
      ring = []
      rings.set(metrics.sessionID, ring)
      while (rings.size > SESSION_CAPACITY) {
        const oldest = rings.keys().next().value
        if (oldest === undefined) break
        rings.delete(oldest)
      }
    }
    ring.push(metrics)
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
  },
  recent(sessionID: SessionID, count: number): ReadonlyArray<StepMetrics> {
    const ring = rings.get(sessionID)
    if (!ring || count <= 0) return []
    return ring.slice(Math.max(0, ring.length - count))
  },
  clear(sessionID: SessionID): void {
    rings.delete(sessionID)
  },
  sessions(): number {
    return rings.size
  },
}

/** The moved sections that are not registered as volatile; each one is a break of prefix stability. */
function unregisteredSections(sections: readonly string[]): string[] {
  const registered: ReadonlySet<string> = VOLATILE_SYSTEM_SECTIONS
  return sections.filter((name) => !registered.has(name))
}

/**
 * Store one step and log a segment-level explanation when its request prefix
 * differs from the previous step of the same session. Every detected change
 * produces a log entry naming the segments that moved (HS14 invariant 6). A
 * changed `system` also names the sections that moved; a change in a section
 * outside `VOLATILE_SYSTEM_SECTIONS` is logged as a warning.
 */
export function recordStep(metrics: StepMetrics): Effect.Effect<void> {
  return Effect.suspend(() => {
    const previous = StepMetricsRing.recent(metrics.sessionID, 1)[0]
    StepMetricsRing.push(metrics)
    if (!previous) return Effect.void
    const changed = explainFingerprintChange(previous.fingerprint, metrics.fingerprint)
    if (changed.length === 0) return Effect.void
    const sections = changed.includes("system") ? explainSectionChange(previous.fingerprint, metrics.fingerprint) : []
    const unregistered = unregisteredSections(sections)
    const fields = {
      "session.id": metrics.sessionID,
      step: metrics.step,
      previousStep: previous.step,
      segments: changed,
      ...(sections.length > 0 ? { sections } : {}),
      ...(unregistered.length > 0 ? { unregistered } : {}),
    }
    return unregistered.length > 0
      ? Effect.logWarning("session step fingerprint changed", fields)
      : Effect.logInfo("session step fingerprint changed", fields)
  })
}
