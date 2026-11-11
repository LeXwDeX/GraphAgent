// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DatabaseMetrics } from "@graphagent/core/database/metrics"
import { Hash } from "@graphagent/core/util/hash"
import { Effect } from "effect"
import type { SessionID } from "./schema"

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
  readonly messages: readonly unknown[]
  readonly toolChoice?: string | undefined
}

export function fingerprintOf(input: FingerprintInput): PrefixFingerprint {
  const messageHashes = input.messages.map(digestValue)
  return {
    tools: digestValue(input.tools),
    system: digestValue(input.system),
    prefix: digestValue(messageHashes),
    toolChoice: input.toolChoice ?? "auto",
    messageHashes,
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

/**
 * Store one step and log a segment-level explanation when its request prefix
 * differs from the previous step of the same session. Every detected change
 * produces a log entry naming the segments that moved (HS14 invariant 6).
 */
export function recordStep(metrics: StepMetrics): Effect.Effect<void> {
  return Effect.suspend(() => {
    const previous = StepMetricsRing.recent(metrics.sessionID, 1)[0]
    StepMetricsRing.push(metrics)
    if (!previous) return Effect.void
    const changed = explainFingerprintChange(previous.fingerprint, metrics.fingerprint)
    if (changed.length === 0) return Effect.void
    return Effect.logInfo("session step fingerprint changed", {
      "session.id": metrics.sessionID,
      step: metrics.step,
      previousStep: previous.step,
      segments: changed,
    })
  })
}
