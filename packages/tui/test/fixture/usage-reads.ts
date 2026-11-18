// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { spyOn } from "bun:test"
import type { useSDK } from "../../src/context/sdk"

/**
 * The reads of the usage endpoint (`GET /session/:id/usage`) that the sync layer makes, seen where it makes them: at
 * the SDK call (#1475). A test that says "nothing is read" or "one more read" can then ask the moment its trigger has
 * run. Sleeping and hoping that a request would have shown up at the fake server by then proves nothing: a read that
 * is slow to arrive passes the same check as a read that was never made.
 *
 * - `asked()` is the sessions the sync layer has asked about, in order. A call is counted when it is made, before
 *   the server hears of it, so a triggered read is in it by the time the call that triggered it returns.
 * - `answered()` returns once every read asked so far has been dealt with by the sync layer: its answer taken in,
 *   dropped, or logged as a failure. The sync layer awaits the promise the SDK call returns, and the continuation
 *   that follows has no further `await` in it. A reaction the test attaches to the same promise afterwards runs after
 *   that continuation, so the continuation has finished by then. A read it starts in turn (the one a trigger that
 *   came during a read asks for) is waited for as well.
 */
export function spyUsageReads(sdk: ReturnType<typeof useSDK>) {
  const spy = spyOn(sdk.client.session, "usage")
  return {
    asked: () => spy.mock.calls.map(([parameters]) => parameters.sessionID),
    /**
     * Make the next read fail inside the SDK call, as an interceptor or a bug that throws would. A connection that drops
     * does not do this: the client reports it as an answer without data, like an error status.
     */
    rejectNext(error: Error) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a rejected promise stands in for the request result the SDK call returns.
      spy.mockImplementationOnce((() => Promise.reject(error)) as unknown as typeof sdk.client.session.usage)
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

export type UsageReads = ReturnType<typeof spyUsageReads>
