// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as AgentSchedulerState from "./agent-scheduler-state"

import type { Deferred } from "effect"

/**
 * Process-wide scheduler state (Issue #1021, PR5).
 *
 * Concurrency limits must hold for every layer graph in one process: the app
 * runtime, the bootstrap runtime, and each instance runtime share one model
 * budget and one child-run budget. `EngineProcess` is the only process-level
 * mutable registry in the engine, so the counters live here and the behavior
 * lives in `agent-scheduler.ts`.
 *
 * Requests and child runs are tracked separately:
 *
 * - A request permit wraps one model stream. It is acquired when the stream
 *   starts and released when the underlying stream ends, fails, or is
 *   interrupted (never after tool execution).
 * - A child slot wraps one spawned child run (DAG node or task subagent). It
 *   outlives the request permits inside that run.
 */

export type Lane = "interactive" | "side" | "parent_wake" | "child" | "background" | "auxiliary"

export type LimitKey =
  | { readonly kind: "workflow"; readonly workflowID: string }
  | { readonly kind: "task"; readonly parentSessionID: string }

/** One queued model-stream request. `grant` completes inside the granting sync block. */
export interface RequestWaiter {
  readonly lane: Lane
  readonly providerID: string
  readonly modelID: string
  readonly sessionID: string
  /** Prompt-cache group this waiter belongs to, when staggered. */
  readonly cacheGroup?: string
  /** Sibling stagger requested for this waiter; only child-lane requests opt in. */
  readonly staggerSiblings?: boolean
  readonly grant: Deferred.Deferred<void>
  granted: boolean
  cancelled: boolean
}

/**
 * Gate shared by the child runs of one cache group. `open` turns true when the
 * leader streams its first content, releases its permit, or its stagger window
 * elapses. While closed, siblings queue behind the leader.
 */
export interface CacheGroupState {
  open: boolean
  inflight: number
}

/** One queued child-run request. `grant` completes inside the granting sync block. */
export interface SlotWaiter {
  readonly limit: LimitKey
  readonly cap: number
  readonly rootSessionID: string
  readonly grant: Deferred.Deferred<void>
  granted: boolean
  cancelled: boolean
}

export interface SchedulerLimits {
  readonly global: number
  readonly perProvider: number
  readonly childGlobal: number
  readonly taskReserve: number
  readonly dagConcurrency: number
}

/**
 * Draft defaults from Issue #1021. They are deliberately centralized here so a
 * later measurement PR adjusts one place; `engine.concurrency` overrides each
 * value and `dag.concurrency` overrides the DAG-wide child layer.
 */
export const DEFAULT_LIMITS: SchedulerLimits = {
  global: 24,
  perProvider: 12,
  childGlobal: 16,
  taskReserve: 2,
  dagConcurrency: 12,
}

export interface RequestState {
  inflight: number
  readonly byProvider: Map<string, number>
  readonly byLane: Map<Lane, number>
  /** Epoch millis until which the provider/model pair refuses child and background permits. */
  readonly penalizedUntil: Map<string, number>
  readonly waiters: RequestWaiter[]
  lastGrantedLane?: Lane
}

export interface ChildState {
  inflight: number
  /** DAG-wide layer shared by every workflow in the process. */
  dagGlobal: number
  readonly byWorkflow: Map<string, number>
  readonly byTaskParent: Map<string, number>
  /** Last requested cap per workflow (already truncated to the effective layer). */
  readonly workflowCaps: Map<string, number>
  /** Last effective cap a truncation warning was logged for, one per workflow. */
  readonly warnedCaps: Map<string, number>
  /** Last requested cap per task parent. */
  readonly taskCaps: Map<string, number>
  readonly waiters: SlotWaiter[]
  lastGrantedRoot?: string
}

export interface SchedulerState {
  requests: RequestState
  children: ChildState
  /** Per-cache-group stagger gates, keyed by `CacheGroup.cacheGroupOf`. */
  readonly cacheGroups: Map<string, CacheGroupState>
  /** Latest limits observed by an acquiring effect; releases pump against these. */
  limits: SchedulerLimits
}

export const makeState = (limits: SchedulerLimits = DEFAULT_LIMITS): SchedulerState => ({
  requests: {
    inflight: 0,
    byProvider: new Map(),
    byLane: new Map(),
    penalizedUntil: new Map(),
    waiters: [],
  },
  children: {
    inflight: 0,
    dagGlobal: 0,
    byWorkflow: new Map(),
    byTaskParent: new Map(),
    workflowCaps: new Map(),
    warnedCaps: new Map(),
    taskCaps: new Map(),
    waiters: [],
  },
  cacheGroups: new Map(),
  limits,
})
