// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PrWatchEntry } from "@graphagent/sdk"
import { prLineFacts, type PrAssistant, type PrSession } from "../../src/pr/state"
import type { PrBandItem } from "../../src/shell/pr-tracker-context"

/** Tracked PRs as the status band is handed them: a watch entry and the facts `prLineFacts` makes of it at `T0`. */

export const T0 = 1_700_000_000_000
export const MINUTE = 60_000

export function prEntry(over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return {
    sessionID: "ses_test",
    watchID: "watch_1",
    url: "https://example.test/acme/repo/pull/1035",
    provider: "github",
    number: 1035,
    phase: "succeeded",
    outcome: "success",
    startedAt: T0 - 10 * MINUTE,
    updatedAt: T0,
    deadlineAt: T0 + 60 * MINUTE,
    ...over,
  }
}

export const idle: PrSession = { status: "idle", assistants: [] }
export const busy: PrSession = { status: "busy", assistants: [] }

/** A PR as the tracker lists it. The watch ID follows the number, so several PRs are several watches. */
export function bandItem(
  over: Partial<PrWatchEntry> = {},
  session: PrSession = idle,
  assistants: PrAssistant[] = [],
): PrBandItem {
  const base = prEntry({ watchID: `watch_${over.number ?? 1035}`, ...over })
  return {
    watchID: base.watchID,
    url: base.url,
    number: base.number,
    entry: base,
    state: prLineFacts(base, { ...session, assistants }, T0),
  }
}

/** CI is being watched, four checks of six passed: `CI 4/6`. */
export const ciItem = (over: Partial<PrWatchEntry> = {}) =>
  bandItem({ phase: "watching", outcome: undefined, checks: { total: 6, pending: 2, failed: 0, passed: 4 }, ...over })

/** Delivered and the agent is at work on it: `✓ 通过 · agent 处理中`. */
export const workingItem = (over: Partial<PrWatchEntry> = {}) =>
  bandItem({ delivery: { state: "delivered", deliveredAt: T0 }, ...over }, busy)

/** Owed for over three minutes: the agent is not responding (a sticky warning). */
export const unresponsiveItem = (over: Partial<PrWatchEntry> = {}) =>
  bandItem({ phase: "delivering", delivery: { state: "pending" }, updatedAt: T0 - 4 * MINUTE, ...over })

/** Delivered without a turn, the session was stopped (a sticky warning), the PR failed. */
export const stoppedItem = (over: Partial<PrWatchEntry> = {}) =>
  bandItem({ outcome: "failure", delivery: { state: "delivered", deliveredAt: T0, noReply: true }, ...over })
