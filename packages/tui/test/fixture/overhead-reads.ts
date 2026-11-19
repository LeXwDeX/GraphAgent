// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { spyOn } from "bun:test"
import type { useSDK } from "../../src/context/sdk"

/**
 * The reads of the fixed-overhead endpoint (`GET /session/:id/overhead`) that the sync layer makes, seen where it
 * makes them: at the SDK call (#1461). The same device as `usage-reads.ts`, for the same reason: a test that says
 * "nothing is read" or "one more read" can ask the moment its trigger has run, and a read that is slow to arrive does
 * not pass for a read that was never made.
 *
 * - `asked()` is the sessions the sync layer has asked about, in order, counted when the call is made.
 * - `answered()` returns once every read asked so far has been dealt with by the sync layer, a read started by the
 *   continuation of an earlier one included.
 */
export function spyOverheadReads(sdk: ReturnType<typeof useSDK>) {
  const spy = spyOn(sdk.client.session, "overhead")
  return {
    asked: () => spy.mock.calls.map(([parameters]) => parameters.sessionID),
    /** Make the next read fail inside the SDK call, as an interceptor or a bug that throws would. */
    rejectNext(error: Error) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a rejected promise stands in for the request result the SDK call returns.
      spy.mockImplementationOnce((() => Promise.reject(error)) as unknown as typeof sdk.client.session.overhead)
    },
    async answered() {
      // The length is read again every turn: a read started by the continuation of an earlier one joins the wait.
      for (let index = 0; index < spy.mock.results.length; index++) {
        const call = spy.mock.results[index]
        if (call.type === "return") await Promise.resolve(call.value).catch(() => undefined)
      }
    },
  }
}

export type OverheadReads = ReturnType<typeof spyOverheadReads>
