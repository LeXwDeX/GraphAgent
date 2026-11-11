// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createBtwController, MAX_BTW_ENTRIES, parseBtwArgs, type BtwRequestResult } from "../../src/context/btw"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function controller(overrides: {
  request?: (input: { sessionID: string; id: string; question: string }) => Promise<BtwRequestResult>
  cancel?: (input: { sessionID: string; id: string }) => Promise<void>
}) {
  let clock = 1000
  let sequence = 0
  const requested: Array<{
    sessionID: string
    id: string
    question: string
    model?: { providerID: string; modelID: string }
  }> = []
  const cancelled: string[] = []
  const result = createBtwController({
    request: async (input) => {
      requested.push(input)
      return (
        overrides.request?.(input) ??
        Promise.resolve({
          type: "answer",
          data: {
            answer: "because",
            model: { providerID: "p", modelID: "m" },
            usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 2 },
            context: { messages: 4, truncated: false, inFlightDropped: false },
          },
        })
      )
    },
    cancel: async (input) => {
      cancelled.push(input.id)
      await overrides.cancel?.(input)
    },
    now: () => clock,
    createID: () => `btw_${sequence++}`,
  })
  return {
    result,
    requested,
    cancelled,
    tick(value = 1) {
      clock += value
    },
  }
}

describe("btw controller", () => {
  test("keeps at most 20 entries per session and drops the oldest", async () => {
    const fixture = controller({})
    for (let index = 0; index < MAX_BTW_ENTRIES + 5; index++) await fixture.result.ask("ses_1", `q${index}`)

    const entries = fixture.result.entries("ses_1")
    expect(entries).toHaveLength(MAX_BTW_ENTRIES)
    expect(entries[0]?.question).toBe("q5")
    expect(fixture.result.latest("ses_1")?.question).toBe(`q${MAX_BTW_ENTRIES + 4}`)
    expect(fixture.result.entries("ses_2")).toEqual([])
  })

  test("moves pending to done with answer, model, usage and context", async () => {
    const gate = deferred<BtwRequestResult>()
    const fixture = controller({ request: () => gate.promise })
    const asking = fixture.result.ask("ses_1", "why?", { model: { providerID: "a", modelID: "b" } })

    expect(fixture.result.latest("ses_1")).toMatchObject({
      status: "pending",
      question: "why?",
      model: { providerID: "a", modelID: "b" },
      startedAt: 1000,
    })

    fixture.tick(5)
    gate.resolve({
      type: "answer",
      data: {
        answer: "because",
        model: { providerID: "p", modelID: "m" },
        usage: { inputTokens: 3, outputTokens: 5 },
        context: { messages: 4, truncated: true, inFlightDropped: true },
      },
    })
    const result = await asking

    expect(result).toMatchObject({ type: "entry", entry: { status: "done" } })
    expect(fixture.result.latest("ses_1")).toMatchObject({
      status: "done",
      answer: "because",
      model: { providerID: "p", modelID: "m" },
      usage: { inputTokens: 3, outputTokens: 5 },
      context: { messages: 4, truncated: true, inFlightDropped: true },
      finishedAt: 1005,
    })
  })

  test("records transport errors on the entry", async () => {
    const fixture = controller({ request: () => Promise.reject(new Error("upstream exploded")) })
    const result = await fixture.result.ask("ses_1", "why?")

    expect(result).toMatchObject({ type: "entry", entry: { status: "error", error: "upstream exploded" } })
    expect(fixture.result.latest("ses_1")?.status).toBe("error")
  })

  test("a busy response keeps no entry and reports busy once", async () => {
    const fixture = controller({ request: () => Promise.resolve({ type: "busy" }) })
    const result = await fixture.result.ask("ses_1", "why?")

    expect(result).toEqual({ type: "busy" })
    expect(fixture.result.entries("ses_1")).toEqual([])
    expect(fixture.result.latest("ses_1")).toBeUndefined()
  })

  test("cancelling marks pending entries and ignores a late response", async () => {
    const gate = deferred<BtwRequestResult>()
    const fixture = controller({ request: () => gate.promise })
    const asking = fixture.result.ask("ses_1", "why?")

    await fixture.result.cancel("ses_1")
    expect(fixture.cancelled).toEqual(["btw_0"])
    expect(fixture.result.latest("ses_1")).toMatchObject({ status: "cancelled", finishedAt: 1000 })

    gate.resolve({
      type: "answer",
      data: {
        answer: "late",
        model: { providerID: "p", modelID: "m" },
        context: { messages: 1, truncated: false, inFlightDropped: false },
      },
    })
    await asking

    expect(fixture.result.latest("ses_1")).toMatchObject({ status: "cancelled", finishedAt: 1000 })
    expect(fixture.result.latest("ses_1")?.answer).toBeUndefined()
  })

  test("cancelling leaves finished entries and other sessions alone", async () => {
    const fixture = controller({})
    await fixture.result.ask("ses_1", "done question")
    await fixture.result.ask("ses_2", "other question")

    await fixture.result.cancel("ses_1")
    expect(fixture.cancelled).toEqual([])
    expect(fixture.result.latest("ses_1")?.status).toBe("done")
    expect(fixture.result.latest("ses_2")?.status).toBe("done")
  })

  test("session deletion drops only that session's history", async () => {
    const fixture = controller({})
    await fixture.result.ask("ses_1", "first")
    fixture.result.dismiss("ses_1")
    await fixture.result.ask("ses_2", "second")

    fixture.result.forget("ses_1")

    expect(fixture.result.entries("ses_1")).toEqual([])
    expect(fixture.result.latest("ses_1")).toBeUndefined()
    expect(fixture.result.isDismissed("ses_1")).toBe(false)
    expect(fixture.result.latest("ses_2")?.question).toBe("second")
  })

  test("dismiss closes the panel state and a new question reopens it", async () => {
    const fixture = controller({})
    await fixture.result.ask("ses_1", "first")
    expect(fixture.result.isDismissed("ses_1")).toBe(false)

    fixture.result.dismiss("ses_1")
    expect(fixture.result.isDismissed("ses_1")).toBe(true)

    await fixture.result.ask("ses_1", "second")
    expect(fixture.result.isDismissed("ses_1")).toBe(false)
  })

  test("show reopens a dismissed session only when it has history", async () => {
    const fixture = controller({})
    fixture.result.dismiss("ses_1")
    fixture.result.show("ses_1")
    expect(fixture.result.isDismissed("ses_1")).toBe(true)

    await fixture.result.ask("ses_1", "first")
    fixture.result.dismiss("ses_1")
    fixture.result.show("ses_1")
    expect(fixture.result.isDismissed("ses_1")).toBe(false)
  })

  test("server-side cancellation settles as cancelled", async () => {
    const fixture = controller({ request: () => Promise.resolve({ type: "cancelled" }) })
    const result = await fixture.result.ask("ses_1", "why?")

    expect(result).toMatchObject({ type: "entry", entry: { status: "cancelled" } })
  })

  test("empty questions are ignored without a request", async () => {
    const fixture = controller({})
    expect(await fixture.result.ask("ses_1", "   ")).toEqual({ type: "ignored" })
    expect(fixture.requested).toEqual([])
    expect(fixture.result.entries("ses_1")).toEqual([])
  })
})

describe("btw argument parsing", () => {
  test("plain question", () => {
    expect(parseBtwArgs("why does this fail?")).toEqual({ question: "why does this fail?" })
  })

  test("model flag", () => {
    expect(parseBtwArgs("-m provider/model why?")).toEqual({
      question: "why?",
      model: { providerID: "provider", modelID: "model" },
    })
  })

  test("model flag with nested model id keeps the remainder", () => {
    expect(parseBtwArgs("-m openrouter/anthropic/claude question")).toEqual({
      question: "question",
      model: { providerID: "openrouter", modelID: "anthropic/claude" },
    })
  })

  test("leading whitespace from the slash separator is ignored", () => {
    expect(parseBtwArgs("  -m provider/model why?")).toEqual({
      question: "why?",
      model: { providerID: "provider", modelID: "model" },
    })
    expect(parseBtwArgs("   why?")).toEqual({ question: "why?" })
  })

  test("model flag without a question keeps the input empty", () => {
    expect(parseBtwArgs("-m provider/model")).toEqual({
      question: "",
      model: { providerID: "provider", modelID: "model" },
    })
  })

  test("missing or malformed model value is rejected", () => {
    expect(parseBtwArgs("-m")).toBeUndefined()
    expect(parseBtwArgs("-m   ")).toBeUndefined()
    expect(parseBtwArgs("-m provider question")).toBeUndefined()
    expect(parseBtwArgs("-m /model question")).toBeUndefined()
    expect(parseBtwArgs("-m provider/ question")).toBeUndefined()
  })

  test("a flag-looking word that is not the first token stays part of the question", () => {
    expect(parseBtwArgs("-model is big")).toEqual({ question: "-model is big" })
    expect(parseBtwArgs("why -m provider/model")).toEqual({ question: "why -m provider/model" })
  })

  test("multi-line questions keep inner newlines", () => {
    expect(parseBtwArgs("first line\nsecond line")).toEqual({ question: "first line\nsecond line" })
  })
})
