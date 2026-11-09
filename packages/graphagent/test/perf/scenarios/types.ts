// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { Effect, Layer, Scope } from "effect"
import type { TestInstance } from "../../fixture/fixture"
import type { Counters } from "../../lib/engine-probe"

export type ScenarioID = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7"

/** The two books the baseline stores for one measured window. */
export interface Measurement {
  /** Whole-window counters (`perTurn`). */
  readonly counts: Counters
  /** Provider requests in the window. */
  readonly steps: number
  /** Median counter delta per request (`perStep`). */
  readonly perStep: Counters
}

export interface ScenarioInstanceOptions {
  readonly git?: boolean
  readonly config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>)
  readonly init?: (directory: string) => Effect.Effect<void, never, never>
}

/**
 * One measurable scenario. `run` performs the warm-up and the two measured
 * passes the determinism assertions need, and returns the last pass so the
 * count gate can compare it against `engine-baseline.json`. Keeping the body in
 * this module (rather than in the test file) lets both the scenario test and
 * the gate execute the exact same measurement.
 */
export interface Scenario<A, R> {
  readonly id: ScenarioID
  readonly layer: Layer.Layer<R, never, never>
  readonly instance: ScenarioInstanceOptions
  /** Bun test timeout for one scenario run, in milliseconds. */
  readonly timeout: number
  /**
   * The error channel stays `unknown`: scenarios propagate `PromptError`,
   * `NotFoundError` and the DAG's defects unchanged, and the harness fails the
   * run on any of them. Narrowing it here would force each scenario to `orDie`
   * and change behavior.
   */
  readonly run: Effect.Effect<A, unknown, R | TestInstance | Scope.Scope>
}
