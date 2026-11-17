// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PrWatchEntry } from "@graphagent/sdk"
import { createContext, useContext } from "solid-js"
import type { PrLineState } from "../pr/state"

/** One tracked PR the status band shows for a root session (#1036 F6). */
export interface PrBandItem {
  readonly watchID: string
  /** The PR's URL, opened in the system browser by a click on the PR line. */
  readonly url: string
  readonly number: number
  readonly entry: Pick<PrWatchEntry, "number" | "checks">
  /** Never hidden: an item whose state is hidden is not listed. */
  readonly state: PrLineState
}

/** The nearest reminder of a root session, as the status band draws it. */
export interface ReminderBandItem {
  /** How long until it fires, minute-grained (`<1m`, `5m`, `1h 5m`); undefined once it is due. */
  readonly when: string | undefined
  /** The reminder's own text, already passed through `remoteLine`. */
  readonly text: string
  readonly due: boolean
}

/**
 * What the status band reads about tracked PRs and reminders. The tracker owns everything that moves with time or
 * with events: the hand-off judgement, the warnings it holds after the server dropped their entries, the one-shot
 * `ticker.at` callbacks and the toasts. The band only lays out what it is given, so it subscribes to no clock.
 */
export interface PrTracker {
  /** Shown PRs of the root session: sticky warnings first, then the newest watch first. Reactive. */
  items(rootSessionID: string | undefined): readonly PrBandItem[]
  /** The nearest reminder of the root session, or undefined when it has none. Reactive. */
  reminder(rootSessionID: string | undefined): ReminderBandItem | undefined
}

const PrTrackerContext = createContext<PrTracker>()

export const PrTrackerProvider = PrTrackerContext.Provider

/** Undefined outside the provider (tests that mount the band alone show no PR and no reminder). */
export function usePrTracker(): PrTracker | undefined {
  return useContext(PrTrackerContext)
}
