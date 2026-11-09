// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { RequestFingerprint } from "../lib/fake-provider"

// The request fingerprint recorded in `engine-baseline.json`. The gate compares
// the multiset of shapes: a scenario must issue the same kinds of requests
// (same purpose, tool set, tool choice and history length) as the baseline.
// `systemHash` and `prefixHash` are recorded for review but not compared: they
// are the H6 prefix-invariant measurements, and they legitimately change when
// a prompt or system text changes.
export interface BaselineRequest {
  readonly purpose: string
  readonly messageCount: number
  readonly toolsHash: string
  readonly systemHash: string
  readonly prefixHash: string
  readonly toolChoice: string
}

/** Drop auxiliary/title requests and keep the fields the baseline stores. */
export function fingerprintRequests(requests: ReadonlyArray<RequestFingerprint>): BaselineRequest[] {
  return requests
    .filter((request) => request.purpose !== "auxiliary" && !request.small)
    .map((request) => ({
      purpose: request.purpose,
      messageCount: request.messageCount,
      toolsHash: request.toolsHash,
      systemHash: request.systemHash,
      prefixHash: request.prefixHash,
      toolChoice: request.toolChoice,
    }))
}
