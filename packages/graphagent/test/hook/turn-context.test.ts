import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@opencode-ai/core/dag/store"
import { HookTurnContext } from "@/hook/turn-context"

test("Stop task context includes only current-session active work and bounds descriptions", async () => {
  const long = "x".repeat(1_017)
  const tasks = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* HookTurnContext.backgroundTasks("current", {
        jobs: yield* BackgroundJob.Service,
        workflows: yield* DagStore.Service,
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BackgroundJob.Service, {
            list: () =>
              Effect.succeed<BackgroundJob.Info[]>([
                {
                  id: "owned",
                  type: "bash",
                  status: "running",
                  started_at: 0,
                  title: long,
                  metadata: { sessionId: "current", command: long },
                },
                {
                  id: "child",
                  type: "task",
                  status: "running",
                  started_at: 0,
                  metadata: { parentSessionID: "current", agent: "review", command: "wrong kind" },
                },
                { id: "other", type: "bash", status: "running", started_at: 0, metadata: { sessionId: "other" } },
                { id: "done", type: "bash", status: "completed", started_at: 0, metadata: { sessionId: "current" } },
              ]),
          }),
          Layer.mock(DagStore.Service, {
            listBySession: () =>
              Effect.succeed<DagStore.WorkflowRow[]>([
                {
                  id: "workflow",
                  status: "running",
                  title: "Current workflow",
                  projectId: "project",
                  sessionId: "current",
                  directory: null,
                  config: "{}",
                  seq: 0,
                  wakeReported: false,
                  graphRev: 0,
                  startedAt: null,
                  completedAt: null,
                  timeCreated: 0,
                  timeUpdated: 0,
                },
                {
                  id: "done-workflow",
                  status: "completed",
                  title: "Finished workflow",
                  projectId: "project",
                  sessionId: "current",
                  directory: null,
                  config: "{}",
                  seq: 0,
                  wakeReported: false,
                  graphRev: 0,
                  startedAt: null,
                  completedAt: null,
                  timeCreated: 0,
                  timeUpdated: 0,
                },
              ]),
          }),
        ),
      ),
    ),
  )
  expect(tasks.map((task) => task.id)).toEqual(["owned", "child", "workflow"])
  expect(tasks[0]).toMatchObject({
    type: "shell",
    status: "running",
    description: `${"x".repeat(1_000)}… [+17 chars]`,
    command: `${"x".repeat(1_000)}… [+17 chars]`,
  })
  expect(tasks[1]).toMatchObject({ type: "subagent", agent_type: "review" })
  expect(tasks[1]).not.toHaveProperty("command")
  expect(tasks[2]).toMatchObject({ type: "workflow", name: "Current workflow" })
  expect(JSON.stringify(tasks)).not.toContain("other")
})

test("StopFailure classifies the raw cause but only sends an already displayed message", () => {
  const cause = { reason: { _tag: "RateLimit", message: "upstream secret", http: { response: { status: 429 } } } }
  expect(HookTurnContext.failure(cause)).toEqual({ error: "rate_limit" })
  expect(HookTurnContext.failure(cause, "Rate limit reached")).toEqual({
    error: "rate_limit",
    errorDetails: "Rate limit reached",
    lastAssistantMessage: "Rate limit reached",
  })
  expect(HookTurnContext.failure({ message: "model_not_found" }, "Shown model error").error).toBe("model_not_found")
})
