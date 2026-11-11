// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Domain, Phase } from "@graphagent/schema/lifecycle-status"
import { isSettledValue, isTerminalValue, phaseOf } from "./vocabulary"

/**
 * A state reference and its observed projection (#1069 P1).
 *
 * `StateRef.get` reports what a registered resolver observes; it is not a
 * promise that the state can be reconstructed after a restart. Durable
 * reconstruction stays with each domain's owning store.
 */

export type StateSource = "live" | "persisted" | "derived"

export interface StateRef<D extends Domain = Domain> {
  readonly domain: D
  readonly id: string
}

export interface LifecycleState<D extends Domain = Domain> {
  readonly domain: D
  readonly id: string
  readonly value: string
  readonly phase: Phase
  readonly terminal: boolean
  readonly settled: boolean
  readonly source: StateSource
  readonly observedAt: number
}

export function ref<D extends Domain>(domain: D, id: string): StateRef<D> {
  return { domain, id }
}

export function stateOf<D extends Domain>(input: {
  readonly ref: StateRef<D>
  readonly value: string
  readonly source: StateSource
  /** Only for values the vocabulary cannot map, such as `turn` + `ended`. */
  readonly phase?: Phase
  /** Only for turn values whose outcome decides settlement. */
  readonly settled?: boolean
  readonly observedAt?: number
}): LifecycleState<D> {
  const phase = input.phase ?? phaseOf(input.ref.domain, input.value)
  if (phase === undefined) {
    throw new Error(`lifecycle state ${input.ref.domain}/${input.value} needs an explicit phase`)
  }
  return {
    domain: input.ref.domain,
    id: input.ref.id,
    value: input.value,
    phase,
    terminal: isTerminalValue(input.ref.domain, input.value),
    settled: input.settled ?? isSettledValue(input.ref.domain, input.value),
    source: input.source,
    observedAt: input.observedAt ?? Date.now(),
  }
}
