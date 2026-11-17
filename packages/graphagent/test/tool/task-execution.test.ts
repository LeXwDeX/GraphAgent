// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"
import { TaskExecution } from "@/tool/task-execution"

// Rulesets as the agent catalog hands them over: everything allowed, and the two
// tools that reach the user denied unless an agent names them in its own rules.
const quiet = Permission.fromConfig({ "*": "allow", question: "deny", plan_exit: "deny" })
const asking = Permission.fromConfig({ "*": "allow", question: "allow", plan_exit: "deny" })
const planning = Permission.fromConfig({ "*": "allow", question: "deny", plan_exit: "allow" })
// A user's blanket allow comes after the defaults and so wins the last-match rule for every tool, these two included.
const blanket = [...quiet, ...Permission.fromConfig({ "*": "allow" })]

type Layer = "foreground" | "background" | "auto" | undefined

function agent(name: string, input: { permission?: typeof quiet; execution?: Layer } = {}) {
  return {
    name,
    permission: input.permission ?? quiet,
    ...(input.execution === undefined ? {} : { execution: input.execution }),
  }
}

function resolved(input: Parameters<typeof TaskExecution.resolve>[0]) {
  const result = TaskExecution.resolve(input)
  if (result.type !== "resolved") throw new Error(`expected the call to resolve, it was refused: ${result.message}`)
  return { mode: result.mode, source: result.source }
}

describe("TaskExecution.resolve priority", () => {
  test("runs in the foreground when nothing declares anything", () => {
    expect(resolved({ agent: agent("worker") })).toEqual({ mode: "foreground", source: "default" })
  })

  test("an agent's declaration decides when neither the call nor a command speaks", () => {
    expect(resolved({ agent: agent("worker", { execution: "background" }) })).toEqual({
      mode: "background",
      source: "agent",
    })
    expect(resolved({ agent: agent("worker", { execution: "foreground" }) })).toEqual({
      mode: "foreground",
      source: "agent",
    })
  })

  test("a command's declaration outranks the agent's", () => {
    expect(resolved({ agent: agent("worker", { execution: "foreground" }), command: "background" })).toEqual({
      mode: "background",
      source: "command",
    })
    expect(resolved({ agent: agent("worker", { execution: "background" }), command: "foreground" })).toEqual({
      mode: "foreground",
      source: "command",
    })
  })

  test("the call's background argument outranks the command and the agent", () => {
    expect(
      resolved({ agent: agent("worker", { execution: "foreground" }), command: "foreground", param: true }),
    ).toEqual({ mode: "background", source: "param" })
    expect(
      resolved({ agent: agent("worker", { execution: "background" }), command: "background", param: false }),
    ).toEqual({ mode: "foreground", source: "param" })
  })

  test("an agent that runs in the background by default still waits for background=false", () => {
    expect(resolved({ agent: agent("review", { execution: "background" }), param: false })).toEqual({
      mode: "foreground",
      source: "param",
    })
  })

  test("auto declares nothing: the layer is skipped, not decided", () => {
    expect(resolved({ agent: agent("worker", { execution: "background" }), command: "auto" })).toEqual({
      mode: "background",
      source: "agent",
    })
    expect(resolved({ agent: agent("worker", { execution: "auto" }), command: "background" })).toEqual({
      mode: "background",
      source: "command",
    })
    expect(resolved({ agent: agent("worker", { execution: "auto" }), command: "auto" })).toEqual({
      mode: "foreground",
      source: "default",
    })
  })

  // Every combination of the three layers, against the rule written out once: the first layer that names a
  // mode decides, in the order call argument, command, agent; none names one, so the call runs in the foreground.
  test("the first layer that names a mode decides, for every combination", () => {
    const declarations: Layer[] = [undefined, "auto", "foreground", "background"]
    const params = [undefined, true, false] as const
    for (const param of params) {
      for (const command of declarations) {
        for (const declared of declarations) {
          const expected: { mode: TaskExecution.Mode; source: TaskExecution.Source } =
            param !== undefined
              ? { mode: param ? "background" : "foreground", source: "param" }
              : command === "foreground" || command === "background"
                ? { mode: command, source: "command" }
                : declared === "foreground" || declared === "background"
                  ? { mode: declared, source: "agent" }
                  : { mode: "foreground", source: "default" }
          expect(resolved({ agent: agent("worker", { execution: declared }), param, command })).toEqual(expected)
        }
      }
    }
  })
})

describe("TaskExecution hard constraints", () => {
  test("F-1: an agent whose rules name question or plan_exit and allow it is constrained", () => {
    expect(TaskExecution.constraintOf(agent("asker", { permission: asking }))?.id).toBe("F-1")
    expect(TaskExecution.constraintOf(agent("planner", { permission: planning }))?.id).toBe("F-1")
    expect(TaskExecution.constraintOf(agent("quiet"))).toBeUndefined()
  })

  test("F-1: a blanket allow is not an opt-in, and a later deny takes the opt-in back", () => {
    expect(TaskExecution.constraintOf(agent("open", { permission: blanket }))).toBeUndefined()
    const revoked = [...asking, ...Permission.fromConfig({ question: "deny" })]
    expect(TaskExecution.constraintOf(agent("revoked", { permission: revoked }))).toBeUndefined()
    const reopened = [...blanket, ...Permission.fromConfig({ question: "allow" })]
    expect(TaskExecution.constraintOf(agent("reopened", { permission: reopened }))?.id).toBe("F-1")
  })

  test("F-2: the compaction agent rewrites the shared context and is constrained", () => {
    expect(TaskExecution.constraintOf(agent("compaction"))?.id).toBe("F-2")
  })

  test("an explicit background=true on a constrained agent is refused with the rule and the way out", () => {
    const result = TaskExecution.resolve({ agent: agent("asker", { permission: asking }), param: true })
    if (result.type !== "refused") throw new Error("expected the call to be refused")
    expect(result.constraint.id).toBe("F-1")
    expect(result.message).toContain('"asker"')
    expect(result.message).toContain("F-1")
    expect(result.message).toContain("question or plan_exit")
    // What to do instead: leave the argument out or pass false.
    expect(result.message).toContain("foreground")
    expect(result.message).toContain("background=false")
  })

  test("the refusal names F-2 for the compaction agent", () => {
    const result = TaskExecution.resolve({ agent: agent("compaction"), param: true })
    if (result.type !== "refused") throw new Error("expected the call to be refused")
    expect(result.constraint.id).toBe("F-2")
    expect(result.message).toContain("F-2")
  })

  test("background=false and an absent argument are never refused", () => {
    const asker = agent("asker", { permission: asking })
    expect(resolved({ agent: asker, param: false })).toEqual({ mode: "foreground", source: "param" })
    expect(resolved({ agent: asker })).toEqual({ mode: "foreground", source: "default" })
  })

  test("a declaration cannot outrank a constraint: it resolves to the foreground and says so", () => {
    const asker = (execution: Layer) => agent("asker", { permission: asking, execution })
    expect(resolved({ agent: asker("background") })).toEqual({ mode: "foreground", source: "constraint" })
    expect(resolved({ agent: asker("auto"), command: "background" })).toEqual({
      mode: "foreground",
      source: "constraint",
    })
  })

  test("the source names the constraint only when it changed the outcome", () => {
    const asker = agent("asker", { permission: asking, execution: "foreground" })
    expect(resolved({ agent: asker })).toEqual({ mode: "foreground", source: "agent" })
    expect(resolved({ agent: asker, command: "foreground" })).toEqual({ mode: "foreground", source: "command" })
  })

  test("the constraint beats the argument even when a command or the agent also asks for the background", () => {
    const asker = agent("asker", { permission: asking, execution: "background" })
    const result = TaskExecution.resolve({ agent: asker, command: "background", param: true })
    expect(result.type).toBe("refused")
  })
})

// A non-interactive turn (`opencode run`, a hook followup) has no user waiting for a later message, so no call in it
// runs in the background, whoever asked for it. That is the #1057 rule for commands, applied to every task call.
describe("TaskExecution in a non-interactive turn", () => {
  const quietly = { noninteractive: true } as const

  test("whatever asks for the background is run in the foreground, and the source says why", () => {
    const foregrounded: { mode: TaskExecution.Mode; source: TaskExecution.Source } = {
      mode: "foreground",
      source: "noninteractive",
    }
    expect(resolved({ agent: agent("worker"), param: true, ...quietly })).toEqual(foregrounded)
    expect(resolved({ agent: agent("worker"), command: "background", ...quietly })).toEqual(foregrounded)
    expect(resolved({ agent: agent("review", { execution: "background" }), ...quietly })).toEqual(foregrounded)
  })

  test("a call that asked for nothing, or for the foreground, reports the layer that spoke", () => {
    expect(resolved({ agent: agent("worker"), ...quietly })).toEqual({ mode: "foreground", source: "default" })
    expect(resolved({ agent: agent("worker"), param: false, ...quietly })).toEqual({
      mode: "foreground",
      source: "param",
    })
    expect(resolved({ agent: agent("worker", { execution: "foreground" }), ...quietly })).toEqual({
      mode: "foreground",
      source: "agent",
    })
  })

  test("an explicit request is not refused for a constrained agent: the call is satisfiable in the foreground", () => {
    const asker = agent("asker", { permission: asking })
    expect(resolved({ agent: asker, param: true, ...quietly })).toEqual({
      mode: "foreground",
      source: "noninteractive",
    })
    const declared = agent("asker", { permission: asking, execution: "background" })
    expect(resolved({ agent: declared, ...quietly })).toEqual({ mode: "foreground", source: "noninteractive" })
  })

  test("an interactive turn is untouched by the flag being absent or false", () => {
    const review = agent("review", { execution: "background" })
    expect(resolved({ agent: review })).toEqual({ mode: "background", source: "agent" })
    expect(resolved({ agent: review, noninteractive: false })).toEqual({ mode: "background", source: "agent" })
    expect(resolved({ agent: review, param: true, noninteractive: false })).toEqual({
      mode: "background",
      source: "param",
    })
  })

  // The same combinations as the priority matrix, with the turn non-interactive: what would have run in the background
  // runs in the foreground with the source `noninteractive`, and everything else is as it was.
  test("for every combination, only the background becomes the foreground", () => {
    const declarations: Layer[] = [undefined, "auto", "foreground", "background"]
    for (const param of [undefined, true, false] as const) {
      for (const command of declarations) {
        for (const declared of declarations) {
          const input = { agent: agent("worker", { execution: declared }), param, command }
          const interactive = resolved(input)
          const expected: { mode: TaskExecution.Mode; source: TaskExecution.Source } =
            interactive.mode === "background" ? { mode: "foreground", source: "noninteractive" } : interactive
          expect(resolved({ ...input, ...quietly })).toEqual(expected)
        }
      }
    }
  })
})

describe("TaskExecution metadata record", () => {
  test("record writes the decision under the two metadata fields and recorded reads it back", () => {
    const fields = TaskExecution.record({ mode: "background", source: "agent" })
    expect(fields).toEqual({ execution: "background", executionSource: "agent" })
    expect(TaskExecution.recorded({ ...fields, background: true, initiator: "agent" })).toEqual({
      mode: "background",
      source: "agent",
    })
  })

  test("recorded answers nothing for metadata that holds no complete, valid decision", () => {
    expect(TaskExecution.recorded(undefined)).toBeUndefined()
    expect(TaskExecution.recorded(null)).toBeUndefined()
    expect(TaskExecution.recorded("background")).toBeUndefined()
    expect(TaskExecution.recorded({})).toBeUndefined()
    expect(TaskExecution.recorded({ background: true })).toBeUndefined()
    expect(TaskExecution.recorded({ execution: "background" })).toBeUndefined()
    expect(TaskExecution.recorded({ execution: "auto", executionSource: "agent" })).toBeUndefined()
    expect(TaskExecution.recorded({ execution: "background", executionSource: "elsewhere" })).toBeUndefined()
  })

  test("every source the resolver can report is one recorded accepts", () => {
    const seen = new Set<string>()
    const cases = [
      resolved({ agent: agent("a") }),
      resolved({ agent: agent("a"), param: true }),
      resolved({ agent: agent("a"), command: "background" }),
      resolved({ agent: agent("a", { execution: "background" }) }),
      resolved({ agent: agent("a", { permission: asking, execution: "background" }) }),
      resolved({ agent: agent("a"), param: true, noninteractive: true }),
    ]
    for (const decision of cases) {
      seen.add(decision.source)
      expect(TaskExecution.recorded(TaskExecution.record(decision))).toEqual(decision)
    }
    expect([...seen].toSorted()).toEqual(["agent", "command", "constraint", "default", "noninteractive", "param"])
  })
})
