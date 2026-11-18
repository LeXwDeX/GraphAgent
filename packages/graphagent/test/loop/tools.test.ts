// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { Tool } from "ai"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { LoopAnalysisResult } from "@graphagent/schema/loop"
import { Schema } from "effect"
import { buildAgentTools } from "@/hook/agent-tools"
import { LoopFeedback } from "@/loop/feedback"
import { LoopTools } from "@/loop/tools"
import { LoopValidate } from "@/loop/validate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { intent, result } from "./fixture"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer))

const BASIS = new Set(["msg_human"])

/** The tool set of one analysis, with the real drift guard of a first analysis. */
const assemble = (cwd: string, spawner: ChildProcessSpawner["Service"], fs: FSUtil.Interface) => {
  const submission = LoopTools.submission()
  const outputs = new Map<string, string>()
  const tools = LoopTools.build({
    spawner,
    fs,
    cwd,
    signal: new AbortController().signal,
    submission,
    outputs,
    check: (submitted) => LoopValidate.check({ result: submitted, first: true, basisMessageIDs: BASIS }),
  })
  return { tools, submission, outputs }
}

const call = (tools: Record<string, Tool>, name: string, args: unknown, toolCallId = "call_1") =>
  Effect.promise(async () => {
    const value: unknown = await tools[name]?.execute?.(args, {
      toolCallId,
      messages: [],
      abortSignal: new AbortController().signal,
    })
    return { output: LoopTools.render(value) }
  })

/** What a model sends: the result as plain JSON, which drops the keys that are undefined. */
const submitted = (value: unknown): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  if (typeof parsed !== "object" || parsed === null) throw new Error("a result is an object")
  return Object.fromEntries(Object.entries(parsed))
}

describe("analysis tool set (#1328)", () => {
  it.instance("is exactly read_file, list_dir, grep, bash and submit_analysis", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      expect(Object.keys(tools).toSorted()).toEqual([...LoopTools.NAMES].toSorted())
      expect([...LoopTools.NAMES]).toEqual(["read_file", "list_dir", "grep", "bash", "submit_analysis"])
      // None of the hook agent's terminating tool, and nothing that can write, browse or ask.
      for (const forbidden of ["synthetic_output", "edit", "write", "webfetch", "task", "question"])
        expect(tools[forbidden]).toBeUndefined()
    }),
  )

  it.instance("every tool takes an object-rooted parameter schema", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      for (const [name, item] of Object.entries(tools)) {
        const schema: unknown = item.inputSchema
        const root =
          typeof schema === "object" && schema !== null && "jsonSchema" in schema ? schema.jsonSchema : undefined
        expect(root, name).toMatchObject({ type: "object" })
        expect(root, name).not.toHaveProperty("anyOf")
      }
    }),
  )

  it.instance("bash runs read-only inspection and rejects everything outside the whitelist", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)

      expect((yield* call(tools, "bash", { command: "pwd" })).output).toContain("exit=0")
      for (const command of [
        "rm -rf somewhere",
        "touch marker",
        "curl https://example.invalid",
        "node -e 1",
        "sed -i s/a/b/ file",
        "git push origin main",
        "git commit -m x",
        "cat file | sh",
        "echo hi > out",
        "ls; rm -rf x",
        "echo $(id)",
      ]) {
        const output = (yield* call(tools, "bash", { command })).output
        expect(output, command).toMatch(/^Error: /)
        expect(output, command).not.toContain("exit=")
      }
    }),
  )

  it.instance("read_file, list_dir and grep read the instance directory", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const filesystem = yield* FSUtil.Service
      yield* filesystem.writeFileString(`${directory}/notes.txt`, "alpha\nbeta needle\ngamma")
      const { tools } = assemble(directory, yield* ChildProcessSpawner, filesystem)

      expect((yield* call(tools, "read_file", { path: "notes.txt" })).output).toBe("alpha\nbeta needle\ngamma")
      expect((yield* call(tools, "list_dir", { path: "." })).output).toContain("notes.txt")
      expect((yield* call(tools, "grep", { pattern: "needle", path: "." })).output).toContain("notes.txt:2:beta needle")
    }),
  )

  it.instance("the hook agent keeps its tool set: the shared four plus synthetic_output", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const tools = buildAgentTools({
        spawner: yield* ChildProcessSpawner,
        fs: yield* FSUtil.Service,
        cwd: directory,
        signal: new AbortController().signal,
        captured: { value: null },
      })
      expect(Object.keys(tools).toSorted()).toEqual(["bash", "grep", "list_dir", "read_file", "synthetic_output"])
    }),
  )

  it.instance("every tool result is recorded by call id for the next request", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, outputs } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      yield* call(tools, "bash", { command: "pwd" }, "call_pwd")
      yield* call(tools, "bash", { command: "rm -rf x" }, "call_bad")
      expect(outputs.get("call_pwd")).toContain("exit=0")
      expect(outputs.get("call_bad")).toMatch(/^Error: /)
    }),
  )
})

describe("submit_analysis (#1328)", () => {
  it.instance("accepts a result that passes the drift guard and stores it once", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)

      const first = yield* call(tools, "submit_analysis", submitted(result()))
      expect(first.output).toBe(LoopFeedback.ACCEPTED)
      expect(submission.accepted).toEqual(result())
      expect(submission.rejected).toBe(0)

      // A second call changes nothing, even with a different result.
      const second = yield* call(tools, "submit_analysis", submitted(result({ reason: "A different reason." })))
      expect(second.output).toBe(LoopFeedback.ALREADY_ACCEPTED)
      expect(submission.accepted?.reason).toBe("Two acceptance items are still unmet.")
    }),
  )

  it.instance("returns the violated rules, counts the attempt and stores nothing", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      // First analysis with an empty acceptance list (V1) and a continue verdict without a prompt (V5).
      const bad = result({ intent: intent({ acceptance: [] }), next_prompt: undefined })

      const output = (yield* call(tools, "submit_analysis", submitted(bad))).output
      expect(output).toContain("NOT accepted")
      expect(output).toContain("Attempt 1 of 3; 2 left")
      expect(output).toContain("[V1]")
      expect(output).toContain("[V5]")
      expect(submission.accepted).toBeUndefined()
      expect(submission.rejected).toBe(1)
      expect(submission.last?.violations.map((violation) => violation.rule)).toEqual(["V1", "V5"])

      const again = (yield* call(tools, "submit_analysis", submitted(bad))).output
      expect(again).toContain("Attempt 2 of 3; 1 left")
      expect(submission.rejected).toBe(2)
    }),
  )

  it.instance("drops explicit nulls on optional fields before decoding", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      const withNulls = {
        ...submitted(
          result({
            verdict: "done",
            intent: intent({ acceptance: [{ id: "A1", text: "t", status: "met", evidence: "e" }] }),
            next_prompt: undefined,
          }),
        ),
        next_prompt: null,
        intent_change: { changed: false, basis_message_id: null, summary: null },
      }

      expect((yield* call(tools, "submit_analysis", withNulls)).output).toBe(LoopFeedback.ACCEPTED)
      expect(submission.accepted?.next_prompt).toBeUndefined()
      expect(submission.accepted?.intent_change).toEqual({ changed: false })
    }),
  )

  it.instance("a null on a required field is reported as missing", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)

      const output = (yield* call(tools, "submit_analysis", { ...submitted(result()), reason: null })).output
      expect(output).toContain("do not match the schema")
      expect(output).toContain('["reason"] missing required field')
      expect(submission.rejected).toBe(1)
      expect(submission.accepted).toBeUndefined()
    }),
  )

  it.instance("parses nested objects and arrays that arrive as JSON strings", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      const plain = submitted(result())
      const stringified = {
        ...plain,
        intent: JSON.stringify({ ...result().intent, acceptance: JSON.stringify(result().intent.acceptance) }),
        progress: JSON.stringify(plain.progress),
      }

      expect((yield* call(tools, "submit_analysis", stringified)).output).toBe(LoopFeedback.ACCEPTED)
      expect(submission.accepted).toEqual(result())
    }),
  )

  it.instance("malformed arguments name the failing paths, never their values, and count as an attempt", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)

      const output = (yield* call(tools, "submit_analysis", { verdict: "paused", intent: "secret-value", reason: 7 }))
        .output
      expect(output).toContain("Attempt 1 of 3")
      expect(output).toContain('["verdict"]')
      expect(output).not.toContain("secret-value")
      expect(submission.rejected).toBe(1)
      expect(submission.last?.violations).toEqual([])
    }),
  )

  test("the schema and the tool parameters stay in step", () => {
    // The tool's JSON Schema comes from the result schema; a decode of a valid result needs no repair.
    expect(Schema.decodeUnknownSync(LoopAnalysisResult)(result())).toEqual(result())
    expect(LoopTools.decode(submitted(result()))).toEqual({ ok: true, value: result() })
  })
})

/** The calls of one response: they all start together, as the SDK runs them, and each answers on its own. */
const callAll = (tools: Record<string, Tool>, calls: ReadonlyArray<{ id: string; args: unknown }>) =>
  Effect.promise(() =>
    Promise.all(
      calls.map(async (item) => {
        const value: unknown = await tools.submit_analysis?.execute?.(item.args, {
          toolCallId: item.id,
          messages: [],
          abortSignal: new AbortController().signal,
        })
        return { output: LoopTools.render(value) }
      }),
    ),
  )

// Several submissions can arrive in one response and every one of them runs. The cap on attempts and the
// "first accepted stands" rule are therefore enforced by the tool itself, not left to the driver.
describe("submit_analysis attempt cap (#1328)", () => {
  const bad = () => submitted(result({ intent: intent({ acceptance: [] }) }))

  it.instance("refuses a valid submission that follows the last attempt in the same response", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      yield* call(tools, "submit_analysis", bad(), "call_1")
      yield* call(tools, "submit_analysis", bad(), "call_2")
      expect(submission.rejected).toBe(2)

      // The third attempt is rejected; the valid one right behind it would be a fourth.
      const [third, fourth] = yield* callAll(tools, [
        { id: "call_3", args: bad() },
        { id: "call_4", args: submitted(result()) },
      ])

      expect(third?.output).toContain("Attempt 3 of 3; no attempts are left")
      expect(fourth?.output).toBe(LoopFeedback.EXHAUSTED)
      expect(fourth?.output).toContain("Attempts exhausted")
      expect(submission.accepted).toBeUndefined()
      expect(LoopTools.exhausted(submission)).toBe(true)
      // Nothing past the cap counts as another attempt, and what the model last read is still the third.
      expect(submission.rejected).toBe(3)
      expect(submission.last?.text).toContain("Attempt 3 of 3")
    }),
  )

  it.instance("refuses everything once the attempts are used, valid or not, without decoding it", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      for (const id of ["call_1", "call_2", "call_3"]) yield* call(tools, "submit_analysis", bad(), id)
      const last = submission.last

      const outputs = yield* callAll(tools, [
        { id: "call_4", args: submitted(result()) },
        { id: "call_5", args: bad() },
        { id: "call_6", args: "not even an object" },
      ])

      expect(outputs.map((item) => item.output)).toEqual([
        LoopFeedback.EXHAUSTED,
        LoopFeedback.EXHAUSTED,
        LoopFeedback.EXHAUSTED,
      ])
      expect(submission.accepted).toBeUndefined()
      expect(submission.rejected).toBe(3)
      expect(submission.last).toBe(last)
    }),
  )

  it.instance("the third attempt may still be the one that is accepted", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      yield* call(tools, "submit_analysis", bad(), "call_1")
      yield* call(tools, "submit_analysis", bad(), "call_2")

      expect((yield* call(tools, "submit_analysis", submitted(result()), "call_3")).output).toBe(LoopFeedback.ACCEPTED)

      expect(submission.accepted).toEqual(result())
      expect(submission.rejected).toBe(2)
      expect(LoopTools.exhausted(submission)).toBe(false)
    }),
  )

  it.instance("two valid submissions in one response: the first stands, the second never replaces it", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      const first = result({ reason: "The first analysis." })
      const second = result({ reason: "A second, different analysis." })

      const [one, two] = yield* callAll(tools, [
        { id: "call_1", args: submitted(first) },
        { id: "call_2", args: submitted(second) },
      ])

      expect(one?.output).toBe(LoopFeedback.ACCEPTED)
      expect(two?.output).toBe(LoopFeedback.ALREADY_ACCEPTED)
      expect(submission.accepted).toEqual(first)
      expect(submission.rejected).toBe(0)
    }),
  )

  it.instance("a submission after an accepted one is not an attempt, even with the cap in sight", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { tools, submission } = assemble(directory, yield* ChildProcessSpawner, yield* FSUtil.Service)
      yield* call(tools, "submit_analysis", bad(), "call_1")
      yield* call(tools, "submit_analysis", bad(), "call_2")

      const [accepted, ...later] = yield* callAll(tools, [
        { id: "call_3", args: submitted(result()) },
        { id: "call_4", args: bad() },
        { id: "call_5", args: bad() },
      ])

      expect(accepted?.output).toBe(LoopFeedback.ACCEPTED)
      expect(later.map((item) => item.output)).toEqual([LoopFeedback.ALREADY_ACCEPTED, LoopFeedback.ALREADY_ACCEPTED])
      expect(submission.accepted).toEqual(result())
      expect(submission.rejected).toBe(2)
    }),
  )

  test("reject stops counting at the cap and keeps the last real rejection", () => {
    const state = LoopTools.submission()
    const texts = [1, 2, 3].map(() => LoopTools.reject(state, (attempt) => `rejected ${attempt}`))
    expect(texts).toEqual(["rejected 1", "rejected 2", "rejected 3"])
    expect(state.rejected).toBe(3)

    // A stop without a submission, or an unparsable one the driver finds afterwards, comes through here too.
    expect(LoopTools.reject(state, (attempt) => `rejected ${attempt}`)).toBe(LoopFeedback.EXHAUSTED)
    expect(LoopTools.reject(state, LoopFeedback.unsubmitted)).toBe(LoopFeedback.EXHAUSTED)
    expect(state.rejected).toBe(3)
    expect(state.last?.text).toBe("rejected 3")
  })
})
