import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TaskSubagents } from "@/hook/task-subagents"

describe("TaskSubagents registry", () => {
  test("a clean child exit delegates Stop only while a foreground task call is registered", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(TaskSubagents.delegateStop("ses_task_unregistered")).toBe(false)
        const registration = yield* TaskSubagents.register("ses_task_registered")
        expect(yield* registration.stopDelegated).toBe(false)
        expect(TaskSubagents.delegateStop("ses_task_registered")).toBe(true)
        expect(yield* registration.stopDelegated).toBe(true)
        yield* registration.release
        // The delegation is remembered after release, so a promoted task can deliver SubagentStop.
        expect(yield* registration.stopDelegated).toBe(true)
        expect(TaskSubagents.delegateStop("ses_task_registered")).toBe(false)
      }),
    ))

  test("released before the child exits: the child keeps its own Stop and nothing is delegated", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registration = yield* TaskSubagents.register("ses_task_promoted_early")
        yield* registration.release
        yield* registration.release
        expect(TaskSubagents.delegateStop("ses_task_promoted_early")).toBe(false)
        expect(yield* registration.stopDelegated).toBe(false)
      }),
    ))

  test("overlapping registrations keep the session registered until the last release", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* TaskSubagents.register("ses_task_overlap")
        const second = yield* TaskSubagents.register("ses_task_overlap")
        yield* first.release
        expect(TaskSubagents.delegateStop("ses_task_overlap")).toBe(true)
        yield* second.release
        expect(TaskSubagents.delegateStop("ses_task_overlap")).toBe(false)
      }),
    ))
})
