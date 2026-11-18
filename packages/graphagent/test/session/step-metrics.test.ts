// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { Effect, Logger, Schema } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  counters,
  digestValue,
  explainFingerprintChange,
  explainSectionChange,
  finishMetricsOf,
  fingerprintOf,
  makeStepStats,
  recordGitSpawn,
  recordStep,
  StepMetricsRing,
  stepFinishPart,
  stepMetricsOf,
  SYSTEM_SECTIONS,
  VOLATILE_SYSTEM_SECTIONS,
  type StepMetrics,
  type StepMetricsInput,
  type SystemSection,
} from "../../src/session/step-metrics"

const session = (name: string) => SessionID.make(`ses_${name}`)

function step(input: {
  sessionID: SessionID
  step?: number
  system?: string[]
  systemLabels?: SystemSection[]
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
      systemLabels: input.systemLabels,
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

async function collectEntries(effect: Effect.Effect<void>): Promise<Array<{ level: string; message: unknown }>> {
  const entries: Array<{ level: string; message: unknown }> = []
  const logger = Logger.make((options) => {
    entries.push({ level: options.logLevel, message: options.message })
  })
  await Effect.runPromise(effect.pipe(Effect.withLogger(logger)))
  return entries
}

async function collect(effect: Effect.Effect<void>): Promise<unknown[]> {
  return (await collectEntries(effect)).map((entry) => entry.message)
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

// Issue #1458: the change log names the system sections that moved, and a change of a
// section that is not registered as volatile is a warning.
const SECTION_LABELS: SystemSection[] = ["environment", "hooks", "goal"]

let sectionLogs = 0

async function sectionLog(first: string[], second: string[], labels?: SystemSection[]) {
  const id = session(`log-section-${(sectionLogs += 1)}`)
  StepMetricsRing.clear(id)
  const entries = await collectEntries(
    Effect.gen(function* () {
      yield* recordStep(step({ sessionID: id, step: 1, system: first, systemLabels: labels }))
      yield* recordStep(step({ sessionID: id, step: 2, system: second, systemLabels: labels }))
    }),
  )
  StepMetricsRing.clear(id)
  const entry = entries.find(
    (candidate) => Array.isArray(candidate.message) && candidate.message[0] === "session step fingerprint changed",
  )
  return { id, level: entry?.level, fields: Array.isArray(entry?.message) ? entry.message[1] : undefined }
}

test("the section names are fixed and the volatile set is the registered subset", () => {
  expect(SYSTEM_SECTIONS).toEqual([
    "environment",
    "language",
    "instructions",
    "mcp_instructions",
    "skills",
    "goal",
    "hooks",
    "dag",
    "runtime_note",
    "structured_output",
    "one_shot_event",
  ])
  expect([...VOLATILE_SYSTEM_SECTIONS].sort()).toEqual(
    SYSTEM_SECTIONS.filter((name) => !["language", "goal", "dag", "runtime_note"].includes(name)).sort(),
  )
})

test("a changed registered section is logged by name at info level", async () => {
  const { id, level, fields } = await sectionLog(
    ["env", "hooks v1", "no goal"],
    ["env", "hooks v2", "no goal"],
    SECTION_LABELS,
  )

  expect(level).toBe("Info")
  expect(fields).toMatchObject({
    "session.id": id,
    step: 2,
    previousStep: 1,
    segments: ["system"],
    sections: ["hooks"],
  })
  expect(fields).not.toHaveProperty("unregistered")
})

test("a changed section outside the volatile set is a warning that names it", async () => {
  const { id, level, fields } = await sectionLog(
    ["env", "hooks", "no goal"],
    ["env", "hooks", "a goal"],
    SECTION_LABELS,
  )

  expect(level).toBe("Warn")
  expect(fields).toMatchObject({
    "session.id": id,
    step: 2,
    segments: ["system"],
    sections: ["goal"],
    unregistered: ["goal"],
  })
})

test("an unregistered change keeps the registered sections that moved beside it", async () => {
  const { level, fields } = await sectionLog(
    ["env", "hooks v1", "no goal"],
    ["env", "hooks v2", "a goal"],
    SECTION_LABELS,
  )

  expect(level).toBe("Warn")
  expect(fields).toMatchObject({ sections: ["goal", "hooks"], unregistered: ["goal"] })
})

test("a system change without recorded labels is logged as before", async () => {
  const { id, level, fields } = await sectionLog(["system"], ["other"])

  expect(level).toBe("Info")
  expect(fields).toEqual({ "session.id": id, step: 2, previousStep: 1, segments: ["system"] })
})

test("sections group the texts of one label and need one label per text", () => {
  const labelled = fingerprintOf({
    tools: [],
    system: ["a", "b", "c"],
    systemLabels: ["instructions", "instructions", "skills"],
    messages: [],
  })
  expect(labelled.sections).toEqual({ instructions: digestValue(["a", "b"]), skills: digestValue(["c"]) })

  const short = fingerprintOf({ tools: [], system: ["a", "b"], systemLabels: ["instructions"], messages: [] })
  expect(short.sections).toBeUndefined()
  expect(fingerprintOf({ tools: [], system: ["a"], messages: [] }).sections).toBeUndefined()
})

test("explains which sections appeared, vanished or changed, in ascending order", () => {
  const two = fingerprintOf({ tools: [], system: ["e", "h"], systemLabels: ["environment", "hooks"], messages: [] })
  const three = fingerprintOf({
    tools: [],
    system: ["e", "h", "g"],
    systemLabels: ["environment", "hooks", "goal"],
    messages: [],
  })
  const edited = fingerprintOf({
    tools: [],
    system: ["e2", "h2"],
    systemLabels: ["environment", "hooks"],
    messages: [],
  })
  const unlabelled = fingerprintOf({ tools: [], system: ["e", "h"], messages: [] })

  expect(explainSectionChange(two, three)).toEqual(["goal"])
  expect(explainSectionChange(three, two)).toEqual(["goal"])
  expect(explainSectionChange(two, edited)).toEqual(["environment", "hooks"])
  expect(explainSectionChange(two, two)).toEqual([])
  expect(explainSectionChange(two, unlabelled)).toEqual([])
  expect(explainSectionChange(unlabelled, two)).toEqual([])
})

// ---------------------------------------------------------------------------
// #1473: the step-finish metrics
// ---------------------------------------------------------------------------

const usage = { cost: 0.5, tokens: { input: 11, output: 22, reasoning: 0, cache: { read: 33, write: 44 } } }

/** The processor's marks of one step: 30.5 ms of preparation, a first token at +49.5 ms, a finish at +119.75 ms. */
const marks = (overrides: Partial<StepMetricsInput> = {}): StepMetricsInput => ({
  sessionID: session("marks"),
  step: 3,
  processStartedAt: 100,
  stepStartedAt: 130.5,
  firstTokenAt: 180,
  now: 250.25,
  usage,
  base: { sqlCount: 10, commits: 2, gitSpawns: 1 },
  current: { sqlCount: 17, commits: 5, gitSpawns: 4 },
  fingerprint: fingerprintOf({ tools: [], system: ["s"], messages: [] }),
  ...overrides,
})

test("stepMetricsOf keeps the record the processor built inline before the metrics moved out of it", () => {
  const input = marks()
  expect(stepMetricsOf(input)).toEqual({
    sessionID: input.sessionID,
    step: 3,
    prepareMs: input.stepStartedAt - input.processStartedAt,
    requestMs: input.now - input.stepStartedAt,
    ttftMs: (input.firstTokenAt ?? 0) - input.stepStartedAt,
    cacheRead: 33,
    cacheWrite: 44,
    input: 11,
    sqlCount: input.current.sqlCount - input.base.sqlCount,
    commits: input.current.commits - input.base.commits,
    gitSpawns: input.current.gitSpawns - input.base.gitSpawns,
    fingerprint: input.fingerprint,
  })
})

test("stepMetricsOf reports a step that streamed no token as 0 ms to the first token", () => {
  expect(stepMetricsOf(marks({ firstTokenAt: undefined })).ttftMs).toBe(0)
})

test("finishMetricsOf rounds the durations to whole milliseconds and carries the step's counts", () => {
  const stats = { toolCalls: 4, toolErrors: 1, retries: 2 }
  const metrics = finishMetricsOf(stepMetricsOf(marks()), stats)
  expect(metrics).toEqual({ prepareMs: 31, requestMs: 120, ttftMs: 50, toolCalls: 4, toolErrors: 1, retries: 2 })
  // The durable event encodes against the schema, so the rounded value must pass it.
  expect(Schema.is(SessionV1.StepFinishMetrics)(metrics)).toBe(true)
  // The raw `performance.now()` differences do not.
  expect(Number.isInteger(stepMetricsOf(marks()).requestMs)).toBe(false)
})

test("finishMetricsOf never yields a value the integer schema would reject", () => {
  const odd = { ...stepMetricsOf(marks()), prepareMs: -0.4, requestMs: Number.NaN, ttftMs: Number.POSITIVE_INFINITY }
  const metrics = finishMetricsOf(odd, makeStepStats())
  expect(metrics).toEqual({ prepareMs: 0, requestMs: 0, ttftMs: 0, toolCalls: 0, toolErrors: 0, retries: 0 })
  expect(Schema.is(SessionV1.StepFinishMetrics)(metrics)).toBe(true)
})

test("makeStepStats starts every call with its own zero counts", () => {
  const first = makeStepStats()
  first.toolCalls += 2
  expect(makeStepStats()).toEqual({ toolCalls: 0, toolErrors: 0, retries: 0 })
})

test("stepFinishPart builds the part the processor used to write inline, and adds the metrics when there are any", () => {
  const message = { id: MessageID.make("msg_step"), sessionID: session("part") }
  const base = { message, reason: "stop", snapshot: "tree", usage }
  const metrics = { prepareMs: 1, requestMs: 2, ttftMs: 0, toolCalls: 0, toolErrors: 0, retries: 0 }

  const plain = stepFinishPart({ ...base, metrics: undefined })
  expect(plain).toEqual({
    id: expect.stringMatching(/^prt/),
    type: "step-finish",
    messageID: message.id,
    sessionID: message.sessionID,
    reason: "stop",
    snapshot: "tree",
    tokens: usage.tokens,
    cost: usage.cost,
  })
  expect("metrics" in plain).toBe(false)

  expect(stepFinishPart({ ...base, metrics }).metrics).toEqual(metrics)
  expect(stepFinishPart({ ...base, metrics }).id).not.toBe(plain.id)
})

test("a step-finish part written before the metrics existed still decodes", () => {
  const old = {
    id: "prt_old",
    sessionID: "ses_old",
    messageID: "msg_old",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const decode = Schema.decodeUnknownSync(SessionV1.StepFinishPart)
  const decoded: unknown = decode(old)
  expect(decoded).toEqual(old)
  const fractional = {
    ...old,
    metrics: { prepareMs: 1.5, requestMs: 2, ttftMs: 0, toolCalls: 0, toolErrors: 0, retries: 0 },
  }
  expect(() => decode(fractional)).toThrow()
})
