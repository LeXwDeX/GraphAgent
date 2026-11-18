// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { SessionID } from "../../src/session/schema"
import {
  counters,
  digestValue,
  explainFingerprintChange,
  explainSectionChange,
  fingerprintOf,
  recordGitSpawn,
  recordStep,
  StepMetricsRing,
  SYSTEM_SECTIONS,
  VOLATILE_SYSTEM_SECTIONS,
  type StepMetrics,
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
