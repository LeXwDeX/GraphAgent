// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { SessionID } from "../../src/session/schema"
import {
  counters,
  explainFingerprintChange,
  fingerprintOf,
  recordGitSpawn,
  recordStep,
  StepMetricsRing,
  type StepMetrics,
} from "../../src/session/step-metrics"

const session = (name: string) => SessionID.make(`ses_${name}`)

function step(input: {
  sessionID: SessionID
  step?: number
  system?: string[]
  toolChoice?: string
  messages?: string[]
}): StepMetrics {
  return {
    sessionID: input.sessionID,
    step: input.step ?? 1,
    prepareMs: 1,
    requestMs: 2,
    ttftMs: 1,
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    sqlCount: 0,
    commits: 0,
    gitSpawns: 0,
    fingerprint: fingerprintOf({
      tools: [{ name: "read", description: "read a file" }],
      system: input.system ?? ["system"],
      messages: input.messages ?? ["m1"],
      toolChoice: input.toolChoice,
    }),
  }
}

test("the fingerprint ignores object key order", () => {
  const left = fingerprintOf({ tools: [{ name: "read", description: "d" }], system: ["s"], messages: [] })
  const right = fingerprintOf({ tools: [{ description: "d", name: "read" }], system: ["s"], messages: [] })

  expect(left.tools).toBe(right.tools)
  expect(left.system).toBe(right.system)
})

test("explains a changed system segment", () => {
  const previous = step({ sessionID: session("change-system") })
  const next = step({ sessionID: session("change-system"), system: ["system", "changed"] })

  expect(explainFingerprintChange(previous.fingerprint, next.fingerprint)).toEqual(["system"])
})

test("explains a changed tool choice", () => {
  const previous = step({ sessionID: session("change-choice"), toolChoice: "auto" })
  const next = step({ sessionID: session("change-choice"), toolChoice: "none" })

  expect(explainFingerprintChange(previous.fingerprint, next.fingerprint)).toEqual(["tool_choice"])
})

test("a changed tool definition is reported as tools", () => {
  const previous = fingerprintOf({ tools: [{ name: "read" }], system: ["s"], messages: [] })
  const next = fingerprintOf({ tools: [{ name: "write" }], system: ["s"], messages: [] })

  expect(explainFingerprintChange(previous, next)).toEqual(["tools"])
})

test("a normal append is not a prefix break", () => {
  const previous = step({ sessionID: session("append"), messages: ["m1"] })
  const next = step({ sessionID: session("append"), messages: ["m1", "m2"] })

  expect(explainFingerprintChange(previous.fingerprint, next.fingerprint)).toEqual([])
})

test("a rewritten message prefix is reported", () => {
  const previous = step({ sessionID: session("rewrite"), messages: ["m1", "m2"] })
  const next = step({ sessionID: session("rewrite"), messages: ["changed", "m2"] })

  expect(explainFingerprintChange(previous.fingerprint, next.fingerprint)).toEqual(["prefix"])
})

test("the ring keeps a bounded recent window per session", () => {
  const id = session("ring")
  for (let index = 1; index <= 60; index += 1) StepMetricsRing.push(step({ sessionID: id, step: index }))

  expect(StepMetricsRing.recent(id, 2).map((metrics) => metrics.step)).toEqual([59, 60])
  expect(StepMetricsRing.recent(id, 100)).toHaveLength(50)
  expect(StepMetricsRing.recent(session("ring-other"), 1)).toEqual([])
  StepMetricsRing.clear(id)
})

test("counters are monotonic", () => {
  const before = counters()
  recordGitSpawn()
  const after = counters()

  expect(after.gitSpawns).toBe(before.gitSpawns + 1)
  expect(after.sqlCount).toBeGreaterThanOrEqual(before.sqlCount)
  expect(after.commits).toBeGreaterThanOrEqual(before.commits)
})

async function collect(effect: Effect.Effect<void>): Promise<unknown[]> {
  const logs: unknown[] = []
  const logger = Logger.make((options) => {
    logs.push(options.message)
  })
  await Effect.runPromise(effect.pipe(Effect.withLogger(logger)))
  return logs
}

function fingerprintLog(logs: unknown[]): unknown[] | undefined {
  return logs.find(
    (message): message is unknown[] => Array.isArray(message) && message[0] === "session step fingerprint changed",
  )
}

test("logs the changed system segment", async () => {
  const id = session("log-system")
  StepMetricsRing.clear(id)
  const logs = await collect(
    Effect.gen(function* () {
      yield* recordStep(step({ sessionID: id, step: 1 }))
      yield* recordStep(step({ sessionID: id, step: 2, system: ["other"] }))
    }),
  )

  expect(fingerprintLog(logs)?.[1]).toMatchObject({ "session.id": id, step: 2, segments: ["system"] })
})

test("logs the changed tool choice segment", async () => {
  const id = session("log-choice")
  StepMetricsRing.clear(id)
  const logs = await collect(
    Effect.gen(function* () {
      yield* recordStep(step({ sessionID: id, step: 1, toolChoice: "auto" }))
      yield* recordStep(step({ sessionID: id, step: 2, toolChoice: "none" }))
    }),
  )

  expect(fingerprintLog(logs)?.[1]).toMatchObject({ "session.id": id, step: 2, segments: ["tool_choice"] })
})

test("does not log when the prefix is stable", async () => {
  const id = session("log-stable")
  StepMetricsRing.clear(id)
  const logs = await collect(
    Effect.gen(function* () {
      yield* recordStep(step({ sessionID: id, step: 1, messages: ["m1"] }))
      yield* recordStep(step({ sessionID: id, step: 2, messages: ["m1", "m2"] }))
    }),
  )

  expect(fingerprintLog(logs)).toBeUndefined()
})
