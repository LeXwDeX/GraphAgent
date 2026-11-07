import type { CounterKey, Counters } from "../lib/engine-probe"
import { COUNTER_KEYS } from "../lib/engine-probe"
import type { BaselineRequest } from "./fingerprint"
import type { Measurement, ScenarioID } from "./scenarios/types"

export type { BaselineRequest } from "./fingerprint"

// The committed count baseline for the H0 scenarios (Issue #1009).
//
// Each scenario records two books: `perTurn` is the whole measured window and
// `perStep` the median provider-request delta. The gate compares `perTurn`
// against the baseline plus the deltas `declared` by the PR that changed the
// number; `perStep` is recorded for review but not gated because a single
// request's share of the window depends on how the engine splits the turn.
//
// Volatile keys are those the scenario itself cannot reproduce exactly (the
// #523 dedup gate drops appends based on real-time payload equality; S5's
// 15-way concurrency reorders SQL). They are still recorded, but the gate skips
// them and the scenario test states the tolerance instead.

export interface ScenarioBaseline {
  readonly perTurn: Counters
  readonly perStep: Counters
  readonly steps: number
  readonly requests: ReadonlyArray<BaselineRequest>
  readonly volatile: ReadonlyArray<CounterKey>
}

export interface DeclaredDelta {
  /** PR number, for example "#1234". */
  readonly pr: string
  readonly metric: CounterKey
  /** Restricts the delta to one scenario; omitted means every scenario. */
  readonly scenario?: ScenarioID
  readonly delta: number
  readonly reason: string
}

export interface Baseline {
  readonly version: number
  readonly collectedAt: string
  readonly commit: string
  readonly scenarios: Partial<Record<ScenarioID, ScenarioBaseline>>
  readonly declared: ReadonlyArray<DeclaredDelta>
}

export interface ScenarioActual extends Measurement {
  readonly requests: ReadonlyArray<BaselineRequest>
}

export function baselineEntry(actual: ScenarioActual, volatile: ReadonlyArray<CounterKey>): ScenarioBaseline {
  return {
    perTurn: actual.counts,
    perStep: actual.perStep,
    steps: actual.steps,
    requests: actual.requests,
    volatile: [...volatile],
  }
}

/**
 * Compare one scenario against the baseline. Returns human-readable violations;
 * an empty list means the scenario stayed within every declared budget.
 */
export function compareScenario(id: ScenarioID, actual: ScenarioActual, baseline: Baseline): string[] {
  const entry = baseline.scenarios[id]
  if (!entry) return [`${id}: baseline entry is missing`]
  const violations: string[] = []
  for (const metric of COUNTER_KEYS) {
    if (entry.volatile.includes(metric)) continue
    const declared = baseline.declared
      .filter((delta) => delta.metric === metric && (delta.scenario === undefined || delta.scenario === id))
      .reduce((sum, delta) => sum + delta.delta, 0)
    const allowed = entry.perTurn[metric] + declared
    if (actual.counts[metric] > allowed) {
      violations.push(
        `${id}: ${metric} measured ${actual.counts[metric]}, over baseline ${entry.perTurn[metric]} + declared ${declared}`,
      )
    }
  }
  if (actual.steps !== entry.steps) {
    violations.push(`${id}: ${actual.steps} provider requests, baseline has ${entry.steps}`)
  }
  // Fingerprints are compared as a multiset: concurrent scenarios (S5) start
  // provider requests in a scheduling-dependent order, but the same set of
  // request shapes must appear.
  const shape = (request: BaselineRequest) =>
    [request.purpose, request.toolsHash, request.toolChoice, request.messageCount].join("|")
  const actualShapes = actual.requests.map(shape).sort()
  const expectedShapes = entry.requests.map(shape).sort()
  if (actualShapes.length !== expectedShapes.length) {
    violations.push(`${id}: ${actualShapes.length} fingerprinted requests, baseline has ${expectedShapes.length}`)
  } else {
    for (const [index, shapeValue] of actualShapes.entries()) {
      if (shapeValue !== expectedShapes[index]) {
        violations.push(`${id}: request shape ${shapeValue} has no baseline match (baseline ${expectedShapes[index]})`)
      }
    }
  }
  return violations
}
