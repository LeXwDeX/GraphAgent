// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { untilAborted } from "../../src/session/llm"
import { makeToolCallGate } from "../../src/session/processor"

const abortError = { name: "AbortError" }

/** The reason a promise rejected with, or undefined when it did not reject. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe("session tool-call gate", () => {
  test("hands `execute` a verdict the processor settled first, without waiting", () => {
    const gate = makeToolCallGate({ wait: true })
    gate.settle("call-a")
    gate.settle("call-b", "dag_safety:SF-5: denied")

    expect(gate.verdict("call-a")).toBeUndefined()
    expect(gate.verdict("call-b")).toBe("dag_safety:SF-5: denied")
  })

  test("parks an `execute` that arrives before the verdict until the processor settles", async () => {
    const gate = makeToolCallGate({ wait: true })
    const admitted = gate.verdict("call-a")
    const denied = gate.verdict("call-b")
    expect(admitted).toBeInstanceOf(Promise)
    expect(denied).toBeInstanceOf(Promise)

    gate.settle("call-a")
    gate.settle("call-b", "dag_safety:SF-5: denied")

    expect(await admitted).toBeUndefined()
    expect(await denied).toBe("dag_safety:SF-5: denied")
  })

  test("keeps the first settlement of a call", () => {
    const gate = makeToolCallGate({ wait: true })
    gate.settle("call-a", "first")
    gate.settle("call-a")
    gate.settle("call-b")
    gate.settle("call-b", "late")

    expect(gate.verdict("call-a")).toBe("first")
    expect(gate.verdict("call-b")).toBeUndefined()
  })

  test("admits an unsettled call at once when no verdict can arrive late, yet still reads a recorded denial", () => {
    const gate = makeToolCallGate({ wait: false })
    expect(gate.verdict("call-a")).toBeUndefined()

    gate.settle("call-b", "dag_safety:SF-5: denied")
    expect(gate.verdict("call-b")).toBe("dag_safety:SF-5: denied")
  })

  test("close releases every parked `execute` and refuses to park another", async () => {
    const gate = makeToolCallGate({ wait: true })
    gate.settle("call-a", "dag_safety:SF-5: denied")
    const parked = gate.verdict("call-b")
    gate.close()

    expect(await rejection(Promise.resolve(parked))).toMatchObject(abortError)
    expect(await rejection(Promise.resolve(gate.verdict("call-c")))).toMatchObject(abortError)
    // A verdict the processor settled before the close still stands.
    expect(gate.verdict("call-a")).toBe("dag_safety:SF-5: denied")
    // And nothing settles after it.
    gate.settle("call-d")
    expect(await rejection(Promise.resolve(gate.verdict("call-d")))).toMatchObject(abortError)
  })
})

describe("session untilAborted", () => {
  test("passes the settled value through", async () => {
    const abort = new AbortController()
    const pending = Promise.withResolvers<string | undefined>()
    const waiting = untilAborted(pending.promise, abort.signal)
    pending.resolve("dag_safety:SF-5: denied")

    expect(await waiting).toBe("dag_safety:SF-5: denied")
  })

  test("ends the wait with an AbortError when the request aborts first and drops the late verdict", async () => {
    const abort = new AbortController()
    const pending = Promise.withResolvers<string | undefined>()
    const waiting = untilAborted(pending.promise, abort.signal)
    abort.abort()
    pending.resolve(undefined)

    expect(await rejection(waiting)).toMatchObject(abortError)
  })

  test("refuses to wait on a request that is already aborted", async () => {
    const abort = new AbortController()
    abort.abort()

    expect(await rejection(untilAborted(Promise.withResolvers<undefined>().promise, abort.signal))).toMatchObject(
      abortError,
    )
  })

  // The gate rejects its parked verdicts when the request closes, after the
  // abort has already won; nobody else observes that promise.
  for (const alreadyAborted of [true, false]) {
    test(`never leaves the late rejection of a wait abandoned ${alreadyAborted ? "on entry" : "while parked"} unhandled`, async () => {
      const unhandled: unknown[] = []
      const record = (reason: unknown) => unhandled.push(reason)
      process.on("unhandledRejection", record)
      try {
        const abort = new AbortController()
        const pending = Promise.withResolvers<string | undefined>()
        if (alreadyAborted) abort.abort()
        const waiting = untilAborted(pending.promise, abort.signal)
        if (!alreadyAborted) abort.abort()
        expect(await rejection(waiting)).toMatchObject(abortError)
        pending.reject(new DOMException("Aborted", "AbortError"))
        await Bun.sleep(20)
      } finally {
        process.off("unhandledRejection", record)
      }

      expect(unhandled).toEqual([])
    })
  }
})
